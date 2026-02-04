const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');

// Configure Cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME || process.env.cloudname || process.env.CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY || process.env.apikey || process.env.API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET || process.env.apisecret || process.env.API_SECRET
});

// Storage for images
const imageStorage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'badminton-store/products',
        allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
        transformation: [{ width: 1200, height: 1200, crop: 'limit', quality: 'auto' }],
        resource_type: 'image'
    }
});

// Storage for videos
const videoStorage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'badminton-store/videos',
        allowed_formats: ['mp4', 'mov', 'webm'],
        resource_type: 'video'
    }
});

// File filter for images
const imageFilter = (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
        cb(null, true);
    } else {
        cb(new Error('Only image files are allowed!'), false);
    }
};

// File filter for videos
const videoFilter = (req, file, cb) => {
    if (file.mimetype.startsWith('video/')) {
        cb(null, true);
    } else {
        cb(new Error('Only video files are allowed!'), false);
    }
};

// Multer upload for images (max 5, max 2MB each)
const uploadImages = multer({
    storage: imageStorage,
    limits: {
        fileSize: 2 * 1024 * 1024, // 2MB
        files: 5
    },
    fileFilter: imageFilter
});

// Multer upload for videos (max 1, max 50MB - will validate duration on client)
const uploadVideo = multer({
    storage: videoStorage,
    limits: {
        fileSize: 50 * 1024 * 1024, // 50MB max for video file
        files: 1
    },
    fileFilter: videoFilter
});

// Combined upload middleware
const uploadProductMedia = multer({
    storage: multer.memoryStorage(), // Use memory storage for custom handling
    limits: {
        fileSize: 50 * 1024 * 1024 // 50MB max
    },
    fileFilter: (req, file, cb) => {
        if (file.fieldname === 'images') {
            if (file.mimetype.startsWith('image/')) {
                cb(null, true);
            } else {
                cb(new Error('Only image files are allowed for images field!'), false);
            }
        } else if (file.fieldname === 'video') {
            if (file.mimetype.startsWith('video/')) {
                cb(null, true);
            } else {
                cb(new Error('Only video files are allowed for video field!'), false);
            }
        } else {
            cb(new Error('Unexpected field'), false);
        }
    }
});

// Helper function to upload buffer to cloudinary
const uploadToCloudinary = (buffer, options) => {
    return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
            options,
            (error, result) => {
                if (error) reject(error);
                else resolve(result);
            }
        );
        uploadStream.end(buffer);
    });
};

// Helper function to delete from cloudinary
const deleteFromCloudinary = async (publicId, resourceType = 'image') => {
    try {
        await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
    } catch (error) {
        console.error('Error deleting from Cloudinary:', error);
    }
};

// Extract public ID from Cloudinary URL
const getPublicIdFromUrl = (url) => {
    if (!url) return null;
    const matches = url.match(/\/v\d+\/(.+)\.\w+$/);
    return matches ? matches[1] : null;
};

module.exports = {
    cloudinary,
    uploadImages,
    uploadVideo,
    uploadProductMedia,
    uploadToCloudinary,
    deleteFromCloudinary,
    getPublicIdFromUrl
};
