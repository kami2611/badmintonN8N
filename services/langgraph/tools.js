/**
 * LangGraph Tool Definitions
 * Defines all tools using Zod schemas for structured output
 */

const { z } = require("zod");
const { DynamicStructuredTool } = require("@langchain/core/tools");
const Product = require("../../models/Product");
const { uploadToCloudinary, deleteFromCloudinary, getPublicIdFromUrl } = require("../../config/cloudinary");

// ============ Product Info Extraction Helper ============

/**
 * Known badminton brands for detection
 */
const KNOWN_BRANDS = [
    'yonex', 'victor', 'li-ning', 'lining', 'apacs', 'fleet', 'carlton', 
    'babolat', 'wilson', 'ashaway', 'fz forza', 'forza', 'kawasaki',
    'adidas', 'asics', 'mizuno', 'nike', 'head', 'dunlop', 'prince',
    'kumpoo', 'yang yang', 'protech', 'mmoa', 'gosen', 'toalson'
];

/**
 * Category keyword mappings
 */
const CATEGORY_KEYWORDS = {
    rackets: ['racket', 'racquet', 'bat', 'astrox', 'nanoflare', 'arcsaber', 'duora', 'voltric', 'thruster', 'jetspeed', 'auraspeed', 'hypernano', 'brave sword'],
    shoes: ['shoe', 'shoes', 'footwear', 'shb', 'eclipsion', 'aerus', 'cascade'],
    shuttles: ['shuttle', 'shuttlecock', 'birdie', 'feather', 'mavis', 'aerosensa', 'as-', 'as50', 'as40', 'as30'],
    bags: ['bag', 'backpack', 'kitbag', 'racket bag', 'kit bag'],
    apparel: ['shirt', 'shorts', 'skirt', 'jersey', 'tshirt', 't-shirt', 'cloth', 'dress', 'jacket', 'trouser'],
    accessories: ['grip', 'string', 'overgrip', 'grommet', 'wristband', 'headband', 'towel', 'socks', 'sock']
};

/**
 * Extract product info from description text
 * @param {string} text - Product description
 * @returns {Object} Extracted fields with confidence
 */
function extractProductInfo(text) {
    const lowerText = text.toLowerCase();
    const result = {
        name: null,
        price: null,
        category: null,
        brand: null,
        condition: 'new',
        extracted: []
    };
    
    // ===== PRICE EXTRACTION =====
    const pricePatterns = [
        /(?:rs\.?|pkr|price|rate)[:\s]*([\d,]+)/i,
        /([\d,]+)(?:\s*\/[=-]|\s*rs|\s*pkr)/i,
        /([\d]+)\s*k\b/i,
        /\b([\d]{4,})\b/  // 4+ digit number as fallback
    ];
    
    for (const pattern of pricePatterns) {
        const match = text.match(pattern);
        if (match) {
            let priceStr = match[1].replace(/,/g, '');
            let price = parseInt(priceStr);
            
            // Handle "5k" = 5000
            if (/k\b/i.test(match[0]) && price < 1000) {
                price = price * 1000;
            }
            
            if (price > 0 && price < 10000000) { // Sanity check
                result.price = price;
                result.extracted.push(`Price: Rs. ${price.toLocaleString()}`);
                break;
            }
        }
    }
    
    // ===== BRAND EXTRACTION =====
    for (const brand of KNOWN_BRANDS) {
        if (lowerText.includes(brand)) {
            result.brand = brand.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
            // Fix common brand capitalizations
            if (result.brand.toLowerCase() === 'li-ning' || result.brand.toLowerCase() === 'lining') {
                result.brand = 'Li-Ning';
            }
            result.extracted.push(`Brand: ${result.brand}`);
            break;
        }
    }
    
    // ===== CATEGORY EXTRACTION =====
    for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
        for (const keyword of keywords) {
            if (lowerText.includes(keyword)) {
                result.category = category;
                result.extracted.push(`Category: ${category}`);
                break;
            }
        }
        if (result.category) break;
    }
    
    // ===== CONDITION EXTRACTION =====
    const usedKeywords = ['used', 'second hand', 'secondhand', '2nd hand', 'pre-owned', 'preowned', 'old'];
    for (const keyword of usedKeywords) {
        if (lowerText.includes(keyword)) {
            result.condition = 'used';
            result.extracted.push(`Condition: Used`);
            break;
        }
    }
    if (result.condition === 'new' && (lowerText.includes('brand new') || lowerText.includes('new'))) {
        result.extracted.push(`Condition: New`);
    }
    
    // ===== NAME EXTRACTION =====
    // Try to build name from brand + first part of description or model number
    const modelPatterns = [
        /\b(astrox\s*\d+[a-z]*)/i,
        /\b(nanoflare\s*\d+[a-z]*)/i,
        /\b(arcsaber\s*\d+[a-z]*)/i,
        /\b(voltric\s*\d+[a-z]*)/i,
        /\b(duora\s*\d+[a-z]*)/i,
        /\b(thruster\s*[a-z]*\d*)/i,
        /\b(jetspeed\s*\d+[a-z]*)/i,
        /\b(aerus\s*\d+[a-z]*)/i,
        /\b(eclipsion\s*\d+[a-z]*)/i,
        /\b(shb\s*\d+[a-z]*)/i,
        /\b(as-?\d+)/i,
        /\b(mavis\s*\d+)/i
    ];
    
    let modelName = null;
    for (const pattern of modelPatterns) {
        const match = text.match(pattern);
        if (match) {
            modelName = match[1].trim();
            break;
        }
    }
    
    if (result.brand && modelName) {
        result.name = `${result.brand} ${modelName}`;
    } else if (result.brand) {
        // Use first line or first few words as name
        const firstLine = text.split(/[\n,.]/)[0].trim();
        if (firstLine.length > 3 && firstLine.length < 60) {
            result.name = firstLine;
        } else {
            result.name = `${result.brand} Product`;
        }
    } else if (modelName) {
        result.name = modelName;
    } else {
        // Fallback: use first line or truncated description
        const firstLine = text.split(/[\n,.]/)[0].trim();
        if (firstLine.length > 3 && firstLine.length < 60) {
            result.name = firstLine;
        } else {
            result.name = text.substring(0, 40).trim() + (text.length > 40 ? '...' : '');
        }
    }
    
    if (result.name) {
        result.extracted.push(`Name: ${result.name}`);
    }
    
    return result;
}

// ============ Zod Schemas ============

const CreateProductSchema = z.object({
    name: z.string().describe("The product name"),
    price: z.number().min(1).describe("Price in PKR (minimum 1)"),
    category: z.enum(['rackets', 'shoes', 'accessories', 'apparel', 'bags', 'shuttles']).describe("Product category"),
    stock: z.number().int().min(0).optional().default(1).describe("Stock quantity"),
    brand: z.string().optional().default("").describe("Brand name"),
    description: z.string().optional().default("").describe("Product description"),
    condition: z.enum(['new', 'used']).optional().default('new').describe("Product condition"),
    imageUrl: z.string().optional().describe("URL of product image from buffered message"),
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

const AnalyzeProductImageSchema = z.object({
    imageUrl: z.string().describe("URL of the product image to analyze"),
});

const GetFieldPromptSchema = z.object({
    fieldName: z.enum(['name', 'category', 'price', 'description', 'brand', 'stock', 'condition']).describe("The field to generate a prompt for"),
    context: z.string().optional().describe("Additional context about the product (e.g., from image analysis)"),
});

const QuickCreateProductSchema = z.object({
    description: z.string().describe("The product description/caption from the seller"),
    imageUrl: z.string().describe("URL of the product image (required)"),
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
                    images: input.imageUrl ? [input.imageUrl] : [],
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
                        hasImage: !!input.imageUrl,
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
 * Analyze product image tool - Uses Gemini's vision to extract product info
 */
function analyzeProductImageTool() {
    return new DynamicStructuredTool({
        name: "analyze_product_image",
        description: "Analyze a product image to extract information like name, category, condition, and brand. Returns extracted data.",
        schema: AnalyzeProductImageSchema,
        func: async (input) => {
            try {
                const { GoogleGenerativeAI } = require("@google/generative-ai");
                const apiKey = process.env.GOOGLE_API_KEY;
                
                if (!apiKey) {
                    return JSON.stringify({
                        success: false,
                        error: "Vision API not configured",
                    });
                }
                
                const client = new GoogleGenerativeAI(apiKey);
                const model = client.getGenerativeModel({ model: "gemini-2.0-flash-lite-001" });
                
                const visionPrompt = `You are a badminton equipment expert. Analyze this product image and extract:
1. Product type/name (racket, shoe, shuttle, bag, apparel, etc.)
2. Brand if visible
3. Estimated condition (new, like-new, good, fair, poor)
4. Color/variant if notable
5. Any visible damage or wear

Return ONLY a JSON object with these fields: {
    "productType": "category name",
    "brand": "brand or 'unknown'",
    "condition": "new/used assessment",
    "estimatedPrice": "price range estimation or null",
    "visibleDetails": "2-3 key observable features"
}`;
                
                const response = await model.generateContent([
                    {
                        inlineData: {
                            mimeType: "image/jpeg",
                            data: Buffer.from(await fetch(input.imageUrl).then(r => r.arrayBuffer())).toString('base64'),
                        },
                    },
                    visionPrompt,
                ]);
                
                try {
                    const responseText = response.response.text();
                    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
                    const analysis = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
                    
                    return JSON.stringify({
                        success: true,
                        analysis,
                        action: 'IMAGE_ANALYZED',
                    });
                } catch (parseError) {
                    return JSON.stringify({
                        success: true,
                        analysis: { rawResponse: response.response.text() },
                        action: 'IMAGE_ANALYZED',
                    });
                }
            } catch (error) {
                return JSON.stringify({
                    success: false,
                    error: `Image analysis failed: ${error.message}`,
                });
            }
        },
    });
}

/**
 * Get field prompt tool - Generates contextual prompts for field collection
 */
function getFieldPromptTool() {
    return new DynamicStructuredTool({
        name: "get_field_prompt",
        description: "Generate a user-friendly prompt for collecting a specific product field during multi-turn conversation.",
        schema: GetFieldPromptSchema,
        func: async (input) => {
            const { getFieldPrompt } = require("./state");
            const prompt = getFieldPrompt(input.fieldName);
            
            return JSON.stringify({
                success: true,
                field: input.fieldName,
                prompt: prompt,
                context: input.context || null,
                action: 'FIELD_PROMPT_GENERATED',
            });
        },
    });
}

/**
 * Quick Create Product Tool - Creates product from image + description in one step
 * Automatically extracts price, category, brand, condition from description
 * @param {string} sellerId - The seller's MongoDB ID
 */
function quickCreateProductTool(sellerId) {
    return new DynamicStructuredTool({
        name: "quick_create_product",
        description: "Create a product quickly from an image with caption/description. Automatically extracts price, category, brand from the description. Use this when seller sends image with caption (INPUT_TYPE: IMAGE_WITH_CAPTION).",
        schema: QuickCreateProductSchema,
        func: async (input) => {
            try {
                console.log('📦 [QUICK CREATE] Starting with description:', input.description.substring(0, 50));
                
                // Extract product info from description
                const extracted = extractProductInfo(input.description);
                
                console.log('📦 [QUICK CREATE] Extracted:', extracted);
                
                // Build product data with extracted or default values
                const productData = {
                    name: extracted.name || input.description.substring(0, 50),
                    description: input.description,
                    price: extracted.price || 0,
                    category: extracted.category || 'accessories',
                    brand: extracted.brand || '',
                    condition: extracted.condition || 'new',
                    stock: 1,
                    seller: sellerId,
                    images: [input.imageUrl],
                };
                
                const newProduct = new Product(productData);
                await newProduct.save();
                
                console.log('✅ [QUICK CREATE] Product created:', newProduct._id);
                
                // Build response with extracted fields info
                const extractedInfo = [];
                if (extracted.price) extractedInfo.push(`Price: Rs. ${extracted.price.toLocaleString()}`);
                if (extracted.category) extractedInfo.push(`Category: ${extracted.category}`);
                if (extracted.brand) extractedInfo.push(`Brand: ${extracted.brand}`);
                if (extracted.condition) extractedInfo.push(`Condition: ${extracted.condition}`);
                extractedInfo.push(`Name: ${productData.name}`);
                
                return JSON.stringify({
                    success: true,
                    product: {
                        id: newProduct._id.toString(),
                        name: productData.name,
                        description: input.description,
                        price: productData.price,
                        category: productData.category,
                        brand: productData.brand,
                        condition: productData.condition,
                        hasImage: true,
                    },
                    extractedFields: extractedInfo,
                    message: `Product created successfully!`
                });
            } catch (error) {
                console.error('❌ [QUICK CREATE] Error:', error);
                return JSON.stringify({
                    success: false,
                    error: error.message
                });
            }
        },
    });
}

/**
 * Create all tools for a seller
 * @param {string} sellerId - The seller's MongoDB ObjectId
 * @returns {Array} Array of tool instances
 */
function createSellerTools(sellerId) {
    return [
        createProductTool(sellerId),
        quickCreateProductTool(sellerId),
        updateProductTool(sellerId),
        deleteProductTool(sellerId),
        listProductsTool(sellerId),
        viewProductMediaTool(sellerId),
        addProductImagesTool(sellerId),
        addProductVideoTool(sellerId),
        deleteProductImageTool(sellerId),
        deleteAllProductImagesTool(sellerId),
        deleteProductVideoTool(sellerId),
        analyzeProductImageTool(),
        getFieldPromptTool(),
        showHelpTool,
        showStatusTool,
    ];
}

module.exports = {
    createSellerTools,
    extractProductInfo,
    // Export schemas for reference
    CreateProductSchema,
    UpdateProductSchema,
    DeleteProductSchema,
    ListProductsSchema,
    QuickCreateProductSchema,
};
