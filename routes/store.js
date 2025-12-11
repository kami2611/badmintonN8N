const express = require('express');
const router = express.Router();
const Seller = require('../models/Seller');
const Product = require('../models/Product');

// View seller store
router.get('/:id', async (req, res) => {
    try {
        const seller = await Seller.findById(req.params.id);
        
        if (!seller) {
            return res.status(404).send('Store not found');
        }
        
        if (!seller.isActive) {
            return res.status(403).send('This store is currently unavailable');
        }
        
        // Get seller's products
        const products = await Product.find({ seller: seller._id })
            .populate('seller', 'storeName')
            .sort({ createdAt: -1 });
        
        const productsWithSeller = products.map(p => ({
            ...p.toObject(),
            sellerInfo: p.seller
        }));
        
        // Get category counts
        const rackets = await Product.countDocuments({ seller: seller._id, category: 'rackets' });
        const shoes = await Product.countDocuments({ seller: seller._id, category: 'shoes' });
        const accessories = await Product.countDocuments({ seller: seller._id, category: 'accessories' });
        
        res.render('store', {
            title: seller.storeName,
            seller,
            products: productsWithSeller,
            stats: {
                totalProducts: products.length,
                rackets,
                shoes,
                accessories
            },
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
