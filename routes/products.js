const express = require('express');
const router = express.Router();
const Product = require('../models/Product');

// Get all products with filters
router.get('/', async (req, res) => {
    try {
        const { category, brand, minPrice, maxPrice, sort, search } = req.query;
        
        // Build query
        let query = {};
        
        if (category) {
            query.category = category;
        }
        
        if (brand) {
            const brands = Array.isArray(brand) ? brand : [brand];
            query.brand = { $in: brands };
        }
        
        if (minPrice || maxPrice) {
            query.price = {};
            if (minPrice) query.price.$gte = parseFloat(minPrice);
            if (maxPrice) query.price.$lte = parseFloat(maxPrice);
        }
        
        if (search) {
            query.$or = [
                { name: { $regex: search, $options: 'i' } },
                { description: { $regex: search, $options: 'i' } },
                { brand: { $regex: search, $options: 'i' } }
            ];
        }
        
        // Build sort
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
        
        // Execute query - populate seller info
        const products = await Product.find(query)
            .populate('seller', 'storeName')
            .sort(sortOption);
        
        // Add sellerInfo to each product for template
        const productsWithSeller = products.map(p => ({
            ...p.toObject(),
            sellerInfo: p.seller
        }));
        
        // Get all brands for filter
        const allBrands = await Product.distinct('brand');
        
        // Selected brands as array
        const selectedBrands = brand ? (Array.isArray(brand) ? brand : [brand]) : [];
        
        res.render('products', {
            title: 'Products',
            products: productsWithSeller,
            brands: allBrands,
            selectedBrands,
            category: category || '',
            minPrice: minPrice || '',
            maxPrice: maxPrice || '',
            sort: sort || '',
            search: search || '',
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

// Get single product
router.get('/:id', async (req, res) => {
    try {
        const product = await Product.findById(req.params.id);
        
        if (!product) {
            return res.status(404).send('Product not found');
        }
        
        // Get related products (same category, excluding current)
        const relatedProducts = await Product.find({
            category: product.category,
            _id: { $ne: product._id }
        }).limit(4);
        
        res.render('product', {
            title: product.name,
            product,
            relatedProducts,
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
