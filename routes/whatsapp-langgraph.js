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
const { createThreadConfig } = require('../services/langgraph/checkpointer');

// In-memory store for pending media uploads (short-lived, OK to be in-memory)
const pendingMediaUploads = new Map();

// Message buffering system - wait for images after product descriptions
const messageBuffer = new Map(); // Map<phone, { text, images: [], timer, timestamp }>

// Constants
const MAX_IMAGES = 5;
const MAX_IMAGE_SIZE = 2 * 1024 * 1024; // 2MB
const MAX_VIDEO_DURATION = 20; // seconds
const MESSAGE_BUFFER_DELAY = 3000; // Wait 3 seconds for images after product description

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
                    // Extract caption if present - THIS IS THE KEY FIX
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
 * Check if message is about product creation/specs that might have images
 */
function isProductDescriptionMessage(text) {
    const productKeywords = [
        'create', 'add', 'new product', 'racket', 'shoe', 'shuttle',
        'model', 'weight', 'price', 'rate', 'description', 'image',
        'specification', 'spec', 'send you', 'upload', 'attach'
    ];
    
    const lowerText = text.toLowerCase();
    return productKeywords.some(keyword => lowerText.includes(keyword));
}

/**
 * Process buffered message with collected images
 * Passes inputType marker to agent for context-switch logic
 */
async function processBufferedMessage(phone, sellerId) {
    const buffer = messageBuffer.get(phone);
    if (!buffer) return;
    
    // Determine input type marker for agent
    const inputType = buffer.inputType || (buffer.images?.length > 0 ? 'TEXT_WITH_IMAGE' : 'TEXT_ONLY');
    
    // Format message clearly for the agent to parse
    let fullMessage = `[INPUT_TYPE: ${inputType}]`;
    
    // For IMAGE_WITH_CAPTION, format clearly so agent can easily extract imageUrl
    if (inputType === 'IMAGE_WITH_CAPTION' && buffer.images?.length > 0) {
        fullMessage += `\n[IMAGE_URL: ${buffer.images[0].url}]`;
        fullMessage += `\n[DESCRIPTION]: ${buffer.text}`;
    } else {
        fullMessage += `\n\n${buffer.text}`;
        
        // Append image URLs if any (for other input types)
        if (buffer.images && buffer.images.length > 0) {
            fullMessage += `\n\n📸 [${buffer.images.length} image(s) attached]\n`;
            buffer.images.forEach((img, i) => {
                fullMessage += `Image ${i + 1} URL: ${img.url}\n`;
            });
        }
    }
    
    console.log('📋 [BUFFER] Processing with inputType:', inputType, 'images:', buffer.images?.length || 0);
    
    // Process with agent
    const result = await processUserMessage(phone, fullMessage, sellerId, createThreadConfig(phone));
    
    // Handle pending media if agent requests images
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
    
    // Clear buffer
    messageBuffer.delete(phone);
}

/**
 * Handle incoming text messages
 */
async function handleTextMessage(phone, text) {
    console.log('💬 [TEXT] Processing:', text.substring(0, 50));
    
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
            // Check if this is a product-related message that might have images coming
            if (isProductDescriptionMessage(text)) {
                console.log('📋 [BUFFER] Buffering message to wait for images');
                
                // Clear any existing buffer timer
                const existingBuffer = messageBuffer.get(phone);
                if (existingBuffer?.timer) {
                    clearTimeout(existingBuffer.timer);
                }
                
                // Create/update buffer
                messageBuffer.set(phone, {
                    text: text,
                    images: existingBuffer?.images || [],
                    timestamp: Date.now(),
                    sellerId: seller._id.toString()
                });
                
                // Set timer to process after delay
                const timer = setTimeout(() => {
                    processBufferedMessage(phone, seller._id.toString()).catch(error => {
                        console.error('❌ [BUFFER] Processing error:', error);
                        sendMessage(phone, "Sorry, I encountered an error. Please try again.");
                    });
                }, MESSAGE_BUFFER_DELAY);
                
                // Store timer reference
                const buffer = messageBuffer.get(phone);
                if (buffer) buffer.timer = timer;
                
                // Send acknowledgement
                await sendMessage(phone, "⏳ Processing your message... (waiting for images if any)");
            } else {
                // Non-product message - process immediately
                const result = await processUserMessage(phone, text, seller._id.toString(), createThreadConfig(phone));
                
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
        }
        
    } catch (error) {
        console.error('❌ [TEXT] Error:', error);
        await sendMessage(phone, "Sorry, I encountered an error. Please try again.");
    }
}

/**
 * Handle incoming image messages
 * CONTEXT-SWITCH LOGIC: Captioned image = NEW product, Image-only = continue task
 */
async function handleImageMessage(phone, imageId, mimeType, caption = null) {
    console.log('🖼️ [IMAGE] Processing image, caption:', caption ? caption.substring(0, 50) + '...' : 'NONE');
    
    try {
        const seller = await Seller.findOne({ phone: phone });
        
        if (!seller || seller.onboardingStep !== 'complete') {
            await sendMessage(phone, "Please complete your registration first.");
            return;
        }
        
        // ============ CONTEXT SWITCH: Captioned Image = NEW Product ============
        if (caption && caption.trim().length > 0) {
            console.log('📋 [CONTEXT SWITCH] Captioned image detected - treating as NEW product');
            
            // CRITICAL: Clear any pending media uploads (prevents old product association)
            pendingMediaUploads.delete(phone);
            
            // Clear existing buffer if any
            const existingBuffer = messageBuffer.get(phone);
            if (existingBuffer?.timer) {
                clearTimeout(existingBuffer.timer);
            }
            
            // Download and upload image first
            const { buffer: imageBuffer, fileSize } = await downloadWhatsAppMedia(imageId);
            
            if (fileSize > MAX_IMAGE_SIZE) {
                await sendMessage(phone, 
                    `❌ Image is too large (${(fileSize / 1024 / 1024).toFixed(2)}MB).\n` +
                    "Maximum allowed: 2MB"
                );
                return;
            }
            
            const uploadResult = await uploadToCloudinary(imageBuffer, {
                folder: 'badminton-store/products',
                transformation: [{ width: 1200, height: 1200, crop: 'limit', quality: 'auto' }],
                resource_type: 'image'
            });
            
            // Create buffer with caption as text and image attached
            // Mark inputType as IMAGE_WITH_CAPTION for agent to know context
            messageBuffer.set(phone, {
                text: caption,
                images: [{
                    url: uploadResult.secure_url,
                    publicId: uploadResult.public_id
                }],
                timestamp: Date.now(),
                sellerId: seller._id.toString(),
                inputType: 'IMAGE_WITH_CAPTION'  // KEY: Agent uses this to know it's a new product
            });
            
            // Set timer to process (short delay in case more images come)
            const timer = setTimeout(() => {
                processBufferedMessage(phone, seller._id.toString()).catch(error => {
                    console.error('❌ [BUFFER] Processing error:', error);
                    sendMessage(phone, "Sorry, I encountered an error. Please try again.");
                });
            }, MESSAGE_BUFFER_DELAY);
            
            messageBuffer.get(phone).timer = timer;
            
            await sendMessage(phone, `📸 Got it! Creating your product...`);
            return;
        }
        
        // ============ IMAGE ONLY (No Caption) - Check for existing context ============
        console.log('🖼️ [IMAGE ONLY] No caption - checking for existing buffer or pending upload');
        
        // Check if there's a buffered message waiting for images
        const buffer = messageBuffer.get(phone);
        if (buffer) {
            console.log('📋 [BUFFER] Adding image to buffered message');
            
            // Download image
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
            
            // Add to buffer
            if (!buffer.images) buffer.images = [];
            buffer.images.push({
                url: uploadResult.secure_url,
                publicId: uploadResult.public_id
            });
            
            console.log('✅ [BUFFER] Image added. Total images:', buffer.images.length);
            
            // Reset timer to wait more for additional images
            if (buffer.timer) clearTimeout(buffer.timer);
            buffer.timer = setTimeout(() => {
                processBufferedMessage(phone, buffer.sellerId).catch(error => {
                    console.error('❌ [BUFFER] Processing error:', error);
                    sendMessage(phone, "Sorry, I encountered an error. Please try again.");
                });
            }, MESSAGE_BUFFER_DELAY);
            
            // Acknowledge receipt
            await sendMessage(phone, `📸 Image ${buffer.images.length} received. Waiting for more... (or I'll process in a moment)`);
            return;
        }
        
        // Check for pending image upload (not buffered)
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
        const { buffer: imgBuffer, fileSize } = await downloadWhatsAppMedia(imageId);
        
        if (fileSize > MAX_IMAGE_SIZE) {
            await sendMessage(phone, 
                `❌ Image is too large (${(fileSize / 1024 / 1024).toFixed(2)}MB).\n` +
                "Maximum allowed: 2MB"
            );
            return;
        }
        
        const result = await uploadToCloudinary(imgBuffer, {
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
