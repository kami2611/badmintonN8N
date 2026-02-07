/**
 * Agent API Routes
 * REST endpoints for the n8n AI agent to interact with the application
 * All routes are protected by requireAgentSecret middleware
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const Product = require('../models/Product');
const Seller = require('../models/Seller');
const Order = require('../models/Order');
const bcrypt = require('bcrypt');
const requireAgentSecret = require('../middleware/requireAgentSecret');
const { uploadToCloudinary, deleteFromCloudinary, getPublicIdFromUrl } = require('../config/cloudinary');

// Apply agent secret authentication to all routes
router.use(requireAgentSecret);

// ============ PRODUCT ENDPOINTS ============

/**
 * Create a new product
 * POST /api/agent/products
 */
router.post('/products', async (req, res) => {
    try {
        const { 
            sellerId, 
            name, 
            price, 
            category, 
            description = '',
            brand = '',
            stock = 1,
            condition = 'new',
            images = [],
            specifications = {},
            racketSpecs = {},
            shoeSpecs = {}
        } = req.body;

        if (!sellerId) {
            return res.status(400).json({ error: 'sellerId is required' });
        }
        if (!name || !price || !category) {
            return res.status(400).json({ error: 'name, price, and category are required' });
        }

        // Verify seller exists
        const seller = await Seller.findById(sellerId);
        if (!seller) {
            return res.status(404).json({ error: 'Seller not found' });
        }

        const product = new Product({
            seller: sellerId,
            name,
            price,
            category,
            description: description || `${name} - Quality badminton equipment`,
            brand,
            stock,
            condition,
            images: Array.isArray(images) ? images : [],
            specifications,
            racketSpecs,
            shoeSpecs
        });

        await product.save();

        res.status(201).json({
            success: true,
            product: {
                id: product._id,
                name: product.name,
                price: product.price,
                category: product.category,
                stock: product.stock,
                brand: product.brand,
                condition: product.condition,
                imageCount: product.images.length
            },
            message: `Product "${product.name}" created successfully!`
        });

    } catch (error) {
        console.error('❌ [AGENT API] Create product error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * List products for a seller
 * GET /api/agent/products?sellerId=xxx&category=xxx&limit=xxx
 */
router.get('/products', async (req, res) => {
    try {
        const { sellerId, category, limit = 15 } = req.query;

        if (!sellerId) {
            return res.status(400).json({ error: 'sellerId is required' });
        }

        const query = { seller: sellerId };
        if (category) {
            query.category = category;
        }

        const products = await Product.find(query)
            .limit(parseInt(limit))
            .sort({ createdAt: -1 })
            .select('name price stock category condition brand images description');

        res.json({
            success: true,
            count: products.length,
            category: category || 'all',
            products: products.map(p => ({
                id: p._id,
                name: p.name,
                price: p.price,
                stock: p.stock,
                category: p.category,
                condition: p.condition,
                brand: p.brand,
                imageCount: p.images?.length || 0,
                description: p.description
            }))
        });

    } catch (error) {
        console.error('❌ [AGENT API] List products error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Search products by name
 * GET /api/agent/products/search?sellerId=xxx&name=xxx
 */
router.get('/products/search', async (req, res) => {
    try {
        const { sellerId, name } = req.query;

        if (!sellerId || !name) {
            return res.status(400).json({ error: 'sellerId and name are required' });
        }

        const product = await Product.findOne({
            seller: sellerId,
            name: { $regex: name, $options: 'i' }
        });

        if (!product) {
            return res.json({ success: false, found: false, message: `Product "${name}" not found` });
        }

        res.json({
            success: true,
            found: true,
            product: {
                id: product._id,
                name: product.name,
                price: product.price,
                stock: product.stock,
                category: product.category,
                condition: product.condition,
                brand: product.brand,
                description: product.description,
                images: product.images,
                imageCount: product.images?.length || 0,
                hasVideo: !!(product.video && product.video.url)
            }
        });

    } catch (error) {
        console.error('❌ [AGENT API] Search product error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Get single product by ID
 * GET /api/agent/products/:id
 */
router.get('/products/:id', async (req, res) => {
    try {
        const product = await Product.findById(req.params.id).populate('seller', 'name storeName phone');

        if (!product) {
            return res.status(404).json({ error: 'Product not found' });
        }

        res.json({
            success: true,
            product
        });

    } catch (error) {
        console.error('❌ [AGENT API] Get product error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Update a product
 * PATCH /api/agent/products/:id
 */
router.patch('/products/:id', async (req, res) => {
    try {
        const { sellerId, ...updates } = req.body;

        if (!sellerId) {
            return res.status(400).json({ error: 'sellerId is required' });
        }

        const product = await Product.findOne({ _id: req.params.id, seller: sellerId });

        if (!product) {
            return res.status(404).json({ error: 'Product not found or access denied' });
        }

        // Apply updates
        const allowedUpdates = ['name', 'price', 'stock', 'description', 'condition', 'brand', 'category', 'specifications', 'racketSpecs', 'shoeSpecs'];
        const appliedUpdates = [];

        for (const field of allowedUpdates) {
            if (updates[field] !== undefined) {
                product[field] = updates[field];
                appliedUpdates.push(field);
            }
        }

        if (appliedUpdates.length === 0) {
            return res.status(400).json({ error: 'No valid updates provided' });
        }

        await product.save();

        res.json({
            success: true,
            product: {
                id: product._id,
                name: product.name,
                price: product.price,
                stock: product.stock,
                category: product.category
            },
            updatedFields: appliedUpdates,
            message: `Product "${product.name}" updated successfully!`
        });

    } catch (error) {
        console.error('❌ [AGENT API] Update product error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Delete a product
 * DELETE /api/agent/products/:id?sellerId=xxx
 */
router.delete('/products/:id', async (req, res) => {
    try {
        const { sellerId } = req.query;

        if (!sellerId) {
            return res.status(400).json({ error: 'sellerId is required' });
        }

        const product = await Product.findOneAndDelete({ _id: req.params.id, seller: sellerId });

        if (!product) {
            return res.status(404).json({ error: 'Product not found or access denied' });
        }

        // Clean up Cloudinary assets
        if (product.images && product.images.length > 0) {
            for (const imgUrl of product.images) {
                const publicId = getPublicIdFromUrl(imgUrl);
                if (publicId) {
                    await deleteFromCloudinary(publicId, 'image').catch(() => {});
                }
            }
        }

        if (product.video && product.video.publicId) {
            await deleteFromCloudinary(product.video.publicId, 'video').catch(() => {});
        }

        res.json({
            success: true,
            message: `Product "${product.name}" deleted successfully!`
        });

    } catch (error) {
        console.error('❌ [AGENT API] Delete product error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============ PRODUCT IMAGE ENDPOINTS ============

/**
 * Add image URL to a product
 * POST /api/agent/products/:id/images
 */
router.post('/products/:id/images', async (req, res) => {
    try {
        const { sellerId, imageUrl } = req.body;

        if (!sellerId || !imageUrl) {
            return res.status(400).json({ error: 'sellerId and imageUrl are required' });
        }

        const product = await Product.findOne({ _id: req.params.id, seller: sellerId });

        if (!product) {
            return res.status(404).json({ error: 'Product not found or access denied' });
        }

        const MAX_IMAGES = 5;
        if (product.images.length >= MAX_IMAGES) {
            return res.status(400).json({ 
                error: `Product already has maximum ${MAX_IMAGES} images`,
                currentCount: product.images.length
            });
        }

        product.images.push(imageUrl);
        await product.save();

        res.json({
            success: true,
            imageCount: product.images.length,
            maxImages: MAX_IMAGES,
            remainingSlots: MAX_IMAGES - product.images.length,
            message: `Image added to "${product.name}"`
        });

    } catch (error) {
        console.error('❌ [AGENT API] Add image error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Delete an image from a product
 * DELETE /api/agent/products/:id/images/:index?sellerId=xxx
 */
router.delete('/products/:id/images/:index', async (req, res) => {
    try {
        const { sellerId } = req.query;
        const imageIndex = parseInt(req.params.index);

        if (!sellerId) {
            return res.status(400).json({ error: 'sellerId is required' });
        }

        const product = await Product.findOne({ _id: req.params.id, seller: sellerId });

        if (!product) {
            return res.status(404).json({ error: 'Product not found or access denied' });
        }

        if (!product.images || product.images.length === 0) {
            return res.status(400).json({ error: 'Product has no images' });
        }

        if (imageIndex < 0 || imageIndex >= product.images.length) {
            return res.status(400).json({ 
                error: `Invalid image index. Product has ${product.images.length} image(s). Use index 0-${product.images.length - 1}` 
            });
        }

        // Delete from Cloudinary
        const imgUrl = product.images[imageIndex];
        const publicId = getPublicIdFromUrl(imgUrl);
        if (publicId) {
            await deleteFromCloudinary(publicId, 'image').catch(() => {});
        }

        product.images.splice(imageIndex, 1);
        await product.save();

        res.json({
            success: true,
            remainingImages: product.images.length,
            message: `Image deleted from "${product.name}"`
        });

    } catch (error) {
        console.error('❌ [AGENT API] Delete image error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Delete all images from a product
 * DELETE /api/agent/products/:id/images?sellerId=xxx
 */
router.delete('/products/:id/images', async (req, res) => {
    try {
        const { sellerId } = req.query;

        if (!sellerId) {
            return res.status(400).json({ error: 'sellerId is required' });
        }

        const product = await Product.findOne({ _id: req.params.id, seller: sellerId });

        if (!product) {
            return res.status(404).json({ error: 'Product not found or access denied' });
        }

        if (!product.images || product.images.length === 0) {
            return res.status(400).json({ error: 'Product has no images to delete' });
        }

        // Delete all from Cloudinary
        for (const imgUrl of product.images) {
            const publicId = getPublicIdFromUrl(imgUrl);
            if (publicId) {
                await deleteFromCloudinary(publicId, 'image').catch(() => {});
            }
        }

        const deletedCount = product.images.length;
        product.images = [];
        await product.save();

        res.json({
            success: true,
            deletedCount,
            message: `All ${deletedCount} images deleted from "${product.name}"`
        });

    } catch (error) {
        console.error('❌ [AGENT API] Delete all images error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============ PRODUCT VIDEO ENDPOINTS ============

/**
 * Set video on a product
 * POST /api/agent/products/:id/video
 */
router.post('/products/:id/video', async (req, res) => {
    try {
        const { sellerId, videoUrl, publicId } = req.body;

        if (!sellerId || !videoUrl) {
            return res.status(400).json({ error: 'sellerId and videoUrl are required' });
        }

        const product = await Product.findOne({ _id: req.params.id, seller: sellerId });

        if (!product) {
            return res.status(404).json({ error: 'Product not found or access denied' });
        }

        // Delete old video if exists
        if (product.video && product.video.publicId) {
            await deleteFromCloudinary(product.video.publicId, 'video').catch(() => {});
        }

        product.video = {
            url: videoUrl,
            publicId: publicId || null
        };
        await product.save();

        res.json({
            success: true,
            message: `Video added to "${product.name}"`
        });

    } catch (error) {
        console.error('❌ [AGENT API] Add video error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Delete video from a product
 * DELETE /api/agent/products/:id/video?sellerId=xxx
 */
router.delete('/products/:id/video', async (req, res) => {
    try {
        const { sellerId } = req.query;

        if (!sellerId) {
            return res.status(400).json({ error: 'sellerId is required' });
        }

        const product = await Product.findOne({ _id: req.params.id, seller: sellerId });

        if (!product) {
            return res.status(404).json({ error: 'Product not found or access denied' });
        }

        if (!product.video || !product.video.url) {
            return res.status(400).json({ error: 'Product has no video' });
        }

        // Delete from Cloudinary
        if (product.video.publicId) {
            await deleteFromCloudinary(product.video.publicId, 'video').catch(() => {});
        }

        product.video = { url: null, publicId: null };
        await product.save();

        res.json({
            success: true,
            message: `Video deleted from "${product.name}"`
        });

    } catch (error) {
        console.error('❌ [AGENT API] Delete video error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============ SELLER ENDPOINTS ============

/**
 * Get seller by phone number
 * GET /api/agent/sellers/:phone
 */
router.get('/sellers/:phone', async (req, res) => {
    try {
        const seller = await Seller.findOne({ phone: req.params.phone });

        if (!seller) {
            return res.json({ 
                success: true, 
                found: false, 
                message: 'Seller not found' 
            });
        }

        res.json({
            success: true,
            found: true,
            seller: {
                id: seller._id,
                name: seller.name,
                phone: seller.phone,
                storeName: seller.storeName,
                onboardingStep: seller.onboardingStep,
                status: seller.status,
                isActive: seller.isActive,
                createdAt: seller.createdAt
            }
        });

    } catch (error) {
        console.error('❌ [AGENT API] Get seller error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Create or update a seller
 * POST /api/agent/sellers
 */
router.post('/sellers', async (req, res) => {
    try {
        const { phone, name, storeName, onboardingStep } = req.body;

        if (!phone) {
            return res.status(400).json({ error: 'phone is required' });
        }

        let seller = await Seller.findOne({ phone });

        if (seller) {
            // Update existing seller
            if (name) seller.name = name;
            if (storeName) seller.storeName = storeName;
            if (onboardingStep) seller.onboardingStep = onboardingStep;
            await seller.save();

            return res.json({
                success: true,
                action: 'updated',
                seller: {
                    id: seller._id,
                    name: seller.name,
                    phone: seller.phone,
                    storeName: seller.storeName,
                    onboardingStep: seller.onboardingStep
                }
            });
        }

        // Create new seller
        const dummyPassword = await bcrypt.hash(Date.now().toString() + Math.random(), 10);
        seller = new Seller({
            phone,
            name: name || 'Pending',
            storeName: storeName || 'Pending',
            password: dummyPassword,
            onboardingStep: onboardingStep || 'new'
        });
        await seller.save();

        res.status(201).json({
            success: true,
            action: 'created',
            seller: {
                id: seller._id,
                name: seller.name,
                phone: seller.phone,
                storeName: seller.storeName,
                onboardingStep: seller.onboardingStep
            }
        });

    } catch (error) {
        console.error('❌ [AGENT API] Create/update seller error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Update seller by phone
 * PATCH /api/agent/sellers/:phone
 */
router.patch('/sellers/:phone', async (req, res) => {
    try {
        const { name, storeName, onboardingStep } = req.body;

        const seller = await Seller.findOne({ phone: req.params.phone });

        if (!seller) {
            return res.status(404).json({ error: 'Seller not found' });
        }

        if (name) seller.name = name;
        if (storeName) seller.storeName = storeName;
        if (onboardingStep) seller.onboardingStep = onboardingStep;

        await seller.save();

        res.json({
            success: true,
            seller: {
                id: seller._id,
                name: seller.name,
                phone: seller.phone,
                storeName: seller.storeName,
                onboardingStep: seller.onboardingStep
            },
            message: 'Seller updated successfully'
        });

    } catch (error) {
        console.error('❌ [AGENT API] Update seller error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============ WHATSAPP MESSAGE ENDPOINT ============

/**
 * Send a WhatsApp message
 * POST /api/agent/whatsapp/send
 */
router.post('/whatsapp/send', async (req, res) => {
    try {
        const { to, message } = req.body;

        if (!to || !message) {
            return res.status(400).json({ error: 'to and message are required' });
        }

        await axios({
            method: 'POST',
            url: `https://graph.facebook.com/v17.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
            headers: {
                'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
                'Content-Type': 'application/json',
            },
            data: {
                messaging_product: 'whatsapp',
                to: to,
                text: { body: message },
            },
        });

        res.json({
            success: true,
            message: 'Message sent successfully'
        });

    } catch (error) {
        console.error('❌ [AGENT API] Send WhatsApp error:', error.response?.data || error.message);
        res.status(500).json({ 
            error: 'Failed to send message',
            details: error.response?.data || error.message
        });
    }
});

// ============ CLOUDINARY UPLOAD ENDPOINT ============

/**
 * Upload image from URL to Cloudinary
 * POST /api/agent/upload/image
 */
router.post('/upload/image', async (req, res) => {
    try {
        const { imageUrl, folder = 'badminton-store/products' } = req.body;

        if (!imageUrl) {
            return res.status(400).json({ error: 'imageUrl is required' });
        }

        // Download image
        const response = await axios({
            method: 'GET',
            url: imageUrl,
            responseType: 'arraybuffer',
            headers: {
                'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
            },
        });

        const buffer = Buffer.from(response.data);

        // Upload to Cloudinary
        const result = await uploadToCloudinary(buffer, {
            folder,
            transformation: [{ width: 1200, height: 1200, crop: 'limit', quality: 'auto' }],
            resource_type: 'image'
        });

        res.json({
            success: true,
            url: result.secure_url,
            publicId: result.public_id
        });

    } catch (error) {
        console.error('❌ [AGENT API] Upload image error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Upload video from URL to Cloudinary
 * POST /api/agent/upload/video
 */
router.post('/upload/video', async (req, res) => {
    try {
        const { videoUrl, folder = 'badminton-store/videos' } = req.body;

        if (!videoUrl) {
            return res.status(400).json({ error: 'videoUrl is required' });
        }

        // Download video
        const response = await axios({
            method: 'GET',
            url: videoUrl,
            responseType: 'arraybuffer',
            headers: {
                'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
            },
        });

        const buffer = Buffer.from(response.data);

        // Upload to Cloudinary
        const result = await uploadToCloudinary(buffer, {
            folder,
            resource_type: 'video',
            eager: [{ format: 'mp4' }]
        });

        res.json({
            success: true,
            url: result.secure_url,
            publicId: result.public_id,
            duration: result.duration
        });

    } catch (error) {
        console.error('❌ [AGENT API] Upload video error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============ ORDER ENDPOINTS ============

/**
 * Get orders for a seller
 * GET /api/agent/orders?sellerId=xxx
 */
router.get('/orders', async (req, res) => {
    try {
        const { sellerId, status, limit = 20 } = req.query;

        if (!sellerId) {
            return res.status(400).json({ error: 'sellerId is required' });
        }

        // Find products belonging to this seller
        const sellerProducts = await Product.find({ seller: sellerId }).select('_id');
        const productIds = sellerProducts.map(p => p._id);

        // Find orders containing these products
        const query = { 'items.product': { $in: productIds } };
        if (status) {
            query.status = status;
        }

        const orders = await Order.find(query)
            .populate('items.product', 'name price')
            .sort({ createdAt: -1 })
            .limit(parseInt(limit));

        res.json({
            success: true,
            count: orders.length,
            orders
        });

    } catch (error) {
        console.error('❌ [AGENT API] Get orders error:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
