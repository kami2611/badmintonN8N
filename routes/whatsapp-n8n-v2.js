/**
 * WhatsApp Webhook Route - v2 (Brain/Executor Architecture)
 * 
 * Node.js = Executor (handles all database operations, business logic)
 * n8n + Groq = Brain (understands intent, extracts entities, maintains conversation memory)
 * 
 * Flow:
 * 1. Receive WhatsApp message
 * 2. Pre-process: check seller, upload media
 * 3. Send context to n8n for intent classification
 * 4. Receive JSON instruction from n8n
 * 5. Execute action based on intent
 * 6. Send response to user
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const Seller = require('../models/Seller');
const Product = require('../models/Product');
const { uploadToCloudinary, deleteFromCloudinary } = require('../config/cloudinary');

// Constants
const MAX_IMAGES = 5;
const MAX_IMAGE_SIZE = 2 * 1024 * 1024; // 2MB
const MAX_VIDEO_DURATION = 20; // seconds
const N8N_WEBHOOK_TIMEOUT = 30000; // 30 seconds

// Temporary storage for pending image context (when user sends image without caption)
const pendingImageContext = new Map();
// Temporary storage for pending seller onboarding data (name/storeName/phone)
const pendingSellerContext = new Map();

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
 * Message Receiver (POST) - Main entry point
 */
router.post('/webhook', async (req, res) => {
    console.log('\n========== INCOMING WEBHOOK ==========');
    
    const body = req.body;

    if (body.object) {
        // Ignore status updates
        if (body.entry?.[0]?.changes?.[0]?.value?.statuses) {
            console.log('📊 [WEBHOOK] Status update - ignoring');
            res.sendStatus(200);
            return;
        }
        
        // Check for actual message
        if (
            body.entry &&
            body.entry[0].changes &&
            body.entry[0].changes[0].value.messages &&
            body.entry[0].changes[0].value.messages[0]
        ) {
            const messageObj = body.entry[0].changes[0].value.messages[0];
            const phone = messageObj.from;
            const msgType = messageObj.type;

            console.log('📱 [WEBHOOK] From:', phone, 'Type:', msgType);

            // Process asynchronously
            processMessage(phone, msgType, messageObj).catch(err => {
                console.error('❌ [WEBHOOK] Processing error:', err);
            });
        }
        
        res.sendStatus(200);
    } else {
        res.sendStatus(404);
    }
});

// ============ Main Processing Pipeline ============

/**
 * Process incoming message through the brain/executor pipeline
 */
async function processMessage(phone, msgType, messageObj) {
    try {
        // Step 1: Extract message content
        let messageContent = '';
        let imageUrl = null;
        
        if (msgType === 'text') {
            messageContent = messageObj.text.body;
        } else if (msgType === 'image') {
            messageContent = messageObj.image.caption || '';
            // Upload image to Cloudinary first
            imageUrl = await handleImageUpload(phone, messageObj.image.id);
            if (!imageUrl) {
                return; // Error already sent to user
            }
        } else if (msgType === 'video') {
            await sendMessage(phone, "🎬 Video uploads are supported after you create a product. Send an image with description first!");
            return;
        } else {
            await sendMessage(phone, "I can process text messages and images. Please send one of those!");
            return;
        }

        // Step 2: Get or create seller context
        const sellerContext = await getSellerContext(phone);
        
        // Step 3: Check for pending image context (user sent image, we asked for description)
        const pendingImage = pendingImageContext.get(phone);
        if (pendingImage && msgType === 'text' && !imageUrl) {
            // User is providing description for previously uploaded image
            imageUrl = pendingImage.imageUrl;
            pendingImageContext.delete(phone);
            console.log('📷 [CONTEXT] Using pending image URL:', imageUrl);
        }

        // Step 4: Send to n8n for intent classification
        const instruction = await getIntentFromN8N(phone, msgType, messageContent, imageUrl, sellerContext);
        
        if (!instruction) {
            await sendMessage(phone, "Sorry, I'm having trouble understanding. Please try again.");
            return;
        }

        console.log('🧠 [N8N] Intent:', instruction.intent, 'Action:', JSON.stringify(instruction.action));

        // Step 5: Execute action based on intent
        await executeIntent(phone, instruction, imageUrl, sellerContext);

    } catch (error) {
        console.error('❌ [PROCESS] Error:', error);
        await sendMessage(phone, "Sorry, something went wrong. Please try again.");
    }
}

// ============ Step 2: Seller Context ============

/**
 * Get or create seller context for n8n
 */
async function getSellerContext(phone) {
    let seller = await Seller.findOne({ phone: phone });

    if (!seller) {
        const pending = pendingSellerContext.get(phone) || {};
        return {
            exists: false,
            id: null,
            name: pending.name || null,
            storeName: pending.storeName || null,
            onboardingStep: 'new',
            status: 'pending',
            needsOnboarding: true
        };
    }

    const needsOnboarding = seller.onboardingStep !== 'complete';

    return {
        exists: true,
        id: seller._id.toString(),
        name: seller.name || null,
        storeName: seller.storeName || null,
        onboardingStep: seller.onboardingStep,
        status: seller.status,
        needsOnboarding: needsOnboarding
    };
}

// ============ Step 3: Image Upload ============

/**
 * Handle image upload to Cloudinary
 */
async function handleImageUpload(phone, imageId) {
    try {
        await sendMessage(phone, "⏳ Processing your image...");
        
        const { buffer, fileSize } = await downloadWhatsAppMedia(imageId);
        
        if (fileSize > MAX_IMAGE_SIZE) {
            await sendMessage(phone, 
                `❌ Image is too large (${(fileSize / 1024 / 1024).toFixed(2)}MB).\n` +
                "Maximum allowed: 2MB"
            );
            return null;
        }
        
        const uploadResult = await uploadToCloudinary(buffer, {
            folder: 'badminton-store/products',
            transformation: [{ width: 1200, height: 1200, crop: 'limit', quality: 'auto' }],
            resource_type: 'image'
        });

        console.log('✅ [IMAGE] Uploaded:', uploadResult.secure_url);
        return uploadResult.secure_url;
        
    } catch (error) {
        console.error('❌ [IMAGE] Upload error:', error);
        await sendMessage(phone, "❌ Failed to process image. Please try again.");
        return null;
    }
}

// ============ Step 4: n8n Intent Classification ============

/**
 * Send message to n8n for intent classification
 */
async function getIntentFromN8N(phone, messageType, messageContent, imageUrl, sellerContext) {
    if (!process.env.N8N_WEBHOOK_URL) {
        console.error('❌ [N8N] N8N_WEBHOOK_URL not configured');
        return null;
    }

    const payload = {
        phone: phone,
        messageType: messageType,
        messageContent: messageContent,
        imageUrl: imageUrl,
        sellerContext: sellerContext
    };

    console.log('📤 [N8N] Sending:', JSON.stringify(payload).substring(0, 300));

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

        console.log('✅ [N8N] Response:', JSON.stringify(response.data).substring(0, 300));
        return response.data;

    } catch (error) {
        console.error('❌ [N8N] Error:', error.message);
        return null;
    }
}

// ============ Step 5: Execute Intent ============

/**
 * Execute action based on intent from n8n
 */
async function executeIntent(phone, instruction, imageUrl, sellerContext) {
    const { intent, action, message } = instruction;

    switch (intent) {
        case 'ONBOARDING_EXTRACT':
            await handleOnboarding(phone, action, message, sellerContext);
            break;

        case 'CREATE_PRODUCT':
            await handleCreateProduct(phone, action, imageUrl, message, sellerContext);
            break;

        case 'UPDATE_PRODUCT':
            await handleUpdateProduct(phone, action, message, sellerContext);
            break;

        case 'DELETE_PRODUCT':
            await handleDeleteProduct(phone, action, message, sellerContext);
            break;

        case 'LIST_PRODUCTS':
            await handleListProducts(phone, action, message, sellerContext);
            break;

        case 'NEED_CLARIFICATION':
            // Store image context if we have an image but need more info
            if (imageUrl) {
                pendingImageContext.set(phone, {
                    imageUrl: imageUrl,
                    timestamp: Date.now()
                });
                // Clean up after 10 minutes
                setTimeout(() => pendingImageContext.delete(phone), 10 * 60 * 1000);
            }
            await sendMessage(phone, message);
            break;

        case 'GENERAL_RESPONSE':
        default:
            await sendMessage(phone, message);
            break;
    }
}

// ============ Intent Handlers ============

/**
 * Handle onboarding - extract and save name/storeName
 */
async function handleOnboarding(phone, action, message, sellerContext) {
    const { name, storeName, phone: extractedPhone } = action;

    const seller = await Seller.findOne({ phone: phone });
    const pending = pendingSellerContext.get(phone) || {};
    const nextPending = {
        name: name || pending.name,
        storeName: storeName || pending.storeName,
        phone: extractedPhone || pending.phone
    };

    if (!seller) {
        // Store partial onboarding data until we have all required fields
        pendingSellerContext.set(phone, nextPending);

        if (nextPending.name && nextPending.storeName) {
            const sellerPhone = nextPending.phone || phone;
            const newSeller = new Seller({
                phone: sellerPhone,
                name: nextPending.name,
                storeName: nextPending.storeName,
                password: 'whatsapp-' + Date.now(), // Placeholder password
                onboardingStep: 'complete',
                status: 'pending'
            });

            await newSeller.save();
            pendingSellerContext.delete(phone);
            console.log('👤 [SELLER] New seller created:', sellerPhone);

            const welcomeMsg = `🎉 *Welcome to the community, ${newSeller.name}!*\n\n` +
                `Your store *${newSeller.storeName}* has been created.\n\n` +
                `📌 *Current Status:* Your store is only visible to you.\n\n` +
                `You can start adding products now! Just send me:\n` +
                `📷 An image with a description to add a product\n` +
                `📝 "show products" to see your inventory\n\n` +
                `Once we verify your account, your products will be visible to everyone!`;

            await sendMessage(phone, welcomeMsg);
            return;
        }

        await sendMessage(phone, message);
        return;
    }

    let updated = false;

    // Update name if provided
    if (name && !seller.name) {
        seller.name = name;
        updated = true;
        console.log('👤 [ONBOARD] Name set:', name);
    }

    // Update store name if provided
    if (storeName && !seller.storeName) {
        seller.storeName = storeName;
        updated = true;
        console.log('🏪 [ONBOARD] Store name set:', storeName);
    }

    // Check if onboarding is complete
    if (seller.name && seller.storeName && seller.onboardingStep !== 'complete') {
        seller.onboardingStep = 'complete';
        updated = true;
        console.log('✅ [ONBOARD] Onboarding complete for:', phone);
        
        await seller.save();
        
        // Send welcome message
        const welcomeMsg = `🎉 *Welcome to the community, ${seller.name}!*\n\n` +
            `Your store *${seller.storeName}* has been created.\n\n` +
            `📌 *Current Status:* Your store is only visible to you.\n\n` +
            `You can start adding products now! Just send me:\n` +
            `📷 An image with a description to add a product\n` +
            `📝 "show products" to see your inventory\n\n` +
            `Once we verify your account, your products will be visible to everyone!`;
        
        await sendMessage(phone, welcomeMsg);
        return;
    }

    if (updated) {
        await seller.save();
    }

    // Send the n8n message (may ask for remaining info)
    await sendMessage(phone, message);
}

/**
 * Handle product creation
 */
async function handleCreateProduct(phone, action, imageUrl, message, sellerContext) {
    // Check if seller is registered
    if (sellerContext.needsOnboarding) {
        await sendMessage(phone, "Please complete your registration first! Send me your name and store name.");
        return;
    }

    // Validate we have required data
    if (!action.description && !action.name) {
        await sendMessage(phone, "I need a product description to create a product. Please describe what you're selling!");
        return;
    }

    // Check for image
    if (!imageUrl) {
        // Store action for when image comes
        await sendMessage(phone, "Please send an image of the product along with your description!");
        return;
    }

    try {
        const seller = await Seller.findOne({ phone: phone });
        
        const newProduct = new Product({
            name: action.name || 'New Product',
            description: action.description || '',
            price: parseFloat(action.price) || 0,
            stock: parseInt(action.stock) || 1,
            category: action.category || 'accessories',
            brand: action.brand || 'Generic',
            images: [imageUrl],
            seller: seller._id
        });

        await newProduct.save();
        console.log('✅ [PRODUCT] Created:', newProduct.name);

        // Send success message with product details
        const successMsg = `✅ *Product Created!*\n\n` +
            `📦 *${newProduct.name}*\n` +
            `💰 Price: PKR ${newProduct.price.toLocaleString()}\n` +
            `📊 Stock: ${newProduct.stock}\n` +
            `🏷️ Category: ${newProduct.category}\n` +
            `🏢 Brand: ${newProduct.brand}\n\n` +
            `📷 Image attached!`;

        await sendMessage(phone, successMsg);

    } catch (error) {
        console.error('❌ [PRODUCT] Create error:', error);
        await sendMessage(phone, "Failed to create product. Please try again.");
    }
}

/**
 * Handle product update
 */
async function handleUpdateProduct(phone, action, message, sellerContext) {
    if (sellerContext.needsOnboarding) {
        await sendMessage(phone, "Please complete your registration first!");
        return;
    }

    const { searchName, updates } = action;

    if (!searchName) {
        await sendMessage(phone, "Which product do you want to update? Please mention the product name.");
        return;
    }

    try {
        const seller = await Seller.findOne({ phone: phone });
        
        // Find product by name (case-insensitive, partial match)
        const product = await Product.findOne({
            seller: seller._id,
            name: { $regex: new RegExp(searchName, 'i') }
        });

        if (!product) {
            await sendMessage(phone, `❌ Product "${searchName}" not found.\n\nSay "show products" to see your inventory.`);
            return;
        }

        // Apply updates
        if (updates) {
            if (updates.price !== undefined) product.price = parseFloat(updates.price);
            if (updates.stock !== undefined) product.stock = parseInt(updates.stock);
            if (updates.name !== undefined) product.name = updates.name;
            if (updates.description !== undefined) product.description = updates.description;
            if (updates.category !== undefined) product.category = updates.category;
            if (updates.brand !== undefined) product.brand = updates.brand;
        }

        await product.save();
        console.log('✅ [PRODUCT] Updated:', product.name);

        const successMsg = `✅ *Product Updated!*\n\n` +
            `📦 *${product.name}*\n` +
            `💰 Price: PKR ${product.price.toLocaleString()}\n` +
            `📊 Stock: ${product.stock}`;

        await sendMessage(phone, successMsg);

    } catch (error) {
        console.error('❌ [PRODUCT] Update error:', error);
        await sendMessage(phone, "Failed to update product. Please try again.");
    }
}

/**
 * Handle product deletion
 */
async function handleDeleteProduct(phone, action, message, sellerContext) {
    if (sellerContext.needsOnboarding) {
        await sendMessage(phone, "Please complete your registration first!");
        return;
    }

    const { productName } = action;

    if (!productName) {
        await sendMessage(phone, "Which product do you want to delete? Please mention the product name.");
        return;
    }

    try {
        const seller = await Seller.findOne({ phone: phone });
        
        const product = await Product.findOneAndDelete({
            seller: seller._id,
            name: { $regex: new RegExp(`^${productName}$`, 'i') }
        });

        if (!product) {
            await sendMessage(phone, `❌ Product "${productName}" not found.`);
            return;
        }

        // Delete images from Cloudinary
        for (const imageUrl of product.images) {
            try {
                const publicId = imageUrl.split('/').slice(-2).join('/').split('.')[0];
                await deleteFromCloudinary(publicId);
            } catch (e) {
                console.log('⚠️ Could not delete image from Cloudinary');
            }
        }

        console.log('✅ [PRODUCT] Deleted:', product.name);
        await sendMessage(phone, `✅ *${product.name}* has been deleted.`);

    } catch (error) {
        console.error('❌ [PRODUCT] Delete error:', error);
        await sendMessage(phone, "Failed to delete product. Please try again.");
    }
}

/**
 * Handle listing products
 */
async function handleListProducts(phone, action, message, sellerContext) {
    if (sellerContext.needsOnboarding) {
        await sendMessage(phone, "Please complete your registration first!");
        return;
    }

    try {
        const seller = await Seller.findOne({ phone: phone });
        
        let query = { seller: seller._id };
        if (action.searchTerm) {
            query.$or = [
                { name: { $regex: action.searchTerm, $options: 'i' } },
                { description: { $regex: action.searchTerm, $options: 'i' } }
            ];
        }

        const products = await Product.find(query).limit(20).sort({ createdAt: -1 });

        if (products.length === 0) {
            await sendMessage(phone, 
                "📦 *Your inventory is empty!*\n\n" +
                "To add a product, send me an image with a description like:\n" +
                "\"Yonex racket, 5000 rupees, brand new\""
            );
            return;
        }

        let listMsg = `📦 *Your Products (${products.length})*\n\n`;
        
        products.forEach((p, i) => {
            listMsg += `${i + 1}. *${p.name}*\n`;
            listMsg += `   💰 PKR ${p.price.toLocaleString()} | 📊 Stock: ${p.stock}\n\n`;
        });

        listMsg += `\n_To update: "change price of [name] to [price]"_\n`;
        listMsg += `_To delete: "delete [name]"_`;

        await sendMessage(phone, listMsg);

    } catch (error) {
        console.error('❌ [PRODUCT] List error:', error);
        await sendMessage(phone, "Failed to fetch products. Please try again.");
    }
}

// ============ Helper Functions ============

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
    console.log('📤 [SEND] To:', to, 'Text:', text.substring(0, 80) + '...');
    
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

// ============ Utility Endpoints ============

/**
 * Health check endpoint
 */
router.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        n8nConfigured: !!process.env.N8N_WEBHOOK_URL
    });
});

/**
 * Clear conversation memory for a phone (for testing)
 */
router.post('/clear-context/:phone', (req, res) => {
    pendingImageContext.delete(req.params.phone);
    res.json({ success: true, message: 'Local context cleared. n8n memory must be cleared separately.' });
});

module.exports = router;
