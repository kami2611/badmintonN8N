const express = require('express');
const router = express.Router();
const Product = require('../models/Product');
const Order = require('../models/Order');

// Checkout page
router.get('/', (req, res) => {
    res.render('checkout', {
        title: 'Checkout',
        cartCount: 0
    });
});

// Process checkout
router.post('/', async (req, res) => {
    try {
        const {
            firstName,
            lastName,
            email,
            street,
            city,
            state,
            zipCode,
            country,
            paymentMethod,
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
        
        // Add shipping if applicable
        if (totalAmount < 100) {
            totalAmount += 9.99;
        }
        
        // Create order
        const order = new Order({
            guestEmail: email,
            items,
            shippingAddress: {
                firstName,
                lastName,
                street,
                city,
                state,
                zipCode,
                country
            },
            totalAmount,
            paymentMethod: paymentMethod || 'cod'
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
