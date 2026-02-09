require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
    console.error('❌ Missing MONGODB_URI in environment');
    process.exit(1);
}
mongoose.connect(MONGODB_URI)
    .then(() => {
        console.log('✅ Connected to MongoDB');
    })
    .catch(err => console.error('❌ MongoDB connection error:', err));

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Session middleware
if (!process.env.SESSION_SECRET) {
    console.error('❌ Missing SESSION_SECRET in environment');
    process.exit(1);
}

app.use(session({
    secret: process.env.SESSION_SECRET,
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
// const checkoutRoutes = require('./routes/checkout'); // Removed - using WhatsApp ordering
const apiRoutes = require('./routes/api');
const agentRoutes = require('./routes/agent');
const adminRoutes = require('./routes/admin');
const sellerRoutes = require('./routes/seller');
const storeRoutes = require('./routes/store');
const whatsappRoutes = require('./routes/whatsapp-n8n');
const productsRoutes = require('./routes/products');
const n8nRoutes = require('./routes/n8n'); // Import new route

app.use('/', indexRoutes);
app.use('/products', productRoutes);
// app.use('/checkout', checkoutRoutes); // Removed - using WhatsApp ordering
app.use('/api', apiRoutes);
app.use('/api/agent', agentRoutes);
app.use('/admin', adminRoutes);
app.use('/seller', sellerRoutes);
app.use('/store', storeRoutes);
app.use('/whatsapp', whatsappRoutes);
app.use('/products', productsRoutes);
app.use('/api/n8n', n8nRoutes); // Use new route

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

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down gracefully...');
    await mongoose.connection.close();
    process.exit(0);
});