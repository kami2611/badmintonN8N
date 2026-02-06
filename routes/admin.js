const express = require('express');
const router = express.Router();
const Product = require('../models/Product');
const Order = require('../models/Order');
const Seller = require('../models/Seller');

// Admin auth middleware - checks session
const adminAuth = (req, res, next) => {
    if (req.session && req.session.isAdmin) {
        next();
    } else {
        res.redirect('/admin/login');
    }
};

// Admin Logout
router.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('Error destroying session:', err);
        }
        res.redirect('/');
    });
});

// Admin Login Page
router.get('/login', (req, res) => {
    if (req.session && req.session.isAdmin) {
        return res.redirect('/admin');
    }
    res.render('admin/login', { 
        title: 'Admin Login',
        error: null 
    });
});

// Admin Login
router.post('/login', (req, res) => {
    const { username, password } = req.body;
    
    if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
        req.session.isAdmin = true;
        req.session.adminUsername = username;
        res.redirect('/admin');
    } else {
        res.render('admin/login', {
            title: 'Admin Login',
            error: 'Invalid username or password'
        });
    }
});

// Admin Logout
router.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/admin/login');
});

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
        
        // Featured counts
        const featuredProducts = await Product.countDocuments({ featured: true });
        
        // Seller stats by status
        const totalSellers = await Seller.countDocuments();
        const pendingSellers = await Seller.countDocuments({ status: 'pending' });
        const activeSellers = await Seller.countDocuments({ status: 'active' });
        const deactivatedSellers = await Seller.countDocuments({ status: 'deactivated' });
        const featuredSellers = await Seller.countDocuments({ featured: true });
        
        // Get pending sellers for quick action
        const pendingSellersList = await Seller.find({ status: 'pending' })
            .sort({ createdAt: -1 })
            .limit(5);
        
        res.render('admin/dashboard', {
            title: 'Admin Dashboard',
            stats: {
                totalProducts,
                totalOrders,
                pendingOrders,
                totalRevenue,
                rackets,
                shoes,
                accessories,
                featuredProducts,
                totalSellers,
                pendingSellers,
                activeSellers,
                deactivatedSellers,
                featuredSellers
            },
            recentOrders,
            pendingSellersList
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Server Error');
    }
});

// Products List
router.get('/products', adminAuth, async (req, res) => {
    try {
        const { search } = req.query;
        let query = {};
        
        if (search) {
            query.description = { $regex: search, $options: 'i' };
        }
        
        const products = await Product.find(query).populate('seller', 'storeName').sort({ createdAt: -1 });
        res.render('admin/products', {
            title: 'Manage Products',
            products,
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
        const product = await Product.findById(req.params.id).populate('seller', 'storeName');
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
        const { description, featured } = req.body;
        
        await Product.findByIdAndUpdate(req.params.id, {
            description,
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

// Toggle Product Featured Status
router.post('/products/:id/toggle-featured', adminAuth, async (req, res) => {
    try {
        const product = await Product.findById(req.params.id);
        if (!product) {
            return res.status(404).send('Product not found');
        }
        
        product.featured = !product.featured;
        await product.save();
        
        // Check if request is AJAX
        if (req.xhr || req.headers.accept.indexOf('json') > -1) {
            return res.json({ success: true, featured: product.featured });
        }
        
        res.redirect('/admin/products');
    } catch (error) {
        console.error(error);
        res.status(500).send('Error updating product');
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

// ==================== SELLER MANAGEMENT ====================

// Sellers List
router.get('/sellers', adminAuth, async (req, res) => {
    try {
        const { search, status } = req.query;
        let query = {};
        
        if (search) {
            query.$or = [
                { name: { $regex: search, $options: 'i' } },
                { storeName: { $regex: search, $options: 'i' } },
                { phone: { $regex: search, $options: 'i' } }
            ];
        }
        
        // Filter by status (pending, active, deactivated)
        if (status && ['pending', 'active', 'deactivated'].includes(status)) {
            query.status = status;
        }
        
        const sellers = await Seller.find(query).sort({ createdAt: -1 });
        
        // Get product count for each seller
        const sellersWithStats = await Promise.all(sellers.map(async (seller) => {
            const productCount = await Product.countDocuments({ seller: seller._id });
            return {
                ...seller.toObject(),
                productCount
            };
        }));
        
        // Get counts for each status
        const statusCounts = {
            all: await Seller.countDocuments(),
            pending: await Seller.countDocuments({ status: 'pending' }),
            active: await Seller.countDocuments({ status: 'active' }),
            deactivated: await Seller.countDocuments({ status: 'deactivated' })
        };
        
        res.render('admin/sellers', {
            title: 'Manage Sellers',
            sellers: sellersWithStats,
            search: search || '',
            status: status || '',
            statusCounts
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Server Error');
    }
});

// View Seller Details
router.get('/sellers/:id', adminAuth, async (req, res) => {
    try {
        const seller = await Seller.findById(req.params.id);
        if (!seller) {
            return res.status(404).send('Seller not found');
        }
        
        const products = await Product.find({ seller: seller._id }).sort({ createdAt: -1 });
        const productIds = products.map(p => p._id);
        
        // Get orders containing seller's products
        const orders = await Order.find({ 'items.product': { $in: productIds } });
        let totalRevenue = 0;
        orders.forEach(order => {
            order.items.forEach(item => {
                if (productIds.some(id => id.equals(item.product))) {
                    totalRevenue += item.price * item.quantity;
                }
            });
        });
        
        res.render('admin/seller-detail', {
            title: seller.storeName,
            seller,
            products,
            stats: {
                totalProducts: products.length,
                totalOrders: orders.length,
                totalRevenue
            }
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Server Error');
    }
});

// Toggle Seller Status (activate/deactivate)
router.post('/sellers/:id/toggle-status', adminAuth, async (req, res) => {
    try {
        const seller = await Seller.findById(req.params.id);
        if (!seller) {
            return res.status(404).send('Seller not found');
        }
        
        // Toggle between active and deactivated
        seller.status = seller.status === 'active' ? 'deactivated' : 'active';
        await seller.save();
        
        res.redirect(`/admin/sellers/${req.params.id}`);
    } catch (error) {
        console.error(error);
        res.status(500).send('Error updating seller');
    }
});

// Approve Seller (change from pending to active)
router.post('/sellers/:id/approve', adminAuth, async (req, res) => {
    try {
        const seller = await Seller.findById(req.params.id);
        if (!seller) {
            if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
                return res.status(404).json({ success: false, message: 'Seller not found' });
            }
            return res.status(404).send('Seller not found');
        }
        
        seller.status = 'active';
        await seller.save();
        
        if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
            return res.json({ success: true, status: seller.status });
        }
        
        res.redirect(req.get('Referer') || '/admin/sellers');
    } catch (error) {
        console.error(error);
        if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
            return res.status(500).json({ success: false, message: 'Error approving seller' });
        }
        res.status(500).send('Error approving seller');
    }
});

// Reject/Delete Seller (remove pending seller)
router.post('/sellers/:id/reject', adminAuth, async (req, res) => {
    try {
        const seller = await Seller.findById(req.params.id);
        if (!seller) {
            if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
                return res.status(404).json({ success: false, message: 'Seller not found' });
            }
            return res.status(404).send('Seller not found');
        }
        
        // Delete seller's products
        await Product.deleteMany({ seller: req.params.id });
        // Delete seller
        await Seller.findByIdAndDelete(req.params.id);
        
        if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
            return res.json({ success: true });
        }
        
        res.redirect('/admin/sellers');
    } catch (error) {
        console.error(error);
        if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
            return res.status(500).json({ success: false, message: 'Error rejecting seller' });
        }
        res.status(500).send('Error rejecting seller');
    }
});

// Deactivate Seller
router.post('/sellers/:id/deactivate', adminAuth, async (req, res) => {
    try {
        const seller = await Seller.findById(req.params.id);
        if (!seller) {
            if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
                return res.status(404).json({ success: false, message: 'Seller not found' });
            }
            return res.status(404).send('Seller not found');
        }
        
        seller.status = 'deactivated';
        await seller.save();
        
        if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
            return res.json({ success: true, status: seller.status });
        }
        
        res.redirect(req.get('Referer') || `/admin/sellers/${req.params.id}`);
    } catch (error) {
        console.error(error);
        if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
            return res.status(500).json({ success: false, message: 'Error deactivating seller' });
        }
        res.status(500).send('Error deactivating seller');
    }
});

// Toggle Seller Featured Status
router.post('/sellers/:id/toggle-featured', adminAuth, async (req, res) => {
    try {
        const seller = await Seller.findById(req.params.id);
        if (!seller) {
            return res.status(404).send('Seller not found');
        }
        
        seller.featured = !seller.featured;
        await seller.save();
        
        // Check if request is AJAX
        if (req.xhr || req.headers.accept.indexOf('json') > -1) {
            return res.json({ success: true, featured: seller.featured });
        }
        
        res.redirect(`/admin/sellers/${req.params.id}`);
    } catch (error) {
        console.error(error);
        res.status(500).send('Error updating seller');
    }
});

// Delete Seller (and optionally their products)
router.post('/sellers/:id/delete', adminAuth, async (req, res) => {
    try {
        const { deleteProducts } = req.body;
        
        if (deleteProducts === 'on') {
            await Product.deleteMany({ seller: req.params.id });
        } else {
            // Unlink products from seller
            await Product.updateMany({ seller: req.params.id }, { $unset: { seller: 1 } });
        }
        
        await Seller.findByIdAndDelete(req.params.id);
        res.redirect('/admin/sellers');
    } catch (error) {
        console.error(error);
        res.status(500).send('Error deleting seller');
    }
});

module.exports = router;
