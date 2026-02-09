const express = require('express');
const router = express.Router();
const Product = require('../models/Product');
const Seller = require('../models/Seller');
const path = require('path');
const fs = require('fs');

// Middleware to verify API Key (Security Best Practice)
const verifyApiKey = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    // In production, use process.env.N8N_API_KEY
    if (apiKey === process.env.N8N_API_KEY) { 
        next();
    } else {
        res.status(403).json({ error: 'Unauthorized' });
    }
};

router.use(verifyApiKey);

// Helper: Find seller by phone
async function getSellerByPhone(phone) {
    // Normalize phone if necessary (remove + or spaces)
    return await Seller.findOne({ phone: phone });
}

// 1. CREATE PRODUCT
router.post('/products/create', async (req, res) => {
    try {
        const { phone, product } = req.body;
        const seller = await getSellerByPhone(phone);

        if (!seller) return res.status(404).json({ error: 'Seller not found' });

        // Logic Check: Description and Media (Image or Video) are required
        if (!product.description) {
            return res.status(400).json({ error: 'Description is required' });
        }
        
        const hasImages = product.images && Array.isArray(product.images) && product.images.length > 0;
        const hasVideo = !!product.video;

        if (!hasImages && !hasVideo) {
             return res.status(400).json({ error: 'At least one media (image or video) is required' });
        }

        const newProduct = new Product({
            ...product,
            seller: seller._id,
            // Ensure numeric fields are numbers if provided
            price: product.price ? parseFloat(product.price) : 0,
            stock: product.stock ? parseInt(product.stock) : 0,
            images: product.images || [],
            video: product.video || ''
        });

        await newProduct.save();
        res.json({ success: true, product: newProduct });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// 2. READ / LIST PRODUCTS (For AI to know what to update/delete)
router.get('/products', async (req, res) => {
    try {
        const { phone, search } = req.query;
        const seller = await getSellerByPhone(phone);
        
        if (!seller) return res.status(404).json({ error: 'Seller not found' });

        let query = { seller: seller._id };
        if (search) {
            query.$or = [
                { name: { $regex: search, $options: 'i' } },
                { description: { $regex: search, $options: 'i' } }
            ];
        }

        const products = await Product.find(query).limit(10); // Limit to prevent confusing the AI
        res.json({ products });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 3. UPDATE PRODUCT
router.post('/products/update', async (req, res) => {
    try {
        const { phone, searchName, updates } = req.body;
        const seller = await getSellerByPhone(phone);

        if (!seller) return res.status(404).json({ error: 'Seller not found' });

        // Find product by name (fuzzy match handled by AI passing exact name, or we search here)
        // Ideally, n8n lists products first, gets an ID, and passes the ID.
        // But if passing name:
        const product = await Product.findOne({ 
            seller: seller._id, 
            name: { $regex: new RegExp(`^${searchName}$`, 'i') } 
        });

        if (!product) return res.status(404).json({ error: `Product '${searchName}' not found` });

        // Apply updates
        Object.keys(updates).forEach(key => {
            if (updates[key] !== undefined && updates[key] !== null) {
                product[key] = updates[key];
            }
        });

        await product.save();
        res.json({ success: true, product });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 4. DELETE PRODUCT
router.post('/products/delete', async (req, res) => {
    try {
        const { phone, productName } = req.body;
        const seller = await getSellerByPhone(phone);

        if (!seller) return res.status(404).json({ error: 'Seller not found' });

        const result = await Product.findOneAndDelete({
            seller: seller._id,
            name: { $regex: new RegExp(`^${productName}$`, 'i') }
        });

        if (!result) return res.status(404).json({ error: 'Product not found' });

        res.json({ success: true, message: 'Deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 5. MEDIA UPLOAD (Optional: if n8n sends raw files base64 or you implement multer here)
// For now, n8n can host images or we can add a simple Base64 saver:
router.post('/upload', async (req, res) => {
    // Expects { filename: "image.jpg", data: "base64String..." }
    try {
        const { filename, data } = req.body;
        const buffer = Buffer.from(data, 'base64');
        const uploadPath = path.join(__dirname, '../public/uploads', filename); // Ensure this folder exists
        
        fs.writeFileSync(uploadPath, buffer);
        
        // Return the public URL
        const fileUrl = `/uploads/${filename}`;
        res.json({ url: fileUrl });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;