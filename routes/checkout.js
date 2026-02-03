const express = require('express');
const router = express.Router();
const Product = require('../models/Product');
const Order = require('../models/Order');

// Checkout page
router.get('/', (req, res) => {
    res.render('checkout', {
        title: 'Checkout',
        cartCount: 0,
        user: req.session.isAdmin ? { isAdmin: true, name: 'Admin' } : 
              req.session.sellerId ? { isSeller: true, name: req.session.sellerName, storeName: req.session.storeName } : 
              null
    });
});

// Process checkout
router.post('/', async (req, res) => {
    try {
        const {
            firstName,
            lastName,
            email,
            phone,
            street,
            apt,
            city,
            state,
            zipCode,
            country,
            shipping,
            paymentMethod,
            orderNotes,
            cartItems
        } = req.body;
        
        // Parse cart items
        let items = [];
        let totalAmount = 0;
        
        if (cartItems) {
            const parsedCart = JSON.parse(cartItems);
            
            for (const item of parsedCart) {
                const product = await Product.findById(item._id);
                if (product) {
                    items.push({
                        product: product._id,
                        name: product.name,
                        price: product.price,
                        quantity: item.quantity
                    });
                    totalAmount += product.price * item.quantity;
                }
            }
        }
        
        if (items.length === 0) {
            return res.redirect('/checkout');
        }
        
        // Add shipping cost based on selection
        let shippingCost = 0;
        if (shipping === 'express') {
            shippingCost = 12.99;
        } else if (shipping === 'standard' && totalAmount < 100) {
            shippingCost = 5.99;
        }
        // Free shipping if order >= $100 or if 'free' selected and qualified
        totalAmount += shippingCost;
        
        // Create order
        const order = new Order({
            guestEmail: email,
            guestPhone: phone,
            items,
            shippingAddress: {
                firstName,
                lastName,
                street,
                apt: apt || '',
                city,
                state,
                zipCode,
                country
            },
            totalAmount,
            shippingCost,
            paymentMethod: paymentMethod || 'cod',
            orderNotes: orderNotes || ''
        });
        
        await order.save();
        
        res.render('order-confirmation', {
            title: 'Order Confirmed',
            order,
            cartCount: 0
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Error processing order');
    }
});

module.exports = router;
