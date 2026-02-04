/**
 * WhatsApp Webhook Route - LangGraph Version
 * Uses LangGraph for conversation management with MongoDB persistence
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const Seller = require('../models/Seller');
const Product = require('../models/Product');
const bcrypt = require('bcrypt');
const { uploadToCloudinary, deleteFromCloudinary, getPublicIdFromUrl } = require('../config/cloudinary');

// Import LangGraph agent
const { processUserMessage, resetUserState } = require('../services/langgraph');

// In-memory store for pending media uploads (short-lived, OK to be in-memory)
const pendingMediaUploads = new Map();

// Constants
const MAX_IMAGES = 5;
const MAX_IMAGE_SIZE = 2 * 1024 * 1024; // 2MB
const MAX_VIDEO_DURATION = 20; // seconds

// ============ Webhook Endpoints ============

/**
 * Verification Endpoint (GET)
 */
router.get('/webhook', (req, res) => {
    console.log('🔔 [WEBHOOK GET] Verification request received');
    
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
            console.log('✅ [WEBHOOK GET] WEBHOOK_VERIFIED');
            res.status(200).send(challenge);
        } else {
            console.log('❌ [WEBHOOK GET] Verification failed');
            res.sendStatus(403);
        }
    } else {
        res.sendStatus(400);
    }
});

/**
 * Message Receiver (POST)
 */
router.post('/webhook', async (req, res) => {
    console.log('\n========== INCOMING WEBHOOK ==========');
    
    const body = req.body;

    if (body.object) {
        // Check if this is a status update (not a message)
        if (body.entry?.[0]?.changes?.[0]?.value?.statuses) {
            console.log('📊 [WEBHOOK] Status update received');
            res.sendStatus(200);
            return;
        }
        
        if (
            body.entry &&
            body.entry[0].changes &&
            body.entry[0].changes[0].value.messages &&
            body.entry[0].changes[0].value.messages[0]
        ) {
            const messageObj = body.entry[0].changes[0].value.messages[0];
            const from = messageObj.from;
            const msgType = messageObj.type;

            console.log('📱 [WEBHOOK] From:', from, 'Type:', msgType);

            try {
                if (msgType === 'text') {
                    await handleTextMessage(from, messageObj.text.body);
                } else if (msgType === 'image') {
                    await handleImageMessage(from, messageObj.image.id, messageObj.image.mime_type);
                } else if (msgType === 'video') {
                    await handleVideoMessage(from, messageObj.video.id, messageObj.video.mime_type);
                }
            } catch (error) {
                console.error('❌ [WEBHOOK] Error:', error);
            }
        }
        
        res.sendStatus(200);
    } else {
        res.sendStatus(404);
    }
});

// ============ Message Handlers ============

/**
 * Handle incoming text messages
 */
async function handleTextMessage(phone, text) {
    console.log('💬 [TEXT] Processing:', text);
    
    try {
        // Find or create seller
        let seller = await Seller.findOne({ phone: phone });
        
        // New user - start onboarding
        if (!seller) {
            const dummyPassword = await bcrypt.hash(Date.now().toString(), 10);
            seller = new Seller({
                phone: phone,
                name: 'Pending',
                storeName: 'Pending',
                password: dummyPassword,
                onboardingStep: 'new'
            });
            await seller.save();
            
            await sendMessage(phone, 
                "Welcome to Badminton Store Manager! 🏸\n\n" +
                "I see you are new here. Let's get you set up.\n\n" +
                "First, what is your *Full Name*?"
            );
            return;
        }
        
        // Onboarding: Get name
        if (seller.onboardingStep === 'new') {
            seller.name = text;
            seller.onboardingStep = 'name_entered';
            await seller.save();
            
            await sendMessage(phone, 
                `Nice to meet you, ${text}! 👋\n\n` +
                "Now, what is the name of your *Store*?"
            );
            return;
        }
        
        // Onboarding: Get store name
        if (seller.onboardingStep === 'name_entered') {
            seller.storeName = text;
            seller.onboardingStep = 'complete';
            await seller.save();
            
            await sendMessage(phone, 
                `Awesome! Your store *${text}* is now registered. 🎉\n\n` +
                "You can now manage your inventory. Try:\n" +
                "• \"Add a new Yonex Astrox 88D racket for 25000\"\n" +
                "• \"List my products\"\n" +
                "• \"Help\" for all commands\n\n" +
                "I'll help you every step of the way!"
            );
            return;
        }
        
        // Fully registered - use LangGraph agent
        if (seller.onboardingStep === 'complete') {
            const result = await processUserMessage(phone, text, seller._id.toString());
            
            // Check if agent wants us to wait for images/video
            if (result.actionResult) {
                if (result.actionResult.action === 'AWAIT_IMAGES') {
                    pendingMediaUploads.set(phone, {
                        type: 'image',
                        productId: result.actionResult.productId,
                        expiresAt: Date.now() + 5 * 60 * 1000
                    });
                } else if (result.actionResult.action === 'AWAIT_VIDEO') {
                    pendingMediaUploads.set(phone, {
                        type: 'video',
                        productId: result.actionResult.productId,
                        expiresAt: Date.now() + 5 * 60 * 1000
                    });
                }
            }
            
            await sendMessage(phone, result.response);
        }
        
    } catch (error) {
        console.error('❌ [TEXT] Error:', error);
        await sendMessage(phone, "Sorry, I encountered an error. Please try again.");
    }
}

/**
 * Handle incoming image messages
 */
async function handleImageMessage(phone, imageId, mimeType) {
    console.log('🖼️ [IMAGE] Processing image');
    
    try {
        const seller = await Seller.findOne({ phone: phone });
        
        if (!seller || seller.onboardingStep !== 'complete') {
            await sendMessage(phone, "Please complete your registration first.");
            return;
        }
        
        // Check for pending image upload
        const pending = pendingMediaUploads.get(phone);
        
        if (!pending || pending.type !== 'image' || Date.now() > pending.expiresAt) {
            await sendMessage(phone, 
                "📷 I received your image, but I don't know which product to add it to.\n\n" +
                "Say something like:\n" +
                "• \"Add images to [product name]\"\n" +
                "• \"Upload photos for [product name]\""
            );
            return;
        }
        
        // Find the product
        const product = await Product.findOne({ _id: pending.productId, seller: seller._id });
        
        if (!product) {
            pendingMediaUploads.delete(phone);
            await sendMessage(phone, "❌ Product not found. Please try again.");
            return;
        }
        
        // Check image limit
        if (product.images.length >= MAX_IMAGES) {
            await sendMessage(phone, 
                `❌ This product already has ${MAX_IMAGES} images (maximum).\n\n` +
                `To add more, first delete some:\n` +
                `• "Delete image 1 from ${product.name}"`
            );
            return;
        }
        
        await sendMessage(phone, "⏳ Uploading image...");
        
        // Download and upload image
        const { buffer, fileSize } = await downloadWhatsAppMedia(imageId);
        
        if (fileSize > MAX_IMAGE_SIZE) {
            await sendMessage(phone, 
                `❌ Image is too large (${(fileSize / 1024 / 1024).toFixed(2)}MB).\n` +
                "Maximum allowed: 2MB"
            );
            return;
        }
        
        const result = await uploadToCloudinary(buffer, {
            folder: 'badminton-store/products',
            transformation: [{ width: 1200, height: 1200, crop: 'limit', quality: 'auto' }],
            resource_type: 'image'
        });
        
        product.images.push(result.secure_url);
        await product.save();
        
        const remaining = MAX_IMAGES - product.images.length;
        let msg = `✅ Image added to *${product.name}*!\n\n📸 Total: ${product.images.length}/${MAX_IMAGES}`;
        
        if (remaining > 0) {
            msg += `\n\nYou can add ${remaining} more. Send another photo!`;
        } else {
            msg += "\n\n(Maximum images reached)";
            pendingMediaUploads.delete(phone);
        }
        
        await sendMessage(phone, msg);
        
    } catch (error) {
        console.error('❌ [IMAGE] Error:', error);
        await sendMessage(phone, "❌ Failed to upload image. Please try again.");
    }
}

/**
 * Handle incoming video messages
 */
async function handleVideoMessage(phone, videoId, mimeType) {
    console.log('🎬 [VIDEO] Processing video');
    
    try {
        const seller = await Seller.findOne({ phone: phone });
        
        if (!seller || seller.onboardingStep !== 'complete') {
            await sendMessage(phone, "Please complete your registration first.");
            return;
        }
        
        const pending = pendingMediaUploads.get(phone);
        
        if (!pending || pending.type !== 'video' || Date.now() > pending.expiresAt) {
            await sendMessage(phone, 
                "🎬 I received your video, but I don't know which product to add it to.\n\n" +
                "Say: \"Add video to [product name]\""
            );
            return;
        }
        
        const product = await Product.findOne({ _id: pending.productId, seller: seller._id });
        
        if (!product) {
            pendingMediaUploads.delete(phone);
            await sendMessage(phone, "❌ Product not found.");
            return;
        }
        
        await sendMessage(phone, "⏳ Uploading video... (this may take a moment)");
        
        const { buffer } = await downloadWhatsAppMedia(videoId);
        
        // Delete old video if exists
        if (product.video && product.video.publicId) {
            await deleteFromCloudinary(product.video.publicId, 'video').catch(() => {});
        }
        
        const result = await uploadToCloudinary(buffer, {
            folder: 'badminton-store/videos',
            resource_type: 'video',
            eager: [{ format: 'mp4' }]
        });
        
        // Check duration
        if (result.duration && result.duration > MAX_VIDEO_DURATION) {
            await deleteFromCloudinary(result.public_id, 'video');
            await sendMessage(phone, 
                `❌ Video is too long (${Math.round(result.duration)}s).\n` +
                `Maximum: ${MAX_VIDEO_DURATION} seconds`
            );
            return;
        }
        
        product.video = {
            url: result.secure_url,
            publicId: result.public_id
        };
        await product.save();
        
        pendingMediaUploads.delete(phone);
        
        await sendMessage(phone, 
            `✅ Video added to *${product.name}*!\n\n` +
            `🎬 Duration: ${Math.round(result.duration || 0)} seconds`
        );
        
    } catch (error) {
        console.error('❌ [VIDEO] Error:', error);
        await sendMessage(phone, "❌ Failed to upload video. Please try again.");
    }
}

// ============ Utility Functions ============

/**
 * Download media from WhatsApp
 */
async function downloadWhatsAppMedia(mediaId) {
    // Get media URL
    const urlResponse = await axios({
        method: 'GET',
        url: `https://graph.facebook.com/v17.0/${mediaId}`,
        headers: {
            'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        },
    });
    
    // Download media
    const mediaResponse = await axios({
        method: 'GET',
        url: urlResponse.data.url,
        headers: {
            'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        },
        responseType: 'arraybuffer',
    });
    
    return {
        buffer: Buffer.from(mediaResponse.data),
        fileSize: urlResponse.data.file_size
    };
}

/**
 * Send message to WhatsApp
 */
async function sendMessage(to, text) {
    console.log('📤 [SEND] To:', to, 'Text:', text.substring(0, 50) + '...');
    
    try {
        await axios({
            method: 'POST',
            url: `https://graph.facebook.com/v17.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
            headers: {
                'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
                'Content-Type': 'application/json',
            },
            data: {
                messaging_product: 'whatsapp',
                to: to,
                text: { body: text },
            },
        });
        console.log('✅ [SEND] Success');
    } catch (error) {
        console.error('❌ [SEND] Error:', error.response?.data || error.message);
    }
}

module.exports = router;
