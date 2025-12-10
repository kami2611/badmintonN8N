const express = require('express');
const router = express.Router();
const Product = require('../models/Product');
const Order = require('../models/Order');

// Simple admin auth middleware (in production, use proper authentication)
const adminAuth = (req, res, next) => {
    // For demo purposes, we'll use a simple query param or session
    // In production, implement proper admin authentication
    next();
};

// Admin Dashboard
router.get('/', adminAuth, async (req, res) => {
    try {
        const totalProducts = await Product.countDocuments();
        const totalOrders = await Order.countDocuments();
        const pendingOrders = await Order.countDocuments({ status: 'pending' });
        const recentOrders = await Order.find().sort({ createdAt: -1 }).limit(5);
        
        // Calculate total revenue
        const orders = await Order.find();
        const totalRevenue = orders.reduce((sum, order) => sum + order.totalAmount, 0);
        
        // Products by category
        const rackets = await Product.countDocuments({ category: 'rackets' });
        const shoes = await Product.countDocuments({ category: 'shoes' });
        const accessories = await Product.countDocuments({ category: 'accessories' });
        
        res.render('admin/dashboard', {
            title: 'Admin Dashboard',
            stats: {
                totalProducts,
                totalOrders,
                pendingOrders,
                totalRevenue,
                rackets,
                shoes,
                accessories
            },
            recentOrders
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Server Error');
    }
});

// Products List
router.get('/products', adminAuth, async (req, res) => {
    try {
        const { category, search } = req.query;
        let query = {};
        
        if (category) query.category = category;
        if (search) {
            query.$or = [
                { name: { $regex: search, $options: 'i' } },
                { brand: { $regex: search, $options: 'i' } }
            ];
        }
        
        const products = await Product.find(query).sort({ createdAt: -1 });
        res.render('admin/products', {
            title: 'Manage Products',
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
router.get('/products/add', adminAuth, (req, res) => {
    res.render('admin/product-form', {
        title: 'Add Product',
        product: null,
        action: '/admin/products/add'
    });
});

// Add Product
router.post('/products/add', adminAuth, async (req, res) => {
    try {
        const {
            name, description, price, category, brand,
            images, stock, weight, material, color, size, featured
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
            featured: featured === 'on'
        });
        
        await product.save();
        res.redirect('/admin/products');
    } catch (error) {
        console.error(error);
        res.status(500).send('Error adding product');
    }
});

// Edit Product Form
router.get('/products/edit/:id', adminAuth, async (req, res) => {
    try {
        const product = await Product.findById(req.params.id);
        if (!product) {
            return res.status(404).send('Product not found');
        }
        res.render('admin/product-form', {
            title: 'Edit Product',
            product,
            action: `/admin/products/edit/${product._id}`
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Server Error');
    }
});

// Update Product
router.post('/products/edit/:id', adminAuth, async (req, res) => {
    try {
        const {
            name, description, price, category, brand,
            images, stock, weight, material, color, size, featured
        } = req.body;
        
        await Product.findByIdAndUpdate(req.params.id, {
            name,
            description,
            price: parseFloat(price),
            category,
            brand,
            images: images ? images.split('\n').map(img => img.trim()).filter(img => img) : [],
            stock: parseInt(stock) || 0,
            specifications: { weight, material, color, size },
            featured: featured === 'on'
        });
        
        res.redirect('/admin/products');
    } catch (error) {
        console.error(error);
        res.status(500).send('Error updating product');
    }
});

// Delete Product
router.post('/products/delete/:id', adminAuth, async (req, res) => {
    try {
        await Product.findByIdAndDelete(req.params.id);
        res.redirect('/admin/products');
    } catch (error) {
        console.error(error);
        res.status(500).send('Error deleting product');
    }
});

// Orders List
router.get('/orders', adminAuth, async (req, res) => {
    try {
        const { status } = req.query;
        let query = {};
        
        if (status) query.status = status;
        
        const orders = await Order.find(query).sort({ createdAt: -1 });
        res.render('admin/orders', {
            title: 'Manage Orders',
            orders,
            status: status || ''
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Server Error');
    }
});

// View Order Details
router.get('/orders/:id', adminAuth, async (req, res) => {
    try {
        const order = await Order.findById(req.params.id);
        if (!order) {
            return res.status(404).send('Order not found');
        }
        res.render('admin/order-detail', {
            title: `Order #${order._id.toString().slice(-8).toUpperCase()}`,
            order
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Server Error');
    }
});

// Update Order Status
router.post('/orders/:id/status', adminAuth, async (req, res) => {
    try {
        const { status } = req.body;
        await Order.findByIdAndUpdate(req.params.id, { status });
        res.redirect(`/admin/orders/${req.params.id}`);
    } catch (error) {
        console.error(error);
        res.status(500).send('Error updating order');
    }
});

module.exports = router;
