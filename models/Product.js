const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    description: {
        type: String,
        required: true
    },
    price: {
        type: Number,
        required: true,
        min: 0
    },
    category: {
        type: String,
        required: true,
        enum: ['rackets', 'shoes', 'accessories']
    },
    brand: {
        type: String,
        required: true
    },
    images: [{
        type: String
    }],
    stock: {
        type: Number,
        default: 0,
        min: 0
    },
    specifications: {
        weight: String,
        material: String,
        color: String,
        size: String
    },
    featured: {
        type: Boolean,
        default: false
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model('Product', productSchema);
