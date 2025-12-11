require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/badminton_store';
mongoose.connect(MONGODB_URI)
    .then(() => console.log('Connected to MongoDB'))
    .catch(err => console.error('MongoDB connection error:', err));

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Session middleware
app.use(session({
    secret: process.env.SESSION_SECRET || 'badminton-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: false,
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// Routes
const indexRoutes = require('./routes/index');
const productRoutes = require('./routes/products');
const checkoutRoutes = require('./routes/checkout');
const apiRoutes = require('./routes/api');
const adminRoutes = require('./routes/admin');
const sellerRoutes = require('./routes/seller');
const storeRoutes = require('./routes/store');

app.use('/', indexRoutes);
app.use('/products', productRoutes);
app.use('/checkout', checkoutRoutes);
app.use('/api', apiRoutes);
app.use('/admin', adminRoutes);
app.use('/seller', sellerRoutes);
app.use('/store', storeRoutes);

// 404 handler
app.use((req, res) => {
    res.status(404).send('Page not found');
});

// Error handling
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('Something went wrong!');
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});