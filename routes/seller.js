const express = require('express');
const router = express.Router();
const Seller = require('../models/Seller');
const Product = require('../models/Product');
const Order = require('../models/Order');
const { uploadProductMedia, uploadToCloudinary, deleteFromCloudinary, getPublicIdFromUrl } = require('../config/cloudinary');

// Seller auth middleware
const sellerAuth = (req, res, next) => {
    if (req.session && req.session.sellerId) {
        next();
    } else {
        res.redirect('/seller/login');
    }
};

// Seller Logout
router.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('Error destroying session:', err);
        }
        res.redirect('/');
    });
});

// Seller Login Page
router.get('/login', (req, res) => {
    if (req.session && req.session.sellerId) {
        return res.redirect('/seller/dashboard');
    }
    res.render('seller/login', { 
        title: 'Seller Login',
        error: null,
        cartCount: 0
    });
});

// Seller Login
router.post('/login', async (req, res) => {
    try {
        const { phone, password } = req.body;
        
        const seller = await Seller.findOne({ phone });
        if (!seller) {
            return res.render('seller/login', {
                title: 'Seller Login',
                error: 'Invalid phone number or password',
                cartCount: 0
            });
        }
        
        const isMatch = await seller.comparePassword(password);
        if (!isMatch) {
            return res.render('seller/login', {
                title: 'Seller Login',
                error: 'Invalid phone number or password',
                cartCount: 0
            });
        }
        
        if (!seller.isActive) {
            return res.render('seller/login', {
                title: 'Seller Login',
                error: 'Your account has been deactivated. Contact admin.',
                cartCount: 0
            });
        }
        
        req.session.sellerId = seller._id;
        req.session.sellerName = seller.name;
        req.session.storeName = seller.storeName;
        
        res.redirect('/seller/dashboard');
    } catch (error) {
        console.error(error);
        res.render('seller/login', {
            title: 'Seller Login',
            error: 'Login failed. Please try again.',
            cartCount: 0
        });
    }
});

// Seller Signup Page
router.get('/signup', (req, res) => {
    if (req.session && req.session.sellerId) {
        return res.redirect('/seller/dashboard');
    }
    res.render('seller/signup', { 
        title: 'Register as Seller',
        error: null,
        cartCount: 0
    });
});

// Seller Signup
router.post('/signup', async (req, res) => {
    try {
        const { name, phone, email, storeName, password, confirmPassword } = req.body;
        
        if (password !== confirmPassword) {
            return res.render('seller/signup', {
                title: 'Register as Seller',
                error: 'Passwords do not match',
                cartCount: 0
            });
        }
        
        // Check if phone already exists
        const existingSeller = await Seller.findOne({ phone });
        if (existingSeller) {
            return res.render('seller/signup', {
                title: 'Register as Seller',
                error: 'Phone number already registered',
                cartCount: 0
            });
        }
        
        const seller = new Seller({
            name,
            phone,
            email: email || undefined,
            storeName,
            password
        });
        
        await seller.save();
        
        // Auto login after signup
        req.session.sellerId = seller._id;
        req.session.sellerName = seller.name;
        req.session.storeName = seller.storeName;
        
        res.redirect('/seller/dashboard');
    } catch (error) {
        console.error(error);
        res.render('seller/signup', {
            title: 'Register as Seller',
            error: 'Registration failed. Please try again.',
            cartCount: 0
        });
    }
});

// Seller Logout
router.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/seller/login');
});

// Seller Dashboard
router.get('/dashboard', sellerAuth, async (req, res) => {
    try {
        const sellerId = req.session.sellerId;
        
        const totalProducts = await Product.countDocuments({ seller: sellerId });
        const lowStock = await Product.countDocuments({ seller: sellerId, stock: { $lt: 5 } });
        
        // Get seller's products in orders
        const products = await Product.find({ seller: sellerId });
        const productIds = products.map(p => p._id);
        
        const orders = await Order.find({ 'items.product': { $in: productIds } });
        const totalOrders = orders.length;
        
        let totalRevenue = 0;
        orders.forEach(order => {
            order.items.forEach(item => {
                if (productIds.some(id => id.equals(item.product))) {
                    totalRevenue += item.price * item.quantity;
                }
            });
        });
        
        const recentProducts = await Product.find({ seller: sellerId })
            .sort({ createdAt: -1 })
            .limit(5);
        
        res.render('seller/dashboard', {
            title: 'Seller Dashboard',
            sellerName: req.session.sellerName,
            storeName: req.session.storeName,
            stats: {
                totalProducts,
                totalOrders,
                totalRevenue,
                lowStock
            },
            recentProducts
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Server Error');
    }
});

// Seller Products List
router.get('/products', sellerAuth, async (req, res) => {
    try {
        const sellerId = req.session.sellerId;
        const { category, search } = req.query;
        let query = { seller: sellerId };
        
        if (category) query.category = category;
        if (search) {
            query.$or = [
                { name: { $regex: search, $options: 'i' } },
                { brand: { $regex: search, $options: 'i' } }
            ];
        }
        
        const products = await Product.find(query).sort({ createdAt: -1 });
        res.render('seller/products', {
            title: 'My Products',
            storeName: req.session.storeName,
            products,
            category: category || '',
            search: search || ''
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Server Error');
    }
});

// Add Product Form
router.get('/products/add', sellerAuth, (req, res) => {
    res.render('seller/product-form', {
        title: 'Add Product',
        storeName: req.session.storeName,
        product: null,
        action: '/seller/products/add',
        error: null
    });
});

// Multer middleware for product media
const productMediaUpload = uploadProductMedia.fields([
    { name: 'images', maxCount: 5 },
    { name: 'video', maxCount: 1 }
]);

// Add Product with file upload
router.post('/products/add', sellerAuth, (req, res) => {
    productMediaUpload(req, res, async (err) => {
        if (err) {
            console.error('Upload error:', err);
            return res.render('seller/product-form', {
                title: 'Add Product',
                storeName: req.session.storeName,
                product: null,
                action: '/seller/products/add',
                error: err.message
            });
        }
        
        try {
            const {
                name, description, price, category, brand,
                existingImages, stock, weight, material, color, size
            } = req.body;
            
            // Upload images to Cloudinary
            const imageUrls = [];
            if (req.files && req.files.images) {
                for (const file of req.files.images) {
                    // Validate file size (2MB for images)
                    if (file.size > 2 * 1024 * 1024) {
                        return res.render('seller/product-form', {
                            title: 'Add Product',
                            storeName: req.session.storeName,
                            product: null,
                            action: '/seller/products/add',
                            error: `Image ${file.originalname} exceeds 2MB limit`
                        });
                    }
                    
                    const result = await uploadToCloudinary(file.buffer, {
                        folder: 'badminton-store/products',
                        transformation: [{ width: 1200, height: 1200, crop: 'limit', quality: 'auto' }],
                        resource_type: 'image'
                    });
                    imageUrls.push(result.secure_url);
                }
            }
            
            // Upload video to Cloudinary if provided
            let videoData = null;
            if (req.files && req.files.video && req.files.video[0]) {
                const videoFile = req.files.video[0];
                const result = await uploadToCloudinary(videoFile.buffer, {
                    folder: 'badminton-store/videos',
                    resource_type: 'video',
                    eager: [{ format: 'mp4' }]
                });
                videoData = {
                    url: result.secure_url,
                    publicId: result.public_id
                };
            }
            
            const product = new Product({
                name,
                description,
                price: parseFloat(price),
                category,
                brand,
                images: imageUrls,
                video: videoData,
                stock: parseInt(stock) || 0,
                specifications: { weight, material, color, size },
                seller: req.session.sellerId
            });
            
            await product.save();
            res.redirect('/seller/products');
        } catch (error) {
            console.error(error);
            res.render('seller/product-form', {
                title: 'Add Product',
                storeName: req.session.storeName,
                product: null,
                action: '/seller/products/add',
                error: 'Error adding product. Please try again.'
            });
        }
    });
});

// Edit Product Form
router.get('/products/edit/:id', sellerAuth, async (req, res) => {
    try {
        const product = await Product.findOne({ 
            _id: req.params.id, 
            seller: req.session.sellerId 
        });
        
        if (!product) {
            return res.status(404).send('Product not found');
        }
        
        res.render('seller/product-form', {
            title: 'Edit Product',
            storeName: req.session.storeName,
            product,
            action: `/seller/products/edit/${product._id}`,
            error: null
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Server Error');
    }
});

// Update Product with file upload
router.post('/products/edit/:id', sellerAuth, (req, res) => {
    productMediaUpload(req, res, async (err) => {
        if (err) {
            console.error('Upload error:', err);
            const product = await Product.findOne({ _id: req.params.id, seller: req.session.sellerId });
            return res.render('seller/product-form', {
                title: 'Edit Product',
                storeName: req.session.storeName,
                product,
                action: `/seller/products/edit/${req.params.id}`,
                error: err.message
            });
        }
        
        try {
            const {
                name, description, price, category, brand,
                existingImages, removeVideo, stock, weight, material, color, size
            } = req.body;
            
            const product = await Product.findOne({ 
                _id: req.params.id, 
                seller: req.session.sellerId 
            });
            
            if (!product) {
                return res.status(404).send('Product not found');
            }
            
            // Handle existing images (keep selected ones)
            let imageUrls = [];
            if (existingImages) {
                const keepImages = Array.isArray(existingImages) ? existingImages : [existingImages];
                imageUrls = keepImages;
                
                // Delete removed images from Cloudinary
                const removedImages = product.images.filter(img => !keepImages.includes(img));
                for (const imgUrl of removedImages) {
                    const publicId = getPublicIdFromUrl(imgUrl);
                    if (publicId) {
                        await deleteFromCloudinary(publicId, 'image');
                    }
                }
            }
            
            // Upload new images
            if (req.files && req.files.images) {
                // Check total images don't exceed 5
                if (imageUrls.length + req.files.images.length > 5) {
                    return res.render('seller/product-form', {
                        title: 'Edit Product',
                        storeName: req.session.storeName,
                        product,
                        action: `/seller/products/edit/${req.params.id}`,
                        error: 'Maximum 5 images allowed per product'
                    });
                }
                
                for (const file of req.files.images) {
                    if (file.size > 2 * 1024 * 1024) {
                        return res.render('seller/product-form', {
                            title: 'Edit Product',
                            storeName: req.session.storeName,
                            product,
                            action: `/seller/products/edit/${req.params.id}`,
                            error: `Image ${file.originalname} exceeds 2MB limit`
                        });
                    }
                    
                    const result = await uploadToCloudinary(file.buffer, {
                        folder: 'badminton-store/products',
                        transformation: [{ width: 1200, height: 1200, crop: 'limit', quality: 'auto' }],
                        resource_type: 'image'
                    });
                    imageUrls.push(result.secure_url);
                }
            }
            
            // Handle video
            let videoData = product.video;
            
            // Remove video if requested
            if (removeVideo === 'true' && product.video && product.video.publicId) {
                await deleteFromCloudinary(product.video.publicId, 'video');
                videoData = null;
            }
            
            // Upload new video if provided
            if (req.files && req.files.video && req.files.video[0]) {
                // Delete old video first
                if (product.video && product.video.publicId) {
                    await deleteFromCloudinary(product.video.publicId, 'video');
                }
                
                const videoFile = req.files.video[0];
                const result = await uploadToCloudinary(videoFile.buffer, {
                    folder: 'badminton-store/videos',
                    resource_type: 'video',
                    eager: [{ format: 'mp4' }]
                });
                videoData = {
                    url: result.secure_url,
                    publicId: result.public_id
                };
            }
            
            await Product.findOneAndUpdate(
                { _id: req.params.id, seller: req.session.sellerId },
                {
                    name,
                    description,
                    price: parseFloat(price),
                    category,
                    brand,
                    images: imageUrls,
                    video: videoData,
                    stock: parseInt(stock) || 0,
                    specifications: { weight, material, color, size }
                }
            );
            
            res.redirect('/seller/products');
        } catch (error) {
            console.error(error);
            const product = await Product.findOne({ _id: req.params.id, seller: req.session.sellerId });
            res.render('seller/product-form', {
                title: 'Edit Product',
                storeName: req.session.storeName,
                product,
                action: `/seller/products/edit/${req.params.id}`,
                error: 'Error updating product. Please try again.'
            });
        }
    });
});

// Delete Product
router.post('/products/delete/:id', sellerAuth, async (req, res) => {
    try {
        const product = await Product.findOne({ 
            _id: req.params.id, 
            seller: req.session.sellerId 
        });
        
        if (product) {
            // Delete images from Cloudinary
            for (const imgUrl of product.images) {
                const publicId = getPublicIdFromUrl(imgUrl);
                if (publicId) {
                    await deleteFromCloudinary(publicId, 'image');
                }
            }
            
            // Delete video from Cloudinary
            if (product.video && product.video.publicId) {
                await deleteFromCloudinary(product.video.publicId, 'video');
            }
            
            await Product.findByIdAndDelete(product._id);
        }
        
        res.redirect('/seller/products');
    } catch (error) {
        console.error(error);
        res.status(500).send('Error deleting product');
    }
});

// Seller Orders (orders containing their products)
router.get('/orders', sellerAuth, async (req, res) => {
    try {
        const sellerId = req.session.sellerId;
        const products = await Product.find({ seller: sellerId });
        const productIds = products.map(p => p._id);
        
        const orders = await Order.find({ 'items.product': { $in: productIds } })
            .sort({ createdAt: -1 });
        
        // Filter order items to only show this seller's products
        const sellerOrders = orders.map(order => {
            const sellerItems = order.items.filter(item => 
                productIds.some(id => id.equals(item.product))
            );
            const sellerTotal = sellerItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);
            return {
                ...order.toObject(),
                sellerItems,
                sellerTotal
            };
        });
        
        res.render('seller/orders', {
            title: 'My Orders',
            storeName: req.session.storeName,
            orders: sellerOrders
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Server Error');
    }
});

module.exports = router;
