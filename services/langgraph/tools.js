/**
 * LangGraph Tool Definitions
 * Defines all tools using Zod schemas for structured output
 */

const { z } = require("zod");
const { DynamicStructuredTool } = require("@langchain/core/tools");
const Product = require("../../models/Product");
const { uploadToCloudinary, deleteFromCloudinary, getPublicIdFromUrl } = require("../../config/cloudinary");

// ============ Zod Schemas ============

const CreateProductSchema = z.object({
    name: z.string().describe("The product name"),
    price: z.number().min(1).describe("Price in PKR (minimum 1)"),
    category: z.enum(['rackets', 'shoes', 'accessories', 'apparel', 'bags', 'shuttles']).describe("Product category"),
    stock: z.number().int().min(0).optional().default(1).describe("Stock quantity"),
    brand: z.string().optional().default("").describe("Brand name"),
    description: z.string().optional().default("").describe("Product description"),
    condition: z.enum(['new', 'used']).optional().default('new').describe("Product condition"),
});

const UpdateProductSchema = z.object({
    searchName: z.string().describe("Name of the product to find and update"),
    newPrice: z.number().min(1).optional().describe("New price in PKR (minimum 1)"),
    newStock: z.number().int().min(0).optional().describe("New stock quantity"),
    newDescription: z.string().optional().describe("New description"),
    newCondition: z.enum(['new', 'used']).optional().describe("New condition"),
});

const DeleteProductSchema = z.object({
    productName: z.string().describe("Name of the product to delete"),
});

const ListProductsSchema = z.object({
    category: z.enum(['rackets', 'shoes', 'accessories', 'apparel', 'bags', 'shuttles']).optional().describe("Filter by category"),
    limit: z.number().int().min(1).max(20).optional().default(15).describe("Maximum products to return (1-20)"),
});

const ProductMediaSchema = z.object({
    productName: z.string().describe("Name of the product"),
});

const DeleteImageSchema = z.object({
    productName: z.string().describe("Name of the product"),
    imageNumber: z.number().int().min(1).max(5).describe("Image number to delete (1-5)"),
});

// ============ Tool Factory Functions ============

/**
 * Create product tool
 * @param {string} sellerId - The seller's MongoDB ID
 */
function createProductTool(sellerId) {
    return new DynamicStructuredTool({
        name: "create_product",
        description: "Create a new product in the inventory. Requires name, price, and category at minimum.",
        schema: CreateProductSchema,
        func: async (input) => {
            try {
                const productData = {
                    ...input,
                    seller: sellerId,
                    images: [],
                    description: input.description || `${input.name} - Quality badminton equipment`,
                };
                
                const newProduct = new Product(productData);
                await newProduct.save();
                
                return JSON.stringify({
                    success: true,
                    product: {
                        id: newProduct._id.toString(),
                        name: newProduct.name,
                        price: newProduct.price,
                        category: newProduct.category,
                        stock: newProduct.stock,
                        brand: newProduct.brand,
                        condition: newProduct.condition,
                    },
                    message: `Product "${newProduct.name}" created successfully!`
                });
            } catch (error) {
                return JSON.stringify({
                    success: false,
                    error: error.message
                });
            }
        },
    });
}

/**
 * Update product tool
 */
function updateProductTool(sellerId) {
    return new DynamicStructuredTool({
        name: "update_product",
        description: "Update an existing product. Specify the product name and the fields to change.",
        schema: UpdateProductSchema,
        func: async (input) => {
            try {
                const product = await Product.findOne({
                    seller: sellerId,
                    name: { $regex: input.searchName, $options: 'i' }
                });
                
                if (!product) {
                    return JSON.stringify({
                        success: false,
                        error: `Product "${input.searchName}" not found`
                    });
                }
                
                const updates = [];
                if (input.newPrice !== undefined) {
                    product.price = input.newPrice;
                    updates.push(`Price: PKR ${input.newPrice}`);
                }
                if (input.newStock !== undefined) {
                    product.stock = input.newStock;
                    updates.push(`Stock: ${input.newStock}`);
                }
                if (input.newDescription) {
                    product.description = input.newDescription;
                    updates.push("Description updated");
                }
                if (input.newCondition) {
                    product.condition = input.newCondition;
                    updates.push(`Condition: ${input.newCondition}`);
                }
                
                if (updates.length === 0) {
                    return JSON.stringify({
                        success: false,
                        error: "No changes specified"
                    });
                }
                
                await product.save();
                
                return JSON.stringify({
                    success: true,
                    product: {
                        name: product.name,
                        price: product.price,
                        stock: product.stock,
                    },
                    updates,
                    message: `Product "${product.name}" updated!`
                });
            } catch (error) {
                return JSON.stringify({
                    success: false,
                    error: error.message
                });
            }
        },
    });
}

/**
 * Delete product tool
 */
function deleteProductTool(sellerId) {
    return new DynamicStructuredTool({
        name: "delete_product",
        description: "Permanently delete a product from inventory.",
        schema: DeleteProductSchema,
        func: async (input) => {
            try {
                const deleted = await Product.findOneAndDelete({
                    seller: sellerId,
                    name: { $regex: input.productName, $options: 'i' }
                });
                
                if (!deleted) {
                    return JSON.stringify({
                        success: false,
                        error: `Product "${input.productName}" not found`
                    });
                }
                
                // Clean up Cloudinary images
                if (deleted.images && deleted.images.length > 0) {
                    for (const imgUrl of deleted.images) {
                        const publicId = getPublicIdFromUrl(imgUrl);
                        if (publicId) {
                            await deleteFromCloudinary(publicId, 'image').catch(() => {});
                        }
                    }
                }
                
                // Clean up video
                if (deleted.video && deleted.video.publicId) {
                    await deleteFromCloudinary(deleted.video.publicId, 'video').catch(() => {});
                }
                
                return JSON.stringify({
                    success: true,
                    message: `Product "${deleted.name}" has been deleted.`
                });
            } catch (error) {
                return JSON.stringify({
                    success: false,
                    error: error.message
                });
            }
        },
    });
}

/**
 * List products tool
 */
function listProductsTool(sellerId) {
    return new DynamicStructuredTool({
        name: "list_products",
        description: "List products in inventory. Optionally filter by category.",
        schema: ListProductsSchema,
        func: async (input) => {
            try {
                const query = { seller: sellerId };
                if (input.category) {
                    query.category = input.category;
                }
                
                const products = await Product.find(query)
                    .limit(input.limit || 15)
                    .sort({ createdAt: -1 })
                    .select('name price stock category condition');
                
                return JSON.stringify({
                    success: true,
                    count: products.length,
                    category: input.category || 'all',
                    products: products.map(p => ({
                        name: p.name,
                        price: p.price,
                        stock: p.stock,
                        category: p.category,
                        condition: p.condition,
                    }))
                });
            } catch (error) {
                return JSON.stringify({
                    success: false,
                    error: error.message
                });
            }
        },
    });
}

/**
 * View product media tool
 */
function viewProductMediaTool(sellerId) {
    return new DynamicStructuredTool({
        name: "view_product_media",
        description: "View images and video attached to a product.",
        schema: ProductMediaSchema,
        func: async (input) => {
            try {
                const product = await Product.findOne({
                    seller: sellerId,
                    name: { $regex: input.productName, $options: 'i' }
                }).select('name images video');
                
                if (!product) {
                    return JSON.stringify({
                        success: false,
                        error: `Product "${input.productName}" not found`
                    });
                }
                
                return JSON.stringify({
                    success: true,
                    product: product.name,
                    imageCount: product.images?.length || 0,
                    maxImages: 5,
                    hasVideo: !!(product.video && product.video.url),
                });
            } catch (error) {
                return JSON.stringify({
                    success: false,
                    error: error.message
                });
            }
        },
    });
}

/**
 * Prepare to add images (returns product info for image upload)
 */
function addProductImagesTool(sellerId) {
    return new DynamicStructuredTool({
        name: "add_product_images",
        description: "Prepare to add images to a product. User will then send photos.",
        schema: ProductMediaSchema,
        func: async (input) => {
            try {
                const product = await Product.findOne({
                    seller: sellerId,
                    name: { $regex: input.productName, $options: 'i' }
                }).select('name images');
                
                if (!product) {
                    return JSON.stringify({
                        success: false,
                        error: `Product "${input.productName}" not found`
                    });
                }
                
                const currentCount = product.images?.length || 0;
                const maxImages = 5;
                
                if (currentCount >= maxImages) {
                    return JSON.stringify({
                        success: false,
                        error: `Product already has ${maxImages} images (maximum). Delete some first.`
                    });
                }
                
                return JSON.stringify({
                    success: true,
                    action: 'AWAIT_IMAGES',
                    productId: product._id.toString(),
                    productName: product.name,
                    currentImages: currentCount,
                    remainingSlots: maxImages - currentCount,
                });
            } catch (error) {
                return JSON.stringify({
                    success: false,
                    error: error.message
                });
            }
        },
    });
}

/**
 * Add product video tool
 */
function addProductVideoTool(sellerId) {
    return new DynamicStructuredTool({
        name: "add_product_video",
        description: "Prepare to add or replace video on a product. User will then send video.",
        schema: ProductMediaSchema,
        func: async (input) => {
            try {
                const product = await Product.findOne({
                    seller: sellerId,
                    name: { $regex: input.productName, $options: 'i' }
                }).select('name video');
                
                if (!product) {
                    return JSON.stringify({
                        success: false,
                        error: `Product "${input.productName}" not found`
                    });
                }
                
                return JSON.stringify({
                    success: true,
                    action: 'AWAIT_VIDEO',
                    productId: product._id.toString(),
                    productName: product.name,
                    hasExistingVideo: !!(product.video && product.video.url),
                });
            } catch (error) {
                return JSON.stringify({
                    success: false,
                    error: error.message
                });
            }
        },
    });
}

/**
 * Delete specific image tool
 */
function deleteProductImageTool(sellerId) {
    return new DynamicStructuredTool({
        name: "delete_product_image",
        description: "Delete a specific image from a product by image number (1-5).",
        schema: DeleteImageSchema,
        func: async (input) => {
            try {
                const product = await Product.findOne({
                    seller: sellerId,
                    name: { $regex: input.productName, $options: 'i' }
                });
                
                if (!product) {
                    return JSON.stringify({
                        success: false,
                        error: `Product "${input.productName}" not found`
                    });
                }
                
                if (!product.images || product.images.length === 0) {
                    return JSON.stringify({
                        success: false,
                        error: "Product has no images"
                    });
                }
                
                const imgIndex = input.imageNumber - 1;
                if (imgIndex < 0 || imgIndex >= product.images.length) {
                    return JSON.stringify({
                        success: false,
                        error: `Invalid image number. Product has ${product.images.length} image(s).`
                    });
                }
                
                // Delete from Cloudinary
                const imgUrl = product.images[imgIndex];
                const publicId = getPublicIdFromUrl(imgUrl);
                if (publicId) {
                    await deleteFromCloudinary(publicId, 'image').catch(() => {});
                }
                
                product.images.splice(imgIndex, 1);
                await product.save();
                
                return JSON.stringify({
                    success: true,
                    message: `Image #${input.imageNumber} deleted from "${product.name}"`,
                    remainingImages: product.images.length,
                });
            } catch (error) {
                return JSON.stringify({
                    success: false,
                    error: error.message
                });
            }
        },
    });
}

/**
 * Delete all images tool
 */
function deleteAllProductImagesTool(sellerId) {
    return new DynamicStructuredTool({
        name: "delete_all_product_images",
        description: "Delete all images from a product.",
        schema: ProductMediaSchema,
        func: async (input) => {
            try {
                const product = await Product.findOne({
                    seller: sellerId,
                    name: { $regex: input.productName, $options: 'i' }
                });
                
                if (!product) {
                    return JSON.stringify({
                        success: false,
                        error: `Product "${input.productName}" not found`
                    });
                }
                
                if (!product.images || product.images.length === 0) {
                    return JSON.stringify({
                        success: false,
                        error: "Product has no images to delete"
                    });
                }
                
                const imageCount = product.images.length;
                
                // Delete all from Cloudinary
                for (const imgUrl of product.images) {
                    const publicId = getPublicIdFromUrl(imgUrl);
                    if (publicId) {
                        await deleteFromCloudinary(publicId, 'image').catch(() => {});
                    }
                }
                
                product.images = [];
                await product.save();
                
                return JSON.stringify({
                    success: true,
                    message: `All ${imageCount} image(s) deleted from "${product.name}"`,
                });
            } catch (error) {
                return JSON.stringify({
                    success: false,
                    error: error.message
                });
            }
        },
    });
}

/**
 * Delete product video tool
 */
function deleteProductVideoTool(sellerId) {
    return new DynamicStructuredTool({
        name: "delete_product_video",
        description: "Delete the video from a product.",
        schema: ProductMediaSchema,
        func: async (input) => {
            try {
                const product = await Product.findOne({
                    seller: sellerId,
                    name: { $regex: input.productName, $options: 'i' }
                });
                
                if (!product) {
                    return JSON.stringify({
                        success: false,
                        error: `Product "${input.productName}" not found`
                    });
                }
                
                if (!product.video || !product.video.url) {
                    return JSON.stringify({
                        success: false,
                        error: "Product has no video to delete"
                    });
                }
                
                // Delete from Cloudinary
                if (product.video.publicId) {
                    await deleteFromCloudinary(product.video.publicId, 'video').catch(() => {});
                }
                
                product.video = null;
                await product.save();
                
                return JSON.stringify({
                    success: true,
                    message: `Video deleted from "${product.name}"`,
                });
            } catch (error) {
                return JSON.stringify({
                    success: false,
                    error: error.message
                });
            }
        },
    });
}

/**
 * Show help tool
 */
const showHelpTool = new DynamicStructuredTool({
    name: "show_help",
    description: "Show available commands and help when user asks for help, guidance, or what you can do.",
    schema: z.object({}),
    func: async () => {
        return JSON.stringify({
            success: true,
            action: 'SHOW_HELP',
        });
    },
});

/**
 * Show status tool
 */
const showStatusTool = new DynamicStructuredTool({
    name: "show_status",
    description: "Show current status of any pending operations when user asks about status or progress.",
    schema: z.object({}),
    func: async () => {
        return JSON.stringify({
            success: true,
            action: 'SHOW_STATUS',
        });
    },
});

/**
 * Create all tools for a seller
 * @param {string} sellerId - The seller's MongoDB ObjectId
 * @returns {Array} Array of tool instances
 */
function createSellerTools(sellerId) {
    return [
        createProductTool(sellerId),
        updateProductTool(sellerId),
        deleteProductTool(sellerId),
        listProductsTool(sellerId),
        viewProductMediaTool(sellerId),
        addProductImagesTool(sellerId),
        addProductVideoTool(sellerId),
        deleteProductImageTool(sellerId),
        deleteAllProductImagesTool(sellerId),
        deleteProductVideoTool(sellerId),
        showHelpTool,
        showStatusTool,
    ];
}

module.exports = {
    createSellerTools,
    // Export schemas for reference
    CreateProductSchema,
    UpdateProductSchema,
    DeleteProductSchema,
    ListProductsSchema,
};
