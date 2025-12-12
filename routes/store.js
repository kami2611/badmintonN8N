const express = require('express');
const router = express.Router();
const Seller = require('../models/Seller');
const Product = require('../models/Product');

// View seller store
router.get('/:id', async (req, res) => {
    try {
        const { category, sort } = req.query;
        const seller = await Seller.findById(req.params.id);
        
        if (!seller) {
            return res.status(404).send('Store not found');
        }
        
        if (!seller.isActive) {
            return res.status(403).send('This store is currently unavailable');
        }
        
        // Build query for seller's products
        let query = { seller: seller._id };
        if (category) {
            query.category = category;
        }
        
        // Build sort option
        let sortOption = {};
        switch (sort) {
            case 'price_asc':
                sortOption = { price: 1 };
                break;
            case 'price_desc':
                sortOption = { price: -1 };
                break;
            case 'name_asc':
                sortOption = { name: 1 };
                break;
            case 'name_desc':
                sortOption = { name: -1 };
                break;
            case 'featured':
                sortOption = { featured: -1, createdAt: -1 };
                break;
            default:
                sortOption = { createdAt: -1 };
        }
        
        // Get seller's products with filters
        const products = await Product.find(query)
            .populate('seller', 'storeName')
            .sort(sortOption);
        
        const productsWithSeller = products.map(p => ({
            ...p.toObject(),
            sellerInfo: p.seller
        }));
        
        // Get category counts (always from all products for stats)
        const rackets = await Product.countDocuments({ seller: seller._id, category: 'rackets' });
        const shoes = await Product.countDocuments({ seller: seller._id, category: 'shoes' });
        const accessories = await Product.countDocuments({ seller: seller._id, category: 'accessories' });
        const totalProducts = rackets + shoes + accessories;
        
        // Get featured products count
        const featuredCount = await Product.countDocuments({ seller: seller._id, featured: true });
        
        res.render('store', {
            title: seller.storeName,
            seller,
            products: productsWithSeller,
            stats: {
                totalProducts,
                rackets,
                shoes,
                accessories,
                featuredCount
            },
            category: category || '',
            sort: sort || '',
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
