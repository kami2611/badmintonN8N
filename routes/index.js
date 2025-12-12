const express = require('express');
const router = express.Router();
const Product = require('../models/Product');
const Seller = require('../models/Seller');

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
        
        // Fetch featured sellers with their product counts
        const featuredSellers = await Seller.find({ featured: true, isActive: true }).limit(6);
        const sellersWithStats = await Promise.all(featuredSellers.map(async (seller) => {
            const productCount = await Product.countDocuments({ seller: seller._id });
            return {
                ...seller.toObject(),
                productCount
            };
        }));
        
        const cartCount = 0; // Will be handled by client-side JS
        res.render('index', { 
            title: 'Home',
            featuredProducts: productsWithSeller,
            featuredSellers: sellersWithStats,
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

// All Stores page
router.get('/stores', async (req, res) => {
    try {
        const { search, sort, page } = req.query;
        
        // Pagination settings
        const currentPage = parseInt(page) || 1;
        const perPage = 12;
        const skip = (currentPage - 1) * perPage;
        
        // Build query
        let query = { isActive: true };
        
        if (search) {
            query.$or = [
                { storeName: { $regex: search, $options: 'i' } },
                { name: { $regex: search, $options: 'i' } }
            ];
        }
        
        // Build sort
        let sortOption = {};
        switch (sort) {
            case 'name_asc':
                sortOption = { storeName: 1 };
                break;
            case 'name_desc':
                sortOption = { storeName: -1 };
                break;
            case 'newest':
                sortOption = { createdAt: -1 };
                break;
            case 'oldest':
                sortOption = { createdAt: 1 };
                break;
            case 'featured':
                sortOption = { featured: -1, createdAt: -1 };
                break;
            default:
                sortOption = { featured: -1, createdAt: -1 };
        }
        
        // Get total count
        const totalStores = await Seller.countDocuments(query);
        const totalPages = Math.ceil(totalStores / perPage);
        
        // Fetch stores with pagination
        const stores = await Seller.find(query)
            .sort(sortOption)
            .skip(skip)
            .limit(perPage);
        
        // Get product counts for each store
        const storesWithStats = await Promise.all(stores.map(async (seller) => {
            const productCount = await Product.countDocuments({ seller: seller._id });
            return {
                ...seller.toObject(),
                productCount
            };
        }));
        
        // Helper function to build pagination URLs
        const buildPaginationUrl = (pageNum) => {
            const params = new URLSearchParams();
            if (search) params.set('search', search);
            if (sort) params.set('sort', sort);
            params.set('page', pageNum);
            return '/stores?' + params.toString();
        };
        
        res.render('stores', {
            title: 'All Stores',
            stores: storesWithStats,
            search: search || '',
            sort: sort || '',
            currentPage,
            totalPages,
            totalStores,
            perPage,
            buildPaginationUrl,
            cartCount: 0,
            user: req.session.isAdmin ? { isAdmin: true, name: 'Admin' } : 
                  req.session.sellerId ? { isSeller: true, name: req.session.sellerName, storeName: req.session.storeName } : 
                  null
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Server Error');
    }
});

module.exports = router;
