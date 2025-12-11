const express = require('express');
const router = express.Router();
const Seller = require('../models/Seller');
const Product = require('../models/Product');
const Order = require('../models/Order');

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
        action: '/seller/products/add'
    });
});

// Add Product
router.post('/products/add', sellerAuth, async (req, res) => {
    try {
        const {
            name, description, price, category, brand,
            images, stock, weight, material, color, size
        } = req.body;
        
        const product = new Product({
            name,
            description,
            price: parseFloat(price),
            category,
            brand,
            images: images ? images.split('\n').map(img => img.trim()).filter(img => img) : [],
            stock: parseInt(stock) || 0,
            specifications: { weight, material, color, size },
            seller: req.session.sellerId
        });
        
        await product.save();
        res.redirect('/seller/products');
    } catch (error) {
        console.error(error);
        res.status(500).send('Error adding product');
    }
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
            action: `/seller/products/edit/${product._id}`
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Server Error');
    }
});

// Update Product
router.post('/products/edit/:id', sellerAuth, async (req, res) => {
    try {
        const {
            name, description, price, category, brand,
            images, stock, weight, material, color, size
        } = req.body;
        
        await Product.findOneAndUpdate(
            { _id: req.params.id, seller: req.session.sellerId },
            {
                name,
                description,
                price: parseFloat(price),
                category,
                brand,
                images: images ? images.split('\n').map(img => img.trim()).filter(img => img) : [],
                stock: parseInt(stock) || 0,
                specifications: { weight, material, color, size }
            }
        );
        
        res.redirect('/seller/products');
    } catch (error) {
        console.error(error);
        res.status(500).send('Error updating product');
    }
});

// Delete Product
router.post('/products/delete/:id', sellerAuth, async (req, res) => {
    try {
        await Product.findOneAndDelete({ 
            _id: req.params.id, 
            seller: req.session.sellerId 
        });
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
