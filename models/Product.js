const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    description: {
        type: String,
        default: ''
    },
    price: {
        type: Number,
        required: true,
        min: 0
    },
    category: {
        type: String,
        required: true,
        enum: ['rackets', 'shoes', 'accessories', 'apparel', 'bags', 'shuttles']
    },
    brand: {
        type: String,
        default: ''
    },
    images: [{
        type: String
    }],
    video: {
        url: String,
        publicId: String
    },
    stock: {
        type: Number,
        default: 1,
        min: 0
    },
    // Condition for used items
    condition: {
        type: String,
        enum: ['new', 'used'],
        default: 'new'
    },
    conditionRating: {
        type: Number,
        min: 1,
        max: 10,
        default: 10
    },
    // Common specifications
    specifications: {
        weight: String,
        material: String,
        color: String,
        size: String
    },
    // Racket-specific fields
    racketSpecs: {
        flexibility: {
            type: String,
            enum: ['extra-stiff', 'stiff', 'medium', 'flexible', '']
        },
        balance: {
            type: String,
            enum: ['head-heavy', 'even', 'head-light', '']
        },
        weightClass: {
            type: String,
            enum: ['2U', '3U', '4U', '5U', '']
        },
        gripSize: {
            type: String,
            enum: ['G4', 'G5', 'G6', 'G7', '']
        },
        stringTension: String,
        frameMaterial: String,
        maxTension: String,
        stringStatus: {
            type: String,
            enum: ['strung', 'unstrung', '']
        }
    },
    // Shoe-specific fields
    shoeSpecs: {
        sizeEU: String,
        sizeUS: String,
        sizeUK: String,
        width: {
            type: String,
            enum: ['narrow', 'standard', 'wide', '']
        },
        soleType: String,
        closureType: {
            type: String,
            enum: ['lace-up', 'velcro', 'slip-on', '']
        }
    },
    // Bag-specific fields
    bagSpecs: {
        capacity: {
            type: String,
            enum: ['3-racket', '6-racket', '9-racket', '12-racket', '']
        },
        bagType: {
            type: String,
            enum: ['backpack', 'duffel', 'thermal', 'tote', '']
        },
        compartments: Number,
        hasShoeCompartment: Boolean,
        hasThermalLining: Boolean
    },
    // Apparel-specific fields
    apparelSpecs: {
        apparelType: {
            type: String,
            enum: ['t-shirt', 'polo', 'shorts', 'skirt', 'jacket', 'tracksuit', '']
        },
        apparelSize: {
            type: String,
            enum: ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '']
        },
        gender: {
            type: String,
            enum: ['men', 'women', 'unisex', '']
        },
        fabricType: String
    },
    // Shuttle-specific fields
    shuttleSpecs: {
        shuttleType: {
            type: String,
            enum: ['feather', 'nylon', '']
        },
        speed: {
            type: String,
            enum: ['75', '76', '77', '78', '79', '']
        },
        quantityPerTube: Number,
        grade: String
    },
    // Accessory-specific fields
    accessorySpecs: {
        accessoryType: {
            type: String,
            enum: ['grip', 'string', 'towel', 'wristband', 'headband', 'socks', 'other', '']
        },
        packQuantity: Number
    },
    featured: {
        type: Boolean,
        default: false
    },
    seller: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Seller'
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model('Product', productSchema);
