const express = require('express');
const router = express.Router();
const Product = require('../models/Product');
const Seller = require('../models/Seller');

// Get all products with filters (only from active sellers)
router.get('/', async (req, res) => {
    try {
        const { category, brand, minPrice, maxPrice, sort, search, page } = req.query;
        
        // Pagination settings
        const currentPage = parseInt(page) || 1;
        const perPage = 12; // Products per page
        const skip = (currentPage - 1) * perPage;
        
        // Get IDs of active sellers only
        const activeSellers = await Seller.find({ status: 'active' }).select('_id');
        const activeSellerIds = activeSellers.map(s => s._id);
        
        // Build query - only show products from active sellers
        let query = { seller: { $in: activeSellerIds } };
        
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
        
        // Get total count for pagination
        const totalProducts = await Product.countDocuments(query);
        const totalPages = Math.ceil(totalProducts / perPage);
        
        // Execute query with pagination - populate seller info
        const products = await Product.find(query)
            .populate('seller', 'storeName')
            .sort(sortOption)
            .skip(skip)
            .limit(perPage);
        
        // Add sellerInfo to each product for template
        const productsWithSeller = products.map(p => ({
            ...p.toObject(),
            sellerInfo: p.seller
        }));
        
        // Get all brands for filter
        const allBrands = await Product.distinct('brand');
        
        // Selected brands as array
        const selectedBrands = brand ? (Array.isArray(brand) ? brand : [brand]) : [];
        
        // Helper function to build pagination URLs preserving existing query params
        const buildPaginationUrl = (pageNum) => {
            const params = new URLSearchParams();
            if (category) params.set('category', category);
            if (brand) {
                if (Array.isArray(brand)) {
                    brand.forEach(b => params.append('brand', b));
                } else {
                    params.set('brand', brand);
                }
            }
            if (minPrice) params.set('minPrice', minPrice);
            if (maxPrice) params.set('maxPrice', maxPrice);
            if (sort) params.set('sort', sort);
            if (search) params.set('search', search);
            params.set('page', pageNum);
            return '/products?' + params.toString();
        };
        
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
            // Pagination data
            currentPage,
            totalPages,
            totalProducts,
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

// Get single product
router.get('/:id', async (req, res) => {
    try {
        const product = await Product.findById(req.params.id)
            .populate('seller', 'storeName name');
        
        if (!product) {
            return res.status(404).send('Product not found');
        }
        
        // Get related products (same category, excluding current)
        const relatedProducts = await Product.find({
            category: product.category,
            _id: { $ne: product._id }
        }).populate('seller', 'storeName').limit(4);
        
        // Add sellerInfo to related products
        const relatedProductsWithSeller = relatedProducts.map(p => ({
            ...p.toObject(),
            sellerInfo: p.seller
        }));
        
        res.render('product', {
            title: product.name,
            product: {
                ...product.toObject(),
                sellerInfo: product.seller
            },
            relatedProducts: relatedProductsWithSeller,
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
