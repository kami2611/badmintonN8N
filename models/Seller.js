const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const sellerSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    email: {
        type: String,
        trim: true,
        lowercase: true,
        sparse: true
    },
    phone: {
        type: String,
        required: true,
        unique: true
    },
    password: {
        type: String,
        required: true
    },
    storeName: {
        type: String,
        required: true,
        trim: true
    },
    onboardingStep: {
        type: String,
        enum: ['new', 'name_entered', 'complete'],
        default: 'complete' // Existing web users are already complete
    },
    // Status: pending (awaiting admin approval), active (approved), deactivated (disabled by admin)
    status: {
        type: String,
        enum: ['pending', 'active', 'deactivated'],
        default: 'pending'
    },
    // Keep isActive for backward compatibility (computed from status)
    isActive: {
        type: Boolean,
        default: false
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

// Pre-save hook to sync isActive with status
sellerSchema.pre('save', async function(next) {
    // Sync isActive based on status
    this.isActive = this.status === 'active';
    
    // Hash password if modified
    if (this.isModified('password')) {
        this.password = await bcrypt.hash(this.password, 10);
    }
    next();
});

// Compare password method
sellerSchema.methods.comparePassword = async function(candidatePassword) {
    return await bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('Seller', sellerSchema);
