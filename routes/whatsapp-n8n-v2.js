/**
 * WhatsApp Webhook Route - v3 (Button-Driven Deterministic Architecture)
 * 
 * FULLY DETERMINISTIC - No AI/n8n dependency
 * 
 * Flow:
 * 1. Receive WhatsApp message
 * 2. Check message type (interactive button, text, image)
 * 3. Route based on button ID or current user state
 * 4. Execute action deterministically
 * 5. Send response with interactive buttons/menus
 * 
 * Key Principles:
 * - Intent = Button ID (not natural language parsing)
 * - State machine for multi-step flows
 * - Predictable costs, horizontally scalable
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
const STATE_TIMEOUT = 10 * 60 * 1000; // 10 minutes

// ============ State Management ============

// User state for multi-step flows
const userState = new Map();
/*
 * userState.get(phone) = {
 *   step: 'IDLE' | 'AWAITING_NAME' | 'AWAITING_STORE_NAME' | 
 *         'AWAITING_IMAGE' | 'AWAITING_PRODUCT_DETAILS' |
 *         'AWAITING_PRODUCT_SELECTION' | 'AWAITING_UPDATE_FIELD' |
 *         'AWAITING_UPDATE_VALUE' | 'CONFIRM_DELETE',
 *   intent: string,
 *   data: { ... partial collected data ... },
 *   timestamp: number
 * }
 */

// Temporary storage for pending image context (when user sends image without caption)
const pendingImageContext = new Map();
// Temporary storage for pending seller onboarding data (name/storeName/phone)
const pendingSellerContext = new Map();

// ============ State Helpers ============

function setState(phone, step, intent = null, data = {}) {
    const existing = userState.get(phone) || {};
    userState.set(phone, {
        step,
        intent: intent || existing.intent,
        data: { ...existing.data, ...data },
        timestamp: Date.now()
    });
    
    // Auto-cleanup after timeout
    setTimeout(() => {
        const current = userState.get(phone);
        if (current && Date.now() - current.timestamp >= STATE_TIMEOUT) {
            userState.delete(phone);
            console.log('🧹 [STATE] Cleaned up expired state for:', phone);
        }
    }, STATE_TIMEOUT + 1000);
    
    console.log('📝 [STATE] Set:', phone, step, intent);
}

function getState(phone) {
    const state = userState.get(phone);
    if (state && Date.now() - state.timestamp < STATE_TIMEOUT) {
        return state;
    }
    return { step: 'IDLE', intent: null, data: {} };
}

function clearState(phone) {
    userState.delete(phone);
    console.log('🧹 [STATE] Cleared:', phone);
}

// ============ Button ID to Intent Router ============

function getIntentFromButton(buttonId) {
    // Static button mappings
    const staticMappings = {
        'ADD_PRODUCT': { intent: 'CREATE_PRODUCT', action: {} },
        'LIST_PRODUCTS': { intent: 'LIST_PRODUCTS', action: {} },
        'UPDATE_PRODUCT': { intent: 'UPDATE_PRODUCT', action: {} },
        'DELETE_PRODUCT': { intent: 'DELETE_PRODUCT', action: {} },
        'MAIN_MENU': { intent: 'SHOW_MENU', action: {} },
        'START_ONBOARDING': { intent: 'ONBOARDING_START', action: {} },
        'CONFIRM_DELETE_YES': { intent: 'DELETE_CONFIRM', action: { confirmed: true } },
        'CONFIRM_DELETE_NO': { intent: 'DELETE_CONFIRM', action: { confirmed: false } },
        'UPDATE_PRICE': { intent: 'UPDATE_FIELD_SELECT', action: { field: 'price' } },
        'UPDATE_STOCK': { intent: 'UPDATE_FIELD_SELECT', action: { field: 'stock' } },
        'UPDATE_NAME': { intent: 'UPDATE_FIELD_SELECT', action: { field: 'name' } },
        'CANCEL': { intent: 'CANCEL_FLOW', action: {} }
    };

    if (staticMappings[buttonId]) {
        return staticMappings[buttonId];
    }

    // Dynamic button mappings (e.g., SELECT_PRODUCT_<id>)
    if (buttonId.startsWith('SELECT_PRODUCT_')) {
        const productId = buttonId.replace('SELECT_PRODUCT_', '');
        return { intent: 'PRODUCT_SELECTED', action: { productId } };
    }
    
    if (buttonId.startsWith('DELETE_PRODUCT_')) {
        const productId = buttonId.replace('DELETE_PRODUCT_', '');
        return { intent: 'DELETE_PRODUCT_SELECTED', action: { productId } };
    }
    
    if (buttonId.startsWith('UPDATE_PRODUCT_')) {
        const productId = buttonId.replace('UPDATE_PRODUCT_', '');
        return { intent: 'UPDATE_PRODUCT_SELECTED', action: { productId } };
    }

    console.log('⚠️ [ROUTER] Unknown button ID:', buttonId);
    return null;
}

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
 * Process incoming message through deterministic button-driven pipeline
 */
async function processMessage(phone, msgType, messageObj) {
    try {
        // Step 1: Get seller context first
        const sellerContext = await getSellerContext(phone);
        
        // Step 2: Handle interactive button/list replies (PRIMARY CONTROL MECHANISM)
        if (msgType === 'interactive') {
            const buttonId = 
                messageObj.interactive?.button_reply?.id ||
                messageObj.interactive?.list_reply?.id;
            
            console.log('🔘 [BUTTON] Received:', buttonId);
            
            const instruction = getIntentFromButton(buttonId);
            if (instruction) {
                await executeIntent(phone, instruction, null, sellerContext);
            } else {
                await sendMainMenu(phone, sellerContext);
            }
            return;
        }
        
        // Step 3: Handle text messages - ONLY valid during active state flows
        if (msgType === 'text') {
            const messageContent = messageObj.text.body.trim();
            const currentState = getState(phone);
            
            console.log('📝 [TEXT] Content:', messageContent.substring(0, 50), '| State:', currentState.step);
            
            // Check if we're in an active flow
            if (currentState.step !== 'IDLE') {
                await handleStatefulTextInput(phone, messageContent, currentState, sellerContext);
                return;
            }
            
            // Not in a flow - check for greetings to show menu
            const msg = messageContent.toLowerCase();
            if (/^(hi|hello|hey|assalam|salam|menu|start)/i.test(msg)) {
                if (sellerContext.needsOnboarding) {
                    await sendOnboardingWelcome(phone);
                } else {
                    await sendMainMenu(phone, sellerContext);
                }
                return;
            }
            
            // Unrecognized text - prompt with menu
            await sendMessage(phone, "I work best with buttons! Tap below to get started.");
            await sendMainMenu(phone, sellerContext);
            return;
        }
        
        // Step 4: Handle image messages
        if (msgType === 'image') {
            const currentState = getState(phone);
            
            // Only accept images when expecting them
            if (currentState.step === 'AWAITING_IMAGE') {
                const imageUrl = await handleImageUpload(phone, messageObj.image.id);
                if (imageUrl) {
                    setState(phone, 'AWAITING_PRODUCT_DETAILS', 'CREATE_PRODUCT', { imageUrl });
                    await sendMessage(phone, 
                        "✅ Image uploaded!\n\n" +
                        "Now describe your product. Include:\n" +
                        "• Product name\n" +
                        "• Price (in PKR)\n" +
                        "• Any other details\n\n" +
                        "_Example: Yonex Astrox 88D, 15000, brand new_"
                    );
                }
                return;
            }
            
            // Unsolicited image - guide them
            if (sellerContext.needsOnboarding) {
                await sendMessage(phone, "Please complete your registration first!");
                await sendOnboardingWelcome(phone);
            } else {
                await sendMessage(phone, "To add a product, tap 'Add Product' first, then send the image.");
                await sendMainMenu(phone, sellerContext);
            }
            return;
        }
        
        // Step 5: Handle video messages
        if (msgType === 'video') {
            await sendMessage(phone, "🎬 Videos are not supported yet. Please send images!");
            return;
        }
        
        // Unknown message type
        await sendMessage(phone, "I can process text messages, images, and button selections.");
        await sendMainMenu(phone, sellerContext);

    } catch (error) {
        console.error('❌ [PROCESS] Error:', error);
        await sendMessage(phone, "Sorry, something went wrong. Please try again.");
    }
}

/**
 * Handle text input when user is in an active state flow
 */
async function handleStatefulTextInput(phone, text, state, sellerContext) {
    const { step, intent, data } = state;
    
    switch (step) {
        case 'AWAITING_NAME':
            // Save name, ask for store name
            setState(phone, 'AWAITING_STORE_NAME', 'ONBOARDING', { name: text.trim() });
            await sendMessage(phone, `Nice to meet you, *${text.trim()}*! 👋\n\nWhat's your store name?`);
            break;
            
        case 'AWAITING_STORE_NAME':
            // Complete onboarding
            await completeOnboarding(phone, data.name, text.trim());
            break;
            
        case 'AWAITING_PRODUCT_DETAILS':
            // Parse product details and create product
            await createProductFromText(phone, text, data.imageUrl, sellerContext);
            break;
            
        case 'AWAITING_UPDATE_VALUE':
            // Apply the update
            await applyProductUpdate(phone, data.productId, data.field, text, sellerContext);
            break;
            
        default:
            // Unknown state - reset and show menu
            clearState(phone);
            await sendMainMenu(phone, sellerContext);
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

// ============ DEPRECATED: AI-Based Intent Classification ============
// These functions have been disabled in favor of button-driven deterministic flow.
// Kept for reference only - DO NOT INVOKE.

/*
function getLocalIntent(messageContent, sellerContext) {
    // DEPRECATED - AI-based intent parsing removed
    // Use getIntentFromButton() instead with WhatsApp Interactive Messages
    return null;
}

async function getIntentFromN8N(phone, messageType, messageContent, imageUrl, sellerContext) {
    // DEPRECATED - n8n/Groq AI calls removed for cost and scalability
    // Intent is now determined by button IDs only
    console.warn('⚠️ [DEPRECATED] getIntentFromN8N called but disabled');
    return null;
}
*/

// ============ Execute Intent (Button-Driven) ============

/**
 * Execute action based on deterministic button intent
 */
async function executeIntent(phone, instruction, imageUrl, sellerContext) {
    const { intent, action } = instruction;

    console.log('⚡ [EXECUTE] Intent:', intent, 'Action:', JSON.stringify(action));

    switch (intent) {
        // ===== Menu & Navigation =====
        case 'SHOW_MENU':
            await sendMainMenu(phone, sellerContext);
            break;
        
        case 'CANCEL_FLOW':
            clearState(phone);
            await sendMessage(phone, "✅ Cancelled.");
            await sendMainMenu(phone, sellerContext);
            break;

        // ===== Onboarding =====
        case 'ONBOARDING_START':
            setState(phone, 'AWAITING_NAME', 'ONBOARDING');
            await sendMessage(phone, "Welcome! 👋\n\nLet's set up your store.\n\nFirst, what's your name?");
            break;

        // ===== Product CRUD - Initiation =====
        case 'CREATE_PRODUCT':
            if (sellerContext.needsOnboarding) {
                await sendMessage(phone, "Please complete your registration first!");
                await sendOnboardingWelcome(phone);
                return;
            }
            setState(phone, 'AWAITING_IMAGE', 'CREATE_PRODUCT');
            await sendMessage(phone, "📷 Send a photo of your product.\n\n_Make sure it's clear and under 2MB._");
            break;

        case 'LIST_PRODUCTS':
            if (sellerContext.needsOnboarding) {
                await sendMessage(phone, "Please complete your registration first!");
                await sendOnboardingWelcome(phone);
                return;
            }
            await handleListProducts(phone, sellerContext);
            break;

        case 'UPDATE_PRODUCT':
            if (sellerContext.needsOnboarding) {
                await sendMessage(phone, "Please complete your registration first!");
                await sendOnboardingWelcome(phone);
                return;
            }
            await sendProductSelectionList(phone, 'update', sellerContext);
            break;

        case 'DELETE_PRODUCT':
            if (sellerContext.needsOnboarding) {
                await sendMessage(phone, "Please complete your registration first!");
                await sendOnboardingWelcome(phone);
                return;
            }
            await sendProductSelectionList(phone, 'delete', sellerContext);
            break;

        // ===== Product Selection (from list) =====
        case 'UPDATE_PRODUCT_SELECTED':
            await sendUpdateFieldButtons(phone, action.productId);
            break;

        case 'DELETE_PRODUCT_SELECTED':
            await sendDeleteConfirmation(phone, action.productId);
            break;

        // ===== Update Field Selection =====
        case 'UPDATE_FIELD_SELECT':
            const state = getState(phone);
            setState(phone, 'AWAITING_UPDATE_VALUE', 'UPDATE_PRODUCT', { 
                productId: state.data.productId, 
                field: action.field 
            });
            const fieldPrompts = {
                price: "Enter the new price (numbers only, in PKR):",
                stock: "Enter the new stock quantity:",
                name: "Enter the new product name:"
            };
            await sendMessage(phone, fieldPrompts[action.field] || "Enter the new value:");
            break;

        // ===== Delete Confirmation =====
        case 'DELETE_CONFIRM':
            if (action.confirmed) {
                const deleteState = getState(phone);
                await executeProductDeletion(phone, deleteState.data.productId, sellerContext);
            } else {
                clearState(phone);
                await sendMessage(phone, "❌ Delete cancelled.");
                await sendMainMenu(phone, sellerContext);
            }
            break;

        default:
            console.log('⚠️ [EXECUTE] Unknown intent:', intent);
            await sendMainMenu(phone, sellerContext);
            break;
    }
}

// ============ Intent Handlers (Button-Driven) ============

/**
 * Complete seller onboarding with name and storeName
 */
async function completeOnboarding(phone, name, storeName) {
    try {
        const newSeller = new Seller({
            phone: phone,
            name: name,
            storeName: storeName,
            password: 'whatsapp-' + Date.now(),
            onboardingStep: 'complete',
            status: 'pending'
        });

        await newSeller.save();
        clearState(phone);
        pendingSellerContext.delete(phone);
        console.log('👤 [SELLER] New seller created:', phone);

        const welcomeMsg = `🎉 *Welcome, ${name}!*\n\n` +
            `Your store *${storeName}* has been created.\n\n` +
            `📌 *Status:* Pending admin approval\n` +
            `_Your products are private until verified._`;

        await sendMessage(phone, welcomeMsg);
        
        // Refresh context and show main menu
        const newContext = await getSellerContext(phone);
        await sendMainMenu(phone, newContext);

    } catch (error) {
        console.error('❌ [ONBOARD] Error:', error);
        await sendMessage(phone, "Failed to complete registration. Please try again.");
    }
}

/**
 * Parse text input and create product
 */
async function createProductFromText(phone, text, imageUrl, sellerContext) {
    try {
        const seller = await Seller.findOne({ phone: phone });
        
        // Parse the text for product details
        // Expected format: "Product name, price, description" or just description
        const parsed = parseProductDetails(text);
        
        const newProduct = new Product({
            name: parsed.name || 'New Product',
            description: parsed.description || text,
            price: parsed.price || 0,
            stock: parsed.stock || 1,
            category: 'accessories',
            brand: 'Generic',
            images: [imageUrl],
            seller: seller._id
        });

        await newProduct.save();
        clearState(phone);
        console.log('✅ [PRODUCT] Created:', newProduct.name);

        const successMsg = `✅ *Product Created!*\n\n` +
            `📦 *${newProduct.name}*\n` +
            `💰 Price: PKR ${newProduct.price.toLocaleString()}\n` +
            `📊 Stock: ${newProduct.stock}\n\n` +
            (newProduct.price === 0 ? '_💡 Tip: Update the price using the menu._\n\n' : '');

        await sendMessage(phone, successMsg);
        await sendMainMenu(phone, sellerContext);

    } catch (error) {
        console.error('❌ [PRODUCT] Create error:', error);
        await sendMessage(phone, "Failed to create product. Please try again.");
        await sendMainMenu(phone, sellerContext);
    }
}

/**
 * Parse product details from free text
 * Supports: "Name, 5000, description" or "Name - 5000 - description" or just text
 */
function parseProductDetails(text) {
    const result = { name: null, price: 0, description: text, stock: 1 };
    
    // Try comma-separated format: "Name, 5000, description"
    const commaparts = text.split(',').map(p => p.trim());
    if (commaparts.length >= 2) {
        result.name = commaparts[0];
        // Look for price in remaining parts
        for (let i = 1; i < commaparts.length; i++) {
            const priceMatch = commaparts[i].match(/(\d+)/);
            if (priceMatch && !result.price) {
                result.price = parseInt(priceMatch[1]);
            } else if (result.name && !result.price) {
                result.description = commaparts.slice(i).join(', ');
            }
        }
        if (commaparts.length > 2) {
            result.description = commaparts.slice(2).join(', ');
        }
        return result;
    }
    
    // Try to extract price from text (e.g., "5000 rupees" or "Rs 5000" or just "5000")
    const pricePatterns = [
        /(\d+)\s*(?:rupees?|rs\.?|pkr)/i,
        /(?:rupees?|rs\.?|pkr)\s*(\d+)/i,
        /\b(\d{3,})\b/  // Any 3+ digit number
    ];
    
    for (const pattern of pricePatterns) {
        const match = text.match(pattern);
        if (match) {
            result.price = parseInt(match[1]);
            break;
        }
    }
    
    // Use first few words as name if no comma format
    const words = text.split(/\s+/);
    if (words.length > 0) {
        result.name = words.slice(0, Math.min(4, words.length)).join(' ');
    }
    
    return result;
}

/**
 * Apply update to a product field
 */
async function applyProductUpdate(phone, productId, field, value, sellerContext) {
    try {
        const product = await Product.findById(productId);
        
        if (!product) {
            await sendMessage(phone, "❌ Product not found.");
            clearState(phone);
            await sendMainMenu(phone, sellerContext);
            return;
        }

        // Apply the update based on field
        switch (field) {
            case 'price':
                const priceNum = parseInt(value.replace(/[^\d]/g, ''));
                if (isNaN(priceNum)) {
                    await sendMessage(phone, "❌ Invalid price. Please enter numbers only.");
                    return;
                }
                product.price = priceNum;
                break;
            case 'stock':
                const stockNum = parseInt(value);
                if (isNaN(stockNum) || stockNum < 0) {
                    await sendMessage(phone, "❌ Invalid stock. Please enter a valid number.");
                    return;
                }
                product.stock = stockNum;
                break;
            case 'name':
                product.name = value.trim();
                break;
            default:
                await sendMessage(phone, "❌ Unknown field.");
                clearState(phone);
                return;
        }

        await product.save();
        clearState(phone);
        console.log('✅ [PRODUCT] Updated:', product.name, field, '=', value);

        await sendMessage(phone, 
            `✅ *${product.name}* updated!\n\n` +
            `💰 Price: PKR ${product.price.toLocaleString()}\n` +
            `📊 Stock: ${product.stock}`
        );
        await sendMainMenu(phone, sellerContext);

    } catch (error) {
        console.error('❌ [PRODUCT] Update error:', error);
        await sendMessage(phone, "Failed to update product. Please try again.");
        clearState(phone);
    }
}

/**
 * Execute product deletion
 */
async function executeProductDeletion(phone, productId, sellerContext) {
    try {
        const product = await Product.findByIdAndDelete(productId);
        
        if (!product) {
            await sendMessage(phone, "❌ Product not found.");
            clearState(phone);
            await sendMainMenu(phone, sellerContext);
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

        clearState(phone);
        console.log('✅ [PRODUCT] Deleted:', product.name);
        await sendMessage(phone, `✅ *${product.name}* has been deleted.`);
        await sendMainMenu(phone, sellerContext);

    } catch (error) {
        console.error('❌ [PRODUCT] Delete error:', error);
        await sendMessage(phone, "Failed to delete product. Please try again.");
        clearState(phone);
    }
}

/**
 * List products (read-only)
 */
async function handleListProducts(phone, sellerContext) {
    try {
        const seller = await Seller.findOne({ phone: phone });
        const products = await Product.find({ seller: seller._id }).limit(20).sort({ createdAt: -1 });

        if (products.length === 0) {
            await sendMessage(phone, 
                "📦 *Your inventory is empty!*\n\n" +
                "Tap 'Add Product' to add your first item."
            );
            await sendMainMenu(phone, sellerContext);
            return;
        }

        let listMsg = `📦 *Your Products (${products.length})*\n\n`;
        
        products.forEach((p, i) => {
            listMsg += `${i + 1}. *${p.name}*\n`;
            listMsg += `   💰 PKR ${p.price.toLocaleString()} | 📊 Stock: ${p.stock}\n\n`;
        });

        await sendMessage(phone, listMsg);
        await sendMainMenu(phone, sellerContext);

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

// ============ WhatsApp Interactive Messages ============

/**
 * Send interactive buttons (max 3 buttons)
 */
async function sendInteractiveButtons(to, header, body, footer, buttons) {
    console.log('🔘 [BUTTONS] To:', to, 'Count:', buttons.length);
    
    try {
        const interactiveData = {
            type: 'button',
            body: { text: body }
        };
        
        if (header) {
            interactiveData.header = { type: 'text', text: header };
        }
        if (footer) {
            interactiveData.footer = { text: footer };
        }
        
        interactiveData.action = {
            buttons: buttons.slice(0, 3).map(btn => ({
                type: 'reply',
                reply: {
                    id: btn.id,
                    title: btn.title.substring(0, 20) // Max 20 chars
                }
            }))
        };

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
                type: 'interactive',
                interactive: interactiveData,
            },
        });
        console.log('✅ [BUTTONS] Sent');
    } catch (error) {
        console.error('❌ [BUTTONS] Error:', error.response?.data || error.message);
    }
}

/**
 * Send interactive list (for product selection, max 10 items per section)
 */
async function sendInteractiveList(to, header, body, footer, buttonText, sections) {
    console.log('📋 [LIST] To:', to, 'Sections:', sections.length);
    
    try {
        const interactiveData = {
            type: 'list',
            body: { text: body }
        };
        
        if (header) {
            interactiveData.header = { type: 'text', text: header };
        }
        if (footer) {
            interactiveData.footer = { text: footer };
        }
        
        interactiveData.action = {
            button: buttonText.substring(0, 20),
            sections: sections.map(section => ({
                title: section.title.substring(0, 24),
                rows: section.rows.slice(0, 10).map(row => ({
                    id: row.id,
                    title: row.title.substring(0, 24),
                    description: row.description ? row.description.substring(0, 72) : undefined
                }))
            }))
        };

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
                type: 'interactive',
                interactive: interactiveData,
            },
        });
        console.log('✅ [LIST] Sent');
    } catch (error) {
        console.error('❌ [LIST] Error:', error.response?.data || error.message);
    }
}

// ============ Menu & Flow Helpers ============

/**
 * Send main menu with action buttons
 */
async function sendMainMenu(phone, sellerContext) {
    const stoeName = sellerContext.storeName || 'Your Store';
    
    await sendInteractiveButtons(
        phone,
        `🏪 ${stoeName}`,
        `Hello ${sellerContext.name || 'there'}! What would you like to do?`,
        'Tap a button below',
        [
            { id: 'ADD_PRODUCT', title: '➕ Add Product' },
            { id: 'LIST_PRODUCTS', title: '📦 View Products' },
            { id: 'UPDATE_PRODUCT', title: '✏️ Update' }
        ]
    );
}

/**
 * Send onboarding welcome for new users
 */
async function sendOnboardingWelcome(phone) {
    await sendInteractiveButtons(
        phone,
        '👋 Welcome!',
        "I'm your inventory assistant. Let's set up your store in just 2 steps!",
        null,
        [
            { id: 'START_ONBOARDING', title: '🚀 Get Started' }
        ]
    );
}

/**
 * Send product selection list for update/delete operations
 */
async function sendProductSelectionList(phone, operation, sellerContext) {
    try {
        const seller = await Seller.findOne({ phone: phone });
        const products = await Product.find({ seller: seller._id }).limit(10).sort({ createdAt: -1 });

        if (products.length === 0) {
            await sendMessage(phone, "📦 You don't have any products yet!");
            await sendMainMenu(phone, sellerContext);
            return;
        }

        const prefix = operation === 'delete' ? 'DELETE_PRODUCT_' : 'UPDATE_PRODUCT_';
        const actionText = operation === 'delete' ? 'Delete' : 'Update';
        
        const sections = [{
            title: 'Your Products',
            rows: products.map(p => ({
                id: prefix + p._id.toString(),
                title: p.name.substring(0, 24),
                description: `PKR ${p.price.toLocaleString()} | Stock: ${p.stock}`
            }))
        }];

        await sendInteractiveList(
            phone,
            `${actionText} Product`,
            `Select a product to ${operation}:`,
            `${products.length} products found`,
            'Select Product',
            sections
        );
        
        // Store intent for the flow
        setState(phone, 'AWAITING_PRODUCT_SELECTION', operation === 'delete' ? 'DELETE_PRODUCT' : 'UPDATE_PRODUCT');

    } catch (error) {
        console.error('❌ [LIST] Error:', error);
        await sendMessage(phone, "Failed to load products. Please try again.");
    }
}

/**
 * Send update field selection buttons
 */
async function sendUpdateFieldButtons(phone, productId) {
    setState(phone, 'AWAITING_UPDATE_FIELD', 'UPDATE_PRODUCT', { productId });
    
    await sendInteractiveButtons(
        phone,
        'Update Product',
        'What do you want to change?',
        null,
        [
            { id: 'UPDATE_PRICE', title: '💰 Price' },
            { id: 'UPDATE_STOCK', title: '📊 Stock' },
            { id: 'UPDATE_NAME', title: '📝 Name' }
        ]
    );
}

/**
 * Send delete confirmation buttons
 */
async function sendDeleteConfirmation(phone, productId) {
    try {
        const product = await Product.findById(productId);
        if (!product) {
            await sendMessage(phone, "❌ Product not found.");
            return;
        }
        
        setState(phone, 'CONFIRM_DELETE', 'DELETE_PRODUCT', { productId, productName: product.name });
        
        await sendInteractiveButtons(
            phone,
            '⚠️ Confirm Delete',
            `Are you sure you want to delete *${product.name}*?\n\nThis action cannot be undone.`,
            null,
            [
                { id: 'CONFIRM_DELETE_YES', title: '🗑️ Yes, Delete' },
                { id: 'CONFIRM_DELETE_NO', title: '❌ Cancel' }
            ]
        );
    } catch (error) {
        console.error('❌ [DELETE] Error:', error);
        await sendMessage(phone, "Failed to load product. Please try again.");
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
        architecture: 'button-driven-deterministic',
        activeStates: userState.size,
        pendingImages: pendingImageContext.size
    });
});

/**
 * Clear conversation state for a phone (for testing)
 */
router.post('/clear-context/:phone', (req, res) => {
    const phone = req.params.phone;
    userState.delete(phone);
    pendingImageContext.delete(phone);
    pendingSellerContext.delete(phone);
    res.json({ success: true, message: 'All local context cleared for ' + phone });
});

/**
 * Get current state for a phone (for debugging)
 */
router.get('/state/:phone', (req, res) => {
    const phone = req.params.phone;
    const state = getState(phone);
    res.json({ phone, state });
});

module.exports = router;
