const express = require('express');
const router = express.Router();
const Product = require('../models/Product');

// Landing page
router.get('/', async (req, res) => {
    try {
        const featuredProducts = await Product.find({ featured: true })
            .populate('seller', 'storeName')
            .limit(8);
        
        const productsWithSeller = featuredProducts.map(p => ({
            ...p.toObject(),
            sellerInfo: p.seller
        }));
        
        const cartCount = 0; // Will be handled by client-side JS
        res.render('index', { 
            title: 'Home',
            featuredProducts: productsWithSeller,
            cartCount,
            user: req.session.isAdmin ? { isAdmin: true, name: 'Admin' } : 
                  req.session.sellerId ? { isSeller: true, name: req.session.sellerName, storeName: req.session.storeName } : 
                  null
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Server Error');
    }
});

// Login page
router.get('/login', (req, res) => {
    res.render('login', { title: 'Login', cartCount: 0 });
});

// Signup page
router.get('/signup', (req, res) => {
    res.render('signup', { title: 'Sign Up', cartCount: 0 });
});

// Handle login (placeholder)
router.post('/login', (req, res) => {
    // In a real app, you'd verify credentials here
    res.redirect('/');
});

// Handle signup (placeholder)
router.post('/signup', (req, res) => {
    // In a real app, you'd create user here
    res.redirect('/login');
});

module.exports = router;
