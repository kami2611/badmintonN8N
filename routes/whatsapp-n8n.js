/**
 * WhatsApp Webhook Route - n8n Integration Version
 * Forwards messages to n8n for AI processing, handles media uploads
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const Seller = require('../models/Seller');
const Product = require('../models/Product');
const bcrypt = require('bcrypt');
const { uploadToCloudinary, deleteFromCloudinary, getPublicIdFromUrl } = require('../config/cloudinary');

// Constants
const MAX_IMAGES = 5;
const MAX_IMAGE_SIZE = 2 * 1024 * 1024; // 2MB
const MAX_VIDEO_DURATION = 20; // seconds
const N8N_WEBHOOK_TIMEOUT = 30000; // 30 seconds

// In-memory store for pending media uploads (short-lived)
const pendingMediaUploads = new Map();

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
                    const caption = messageObj.image.caption || null;
                    await handleImageMessage(from, messageObj.image.id, messageObj.image.mime_type, caption);
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
 * Forwards to n8n for AI processing
 */
async function handleTextMessage(phone, text) {
    console.log('💬 [TEXT] Processing:', text.substring(0, 50));
    
    try {
        // Check if n8n webhook URL is configured
        if (!process.env.N8N_WEBHOOK_URL) {
            console.error('❌ [TEXT] N8N_WEBHOOK_URL not configured');
            await sendMessage(phone, "Sorry, the AI assistant is not configured. Please contact support.");
            return;
        }

        // Find or check seller
        let seller = await Seller.findOne({ phone: phone });
        
        // Prepare payload for n8n
        const payload = {
            type: 'text',
            phone: phone,
            message: text,
            timestamp: new Date().toISOString(),
            seller: seller ? {
                id: seller._id.toString(),
                name: seller.name,
                storeName: seller.storeName,
                onboardingStep: seller.onboardingStep,
                isRegistered: seller.onboardingStep === 'complete'
            } : null
        };

        console.log('📤 [N8N] Forwarding to n8n:', JSON.stringify(payload).substring(0, 200));

        // Forward to n8n webhook
        try {
            const response = await axios({
                method: 'POST',
                url: process.env.N8N_WEBHOOK_URL,
                headers: {
                    'Content-Type': 'application/json',
                    'x-webhook-secret': process.env.N8N_WEBHOOK_SECRET || ''
                },
                data: payload,
                timeout: N8N_WEBHOOK_TIMEOUT
            });

            console.log('✅ [N8N] Response received:', JSON.stringify(response.data).substring(0, 200));

            // If n8n returns a response message, send it
            if (response.data && response.data.message) {
                await sendMessage(phone, response.data.message);
            }

            // Handle any pending media actions from n8n
            if (response.data && response.data.awaitMedia) {
                pendingMediaUploads.set(phone, {
                    type: response.data.awaitMedia.type, // 'image' or 'video'
                    productId: response.data.awaitMedia.productId,
                    expiresAt: Date.now() + 5 * 60 * 1000 // 5 minutes
                });
            }

        } catch (n8nError) {
            console.error('❌ [N8N] Error:', n8nError.message);
            
            // Fallback: If n8n is down, provide basic response
            if (n8nError.code === 'ECONNREFUSED' || n8nError.code === 'ETIMEDOUT') {
                await sendMessage(phone, "Sorry, our AI assistant is temporarily unavailable. Please try again in a moment.");
            } else {
                await sendMessage(phone, "Sorry, I encountered an error processing your request. Please try again.");
            }
        }
        
    } catch (error) {
        console.error('❌ [TEXT] Error:', error);
        await sendMessage(phone, "Sorry, I encountered an error. Please try again.");
    }
}

/**
 * Handle incoming image messages
 * Uploads to Cloudinary and forwards to n8n
 */
async function handleImageMessage(phone, imageId, mimeType, caption = null) {
    console.log('🖼️ [IMAGE] Processing image, caption:', caption ? caption.substring(0, 50) + '...' : 'NONE');
    
    try {
        const seller = await Seller.findOne({ phone: phone });
        
        if (!seller || seller.onboardingStep !== 'complete') {
            await sendMessage(phone, "Please complete your registration first by sending a text message.");
            return;
        }

        // Download and upload image to Cloudinary first
        await sendMessage(phone, "⏳ Processing your image...");
        
        const { buffer: imageBuffer, fileSize } = await downloadWhatsAppMedia(imageId);
        
        if (fileSize > MAX_IMAGE_SIZE) {
            await sendMessage(phone, 
                `❌ Image is too large (${(fileSize / 1024 / 1024).toFixed(2)}MB).\n` +
                "Maximum allowed: 2MB"
            );
            return;
        }
        
        // Upload to Cloudinary
        const uploadResult = await uploadToCloudinary(imageBuffer, {
            folder: 'badminton-store/products',
            transformation: [{ width: 1200, height: 1200, crop: 'limit', quality: 'auto' }],
            resource_type: 'image'
        });

        console.log('✅ [IMAGE] Uploaded to Cloudinary:', uploadResult.secure_url);

        // Check if n8n webhook URL is configured
        if (!process.env.N8N_WEBHOOK_URL) {
            // Fallback: Check for pending media upload
            const pending = pendingMediaUploads.get(phone);
            if (pending && pending.type === 'image' && Date.now() < pending.expiresAt) {
                await addImageToProduct(phone, pending.productId, uploadResult.secure_url, seller._id);
                return;
            }
            
            await sendMessage(phone, 
                "📷 Image received and uploaded!\n\n" +
                "To add it to a product, tell me which product this is for."
            );
            return;
        }

        // Forward to n8n with image info
        const payload = {
            type: 'image',
            phone: phone,
            caption: caption || null,
            image: {
                url: uploadResult.secure_url,
                publicId: uploadResult.public_id
            },
            timestamp: new Date().toISOString(),
            seller: {
                id: seller._id.toString(),
                name: seller.name,
                storeName: seller.storeName,
                onboardingStep: seller.onboardingStep,
                isRegistered: true
            },
            // Include pending context if exists
            pendingUpload: pendingMediaUploads.get(phone) || null
        };

        try {
            const response = await axios({
                method: 'POST',
                url: process.env.N8N_WEBHOOK_URL,
                headers: {
                    'Content-Type': 'application/json',
                    'x-webhook-secret': process.env.N8N_WEBHOOK_SECRET || ''
                },
                data: payload,
                timeout: N8N_WEBHOOK_TIMEOUT
            });

            if (response.data && response.data.message) {
                await sendMessage(phone, response.data.message);
            }

            // Clear pending if used
            if (response.data && response.data.clearPending) {
                pendingMediaUploads.delete(phone);
            }

            // Set new pending if requested
            if (response.data && response.data.awaitMedia) {
                pendingMediaUploads.set(phone, {
                    type: response.data.awaitMedia.type,
                    productId: response.data.awaitMedia.productId,
                    expiresAt: Date.now() + 5 * 60 * 1000
                });
            }

        } catch (n8nError) {
            console.error('❌ [N8N] Error:', n8nError.message);
            
            // Fallback: Use pending upload system
            const pending = pendingMediaUploads.get(phone);
            if (pending && pending.type === 'image' && Date.now() < pending.expiresAt) {
                await addImageToProduct(phone, pending.productId, uploadResult.secure_url, seller._id);
            } else {
                await sendMessage(phone, 
                    "📷 Image uploaded successfully!\n\n" +
                    "Our AI assistant is temporarily unavailable. " +
                    "Your image has been saved and you can add it to a product later."
                );
            }
        }
        
    } catch (error) {
        console.error('❌ [IMAGE] Error:', error);
        await sendMessage(phone, "❌ Failed to process image. Please try again.");
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

// ============ Helper Functions ============

/**
 * Add image to a product (fallback when n8n is unavailable)
 */
async function addImageToProduct(phone, productId, imageUrl, sellerId) {
    try {
        const product = await Product.findOne({ _id: productId, seller: sellerId });
        
        if (!product) {
            pendingMediaUploads.delete(phone);
            await sendMessage(phone, "❌ Product not found. Please try again.");
            return;
        }
        
        if (product.images.length >= MAX_IMAGES) {
            await sendMessage(phone, 
                `❌ This product already has ${MAX_IMAGES} images (maximum).\n\n` +
                `To add more, first delete some.`
            );
            return;
        }
        
        product.images.push(imageUrl);
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
        console.error('❌ [ADD IMAGE] Error:', error);
        await sendMessage(phone, "❌ Failed to add image. Please try again.");
    }
}

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

// ============ API Endpoint for Setting Pending Media ============

/**
 * Set pending media upload state (called by n8n)
 * POST /whatsapp/pending-media
 */
router.post('/pending-media', (req, res) => {
    const { phone, type, productId, expiresInMinutes = 5 } = req.body;
    
    if (!phone || !type || !productId) {
        return res.status(400).json({ error: 'phone, type, and productId are required' });
    }
    
    pendingMediaUploads.set(phone, {
        type,
        productId,
        expiresAt: Date.now() + (expiresInMinutes * 60 * 1000)
    });
    
    res.json({ success: true, message: 'Pending media state set' });
});

/**
 * Clear pending media upload state
 * DELETE /whatsapp/pending-media/:phone
 */
router.delete('/pending-media/:phone', (req, res) => {
    pendingMediaUploads.delete(req.params.phone);
    res.json({ success: true, message: 'Pending media state cleared' });
});

module.exports = router;
