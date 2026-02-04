const express = require('express');
const router = express.Router();
const axios = require('axios');
const Seller = require('../models/Seller');
const bcrypt = require('bcrypt');
const { 
    processUserCommand, 
    analyzeProductImage,
    processFieldInput,
    getConversationContext,
    updateConversationContext,
    clearConversationContext,
    isCancel,
    isSkip,
    getFieldPrompt,
    formatProductSummary
} = require('../services/aiService');
const Product = require('../models/Product');
const { uploadToCloudinary, deleteFromCloudinary, getPublicIdFromUrl } = require('../config/cloudinary');

// In-memory store for pending media uploads
const pendingMediaUploads = new Map();

// Constants for media constraints
const MAX_IMAGES = 5;
const MAX_IMAGE_SIZE = 2 * 1024 * 1024;
const MAX_VIDEO_DURATION = 20;

// 1. Verification Endpoint (GET)
router.get('/webhook', (req, res) => {
    console.log('🔔 [WEBHOOK GET] Verification request received');
    console.log('🔔 [WEBHOOK GET] Query params:', JSON.stringify(req.query, null, 2));
    
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
            console.log('✅ [WEBHOOK GET] WEBHOOK_VERIFIED');
            res.status(200).send(challenge);
        } else {
            console.log('❌ [WEBHOOK GET] Verification failed - token mismatch');
            res.sendStatus(403);
        }
    } else {
        console.log('❌ [WEBHOOK GET] Missing mode or token');
        res.sendStatus(400);
    }
});

// 2. Message Receiver (POST)
router.post('/webhook', async (req, res) => {
    console.log('\n========== INCOMING WEBHOOK ==========');
    console.log('📨 [WEBHOOK POST] Full body:', JSON.stringify(req.body, null, 2));
    
    const body = req.body;

    if (body.object) {
        console.log('📨 [WEBHOOK POST] Object type:', body.object);
        
        // Check if this is a status update (not a message)
        if (body.entry?.[0]?.changes?.[0]?.value?.statuses) {
            console.log('📊 [WEBHOOK POST] This is a STATUS update, not a message');
            console.log('📊 [WEBHOOK POST] Status:', JSON.stringify(body.entry[0].changes[0].value.statuses, null, 2));
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

            console.log('📱 [WEBHOOK POST] Message FROM:', from);
            console.log('📱 [WEBHOOK POST] Message TYPE:', msgType);
            console.log('📱 [WEBHOOK POST] Full message object:', JSON.stringify(messageObj, null, 2));

            try {
                if (msgType === 'text') {
                    const msgBody = messageObj.text.body;
                    console.log('💬 [WEBHOOK POST] Text message:', msgBody);
                    await handleIncomingMessage(from, msgBody);
                } else if (msgType === 'image') {
                    const imageId = messageObj.image.id;
                    const mimeType = messageObj.image.mime_type;
                    console.log('🖼️ [WEBHOOK POST] Image received, ID:', imageId);
                    await handleIncomingImage(from, imageId, mimeType);
                } else if (msgType === 'video') {
                    const videoId = messageObj.video.id;
                    const mimeType = messageObj.video.mime_type;
                    console.log('🎬 [WEBHOOK POST] Video received, ID:', videoId);
                    await handleIncomingVideo(from, videoId, mimeType);
                } else {
                    console.log('⚠️ [WEBHOOK POST] Unhandled message type:', msgType);
                }
            } catch (error) {
                console.error('❌ [WEBHOOK POST] Error processing message:', error);
            }
        } else {
            console.log('⚠️ [WEBHOOK POST] No messages in webhook payload');
            console.log('⚠️ [WEBHOOK POST] Entry:', JSON.stringify(body.entry, null, 2));
        }
        res.sendStatus(200);
    } else {
        console.log('❌ [WEBHOOK POST] Invalid webhook - no object field');
        res.sendStatus(404);
    }
    console.log('========== END WEBHOOK ==========\n');
});

// Download media from WhatsApp
async function downloadWhatsAppMedia(mediaId) {
    try {
        // Step 1: Get media URL
        const mediaUrlResponse = await axios({
            method: 'GET',
            url: `https://graph.facebook.com/v17.0/${mediaId}`,
            headers: {
                'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
            },
        });

        const mediaUrl = mediaUrlResponse.data.url;
        const fileSize = mediaUrlResponse.data.file_size;

        // Step 2: Download the media
        const mediaResponse = await axios({
            method: 'GET',
            url: mediaUrl,
            headers: {
                'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
            },
            responseType: 'arraybuffer',
        });

        return {
            buffer: Buffer.from(mediaResponse.data),
            fileSize: fileSize
        };
    } catch (error) {
        console.error('Error downloading media:', error.response?.data || error.message);
        throw error;
    }
}

// Handle incoming image
async function handleIncomingImage(phone, imageId, mimeType) {
    try {
        const seller = await Seller.findOne({ phone: phone });
        
        if (!seller || seller.onboardingStep !== 'complete') {
            await sendMessage(phone, "Please complete your registration first before uploading images.");
            return;
        }

        // Check if user is in product creation mode - analyze image for product info
        const context = getConversationContext(phone);
        if (context.mode === 'creating_product') {
            await sendMessage(phone, "🔍 Analyzing your product image...");
            
            try {
                const { buffer } = await downloadWhatsAppMedia(imageId);
                
                // Analyze the image
                const analysis = await analyzeProductImage(buffer, context.pendingProduct);
                
                if (analysis.success && analysis.data) {
                    const imageData = analysis.data;
                    
                    // Merge analyzed data with pending product
                    if (imageData.category && !context.pendingProduct.category) {
                        context.pendingProduct.category = imageData.category;
                    }
                    if (imageData.brand && !context.pendingProduct.brand) {
                        context.pendingProduct.brand = imageData.brand;
                    }
                    if (imageData.condition && !context.pendingProduct.condition) {
                        context.pendingProduct.condition = imageData.condition;
                    }
                    if (imageData.color) {
                        context.pendingProduct.specifications = context.pendingProduct.specifications || {};
                        context.pendingProduct.specifications.color = imageData.color;
                    }
                    if (imageData.description && !context.pendingProduct.description) {
                        context.pendingProduct.description = imageData.description;
                    }
                    if (imageData.suggestedName && !context.pendingProduct.name) {
                        context.pendingProduct.name = imageData.suggestedName;
                    }
                    
                    // Store image buffer temporarily for later upload
                    context.pendingImageBuffer = buffer;
                    
                    // Recalculate missing fields
                    const { getMissingRequiredFields } = require('../services/aiService');
                    context.missingFields = getMissingRequiredFields(context.pendingProduct);
                    
                    updateConversationContext(phone, context);
                    
                    let responseMsg = `✨ *Image Analyzed!*\n\n`;
                    responseMsg += `I detected:\n`;
                    if (imageData.category) responseMsg += `• Category: ${imageData.category}\n`;
                    if (imageData.brand) responseMsg += `• Brand: ${imageData.brand}\n`;
                    if (imageData.condition) responseMsg += `• Condition: ${imageData.condition}\n`;
                    if (imageData.color) responseMsg += `• Color: ${imageData.color}\n`;
                    if (imageData.suggestedName) responseMsg += `• Suggested name: ${imageData.suggestedName}\n`;
                    if (imageData.confidence) responseMsg += `\n(Confidence: ${imageData.confidence})`;
                    
                    if (context.missingFields.length > 0) {
                        responseMsg += `\n\n${formatProductSummary(context.pendingProduct, context.missingFields)}`;
                        responseMsg += `\n\n${getFieldPrompt(context.missingFields[0], context.pendingProduct.category)}`;
                    } else {
                        responseMsg += `\n\n✅ All required fields detected! Creating product...`;
                        
                        // Create the product
                        await handleProductCreation(phone, seller, context.pendingProduct, buffer);
                        return;
                    }
                    
                    await sendMessage(phone, responseMsg);
                    return;
                }
            } catch (analysisError) {
                console.error('Image analysis error:', analysisError);
                // Continue with regular image upload flow
            }
        }

        // Check if there's a pending image upload for this user
        const pending = pendingMediaUploads.get(phone);
        
        if (!pending || pending.type !== 'image' || Date.now() > pending.expiresAt) {
            await sendMessage(phone, "📷 I received your image, but I don't know which product to add it to.\n\nSay something like:\n• \"Add images to [product name]\"\n• \"Upload photos for [product name]\"\n\nOr if you want to create a new product, say \"Create a new product\" and then send the image!");
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
            await sendMessage(phone, `❌ This product already has ${MAX_IMAGES} images (maximum allowed).\n\nTo add more, first delete some images:\n• "Delete image 1 from ${product.name}"\n• "Delete all images from ${product.name}"`);
            return;
        }

        // Download the image
        await sendMessage(phone, "⏳ Uploading image...");
        
        const { buffer, fileSize } = await downloadWhatsAppMedia(imageId);

        // Check file size
        if (fileSize > MAX_IMAGE_SIZE) {
            await sendMessage(phone, `❌ Image is too large (${(fileSize / 1024 / 1024).toFixed(2)}MB).\n\nMaximum allowed: 2MB`);
            return;
        }

        // Upload to Cloudinary
        const result = await uploadToCloudinary(buffer, {
            folder: 'badminton-store/products',
            transformation: [{ width: 1200, height: 1200, crop: 'limit', quality: 'auto' }],
            resource_type: 'image'
        });

        // Add to product images
        product.images.push(result.secure_url);
        await product.save();

        const remaining = MAX_IMAGES - product.images.length;
        let responseMsg = `✅ Image added to **${product.name}**!\n\n📸 Total images: ${product.images.length}/${MAX_IMAGES}`;
        
        if (remaining > 0) {
            responseMsg += `\n\nYou can add ${remaining} more image${remaining > 1 ? 's' : ''}. Just send another photo!`;
        } else {
            responseMsg += "\n\n(Maximum images reached)";
            pendingMediaUploads.delete(phone); // Clear pending since limit reached
        }

        await sendMessage(phone, responseMsg);

    } catch (error) {
        console.error('Error handling image:', error);
        await sendMessage(phone, "❌ Failed to upload image. Please try again.");
    }
}

// Handle incoming video
async function handleIncomingVideo(phone, videoId, mimeType) {
    try {
        const seller = await Seller.findOne({ phone: phone });
        
        if (!seller || seller.onboardingStep !== 'complete') {
            await sendMessage(phone, "Please complete your registration first before uploading videos.");
            return;
        }

        // Check if there's a pending video upload for this user
        const pending = pendingMediaUploads.get(phone);
        
        if (!pending || pending.type !== 'video' || Date.now() > pending.expiresAt) {
            await sendMessage(phone, "🎬 I received your video, but I don't know which product to add it to.\n\nSay something like:\n• \"Add video to [product name]\"\n• \"Upload video for [product name]\"");
            return;
        }

        // Find the product
        const product = await Product.findOne({ _id: pending.productId, seller: seller._id });
        
        if (!product) {
            pendingMediaUploads.delete(phone);
            await sendMessage(phone, "❌ Product not found. Please try again.");
            return;
        }

        await sendMessage(phone, "⏳ Uploading video... (this may take a moment)");

        // Download the video
        const { buffer } = await downloadWhatsAppMedia(videoId);

        // Delete old video from Cloudinary if exists
        if (product.video && product.video.publicId) {
            await deleteFromCloudinary(product.video.publicId, 'video');
        }

        // Upload to Cloudinary
        const result = await uploadToCloudinary(buffer, {
            folder: 'badminton-store/videos',
            resource_type: 'video',
            eager: [{ format: 'mp4' }]
        });

        // Check video duration (Cloudinary returns this in the result)
        if (result.duration && result.duration > MAX_VIDEO_DURATION) {
            // Delete the uploaded video since it's too long
            await deleteFromCloudinary(result.public_id, 'video');
            await sendMessage(phone, `❌ Video is too long (${Math.round(result.duration)} seconds).\n\nMaximum allowed: ${MAX_VIDEO_DURATION} seconds\n\nPlease send a shorter video.`);
            return;
        }

        // Update product with new video
        product.video = {
            url: result.secure_url,
            publicId: result.public_id
        };
        await product.save();

        pendingMediaUploads.delete(phone); // Clear pending
        
        await sendMessage(phone, `✅ Video added to **${product.name}**!\n\n🎬 Duration: ${Math.round(result.duration || 0)} seconds`);

    } catch (error) {
        console.error('Error handling video:', error);
        await sendMessage(phone, "❌ Failed to upload video. Please try again.");
    }
}

// Helper function to handle product creation with all validations
async function handleProductCreation(phone, seller, productData, imageBuffer = null) {
    try {
        console.log('📦 [CREATE] Creating product with data:', JSON.stringify(productData));
        
        // Set defaults for optional fields
        const finalProductData = {
            name: productData.name,
            category: productData.category.toLowerCase(),
            price: productData.price,
            description: productData.description || `${productData.name} - Quality badminton equipment`,
            brand: productData.brand || '',
            stock: productData.stock || 1,
            condition: productData.condition || 'new',
            seller: seller._id,
            images: [],
            specifications: productData.specifications || {}
        };
        
        // Add category-specific specs if provided
        if (productData.category === 'rackets' && productData.racketSpecs) {
            finalProductData.racketSpecs = productData.racketSpecs;
        }
        if (productData.category === 'shoes' && productData.shoeSpecs) {
            finalProductData.shoeSpecs = productData.shoeSpecs;
        }
        // Add more category specs as needed
        
        // If there's a pending image, upload it
        if (imageBuffer) {
            try {
                const result = await uploadToCloudinary(imageBuffer, {
                    folder: 'badminton-store/products',
                    transformation: [{ width: 1200, height: 1200, crop: 'limit', quality: 'auto' }],
                    resource_type: 'image'
                });
                finalProductData.images.push(result.secure_url);
            } catch (uploadError) {
                console.error('Image upload error:', uploadError);
                // Continue without image
            }
        }
        
        // Save to MongoDB
        const newProduct = new Product(finalProductData);
        await newProduct.save();
        
        // Clear conversation context
        clearConversationContext(phone);
        
        // Build success message
        let successMsg = `✅ *Product Created Successfully!*\n\n`;
        successMsg += `📦 *${finalProductData.name}*\n\n`;
        successMsg += `• Category: ${finalProductData.category}\n`;
        successMsg += `• Price: PKR ${finalProductData.price}\n`;
        successMsg += `• Stock: ${finalProductData.stock}\n`;
        if (finalProductData.brand) successMsg += `• Brand: ${finalProductData.brand}\n`;
        if (finalProductData.condition) successMsg += `• Condition: ${finalProductData.condition}\n`;
        if (finalProductData.images.length > 0) successMsg += `• Images: ${finalProductData.images.length}\n`;
        
        successMsg += `\n📸 To add images, say: "Add images to ${finalProductData.name}"`;
        
        await sendMessage(phone, successMsg);
        
    } catch (error) {
        console.error('Product creation error:', error);
        await sendMessage(phone, `❌ Failed to create product: ${error.message}\n\nPlease try again.`);
    }
}

// Core Logic Handler - WITH CONTEXT AWARENESS
async function handleIncomingMessage(phone, text) {
    console.log('\n---------- HANDLE MESSAGE ----------');
    console.log('🔄 [HANDLER] Processing message from:', phone);
    console.log('🔄 [HANDLER] Message text:', text);
    
    try {
        // 1. Find the seller by phone
        console.log('🔍 [HANDLER] Looking up seller with phone:', phone);
        let seller = await Seller.findOne({ phone: phone });
        console.log('🔍 [HANDLER] Seller found:', seller ? `Yes - ${seller.name} (${seller.onboardingStep})` : 'No');

        // SCENARIO A: New User (Start Signup)
        if (!seller) {
            console.log('👤 [HANDLER] New user - creating placeholder account');
            const dummyPassword = await bcrypt.hash(Date.now().toString(), 10);
            
            seller = new Seller({
                phone: phone,
                name: 'Pending',
                storeName: 'Pending',
                password: dummyPassword,
                onboardingStep: 'new'
            });
            await seller.save();
            console.log('👤 [HANDLER] New seller saved with ID:', seller._id);

            console.log('📤 [HANDLER] Sending welcome message...');
            await sendMessage(phone, "Welcome to Badminton Store Manager! 🏸\n\nI see you are new here. Let's get you set up.\n\nFirst, what is your **Full Name**?");
            return;
        }

        // SCENARIO B: User is in Onboarding Flow
        if (seller.onboardingStep === 'new') {
            console.log('📝 [HANDLER] Onboarding step: new -> name_entered');
            seller.name = text;
            seller.onboardingStep = 'name_entered';
            await seller.save();

            console.log('📤 [HANDLER] Sending name confirmation...');
            await sendMessage(phone, `Nice to meet you, ${text}! 👋\n\nNow, what is the name of your **Store**?`);
            return;
        }

        if (seller.onboardingStep === 'name_entered') {
            console.log('📝 [HANDLER] Onboarding step: name_entered -> complete');
            seller.storeName = text;
            seller.onboardingStep = 'complete';
            await seller.save();

            console.log('📤 [HANDLER] Sending registration complete message...');
            await sendMessage(phone, `Awesome! Your store **${text}** is now registered. 🎉\n\nYou can now manage your inventory. Try:\n• "Add a new Yonex Astrox 88D racket for 25000"\n• "List my products"\n• "Update price of [product] to 20000"\n\nI'll help you every step of the way!`);
            return;
        }

        // SCENARIO C: Fully Registered User
        if (seller.onboardingStep === 'complete') {
            console.log('🤖 [HANDLER] Seller is complete, checking conversation context...');
            
            // Check for cancel command
            if (isCancel(text)) {
                clearConversationContext(phone);
                pendingMediaUploads.delete(phone);
                await sendMessage(phone, "✅ Operation cancelled. How can I help you?");
                return;
            }
            
            // Get current conversation context
            const context = getConversationContext(phone);
            console.log('🔄 [HANDLER] Context mode:', context.mode);
            console.log('🔄 [HANDLER] Pending product:', JSON.stringify(context.pendingProduct));
            console.log('🔄 [HANDLER] Missing fields:', context.missingFields);
            
            // SCENARIO C1: User is in the middle of creating a product (providing missing fields)
            if (context.mode === 'creating_product' && context.missingFields.length > 0) {
                console.log('📝 [HANDLER] Processing field input for:', context.missingFields[0]);
                
                // Check for skip on optional fields
                const currentField = context.missingFields[0];
                const optionalFields = ['description', 'brand', 'stock', 'condition'];
                
                if (isSkip(text) && optionalFields.includes(currentField)) {
                    // Skip this optional field
                    context.missingFields.shift();
                    updateConversationContext(phone, context);
                    
                    if (context.missingFields.length > 0) {
                        const nextField = context.missingFields[0];
                        await sendMessage(phone, `👍 Skipped.\n\n${getFieldPrompt(nextField, context.pendingProduct.category)}`);
                    } else {
                        // All done - create product
                        await handleProductCreation(phone, seller, context.pendingProduct);
                    }
                    return;
                }
                
                // Process the field input
                const fieldResult = await processFieldInput(phone, text);
                
                if (fieldResult) {
                    if (fieldResult.type === 'VALIDATION_ERROR') {
                        await sendMessage(phone, fieldResult.error);
                        return;
                    }
                    
                    if (fieldResult.type === 'NEED_MORE_INFO') {
                        let msg = `✅ Got it!\n\n${fieldResult.summary}\n\n${fieldResult.prompt}`;
                        await sendMessage(phone, msg);
                        return;
                    }
                    
                    if (fieldResult.type === 'ACTION' && fieldResult.action === 'CREATE_PRODUCT') {
                        await handleProductCreation(phone, seller, fieldResult.data);
                        return;
                    }
                }
            }
            
            // SCENARIO C2: Regular AI processing
            console.log('🤖 [HANDLER] Calling AI service with context...');
            const aiResult = await processUserCommand(text, phone);
            console.log('🤖 [HANDLER] AI Result:', JSON.stringify(aiResult, null, 2));

            if (aiResult.type === 'REPLY') {
                console.log('📤 [HANDLER] Sending AI reply...');
                await sendMessage(phone, aiResult.text);
            }
            
            // NEED MORE INFO - Start multi-turn product creation
            else if (aiResult.type === 'NEED_MORE_INFO') {
                let msg = `📦 *Let's create your product!*\n\n`;
                msg += aiResult.summary;
                msg += `\n\n${aiResult.prompt}`;
                msg += `\n\n_(Say "cancel" anytime to abort)_`;
                await sendMessage(phone, msg);
            }
            
            // CREATE - All fields present
            else if (aiResult.type === 'ACTION' && aiResult.action === 'CREATE_PRODUCT') {
                await handleProductCreation(phone, seller, aiResult.data);
            }

            // UPDATE
            else if (aiResult.type === 'ACTION' && aiResult.action === 'UPDATE_PRODUCT') {
                const { searchName, newPrice, newStock, newDescription } = aiResult.data;
                
                // Find product by name AND seller (security)
                // Using regex for case-insensitive partial match
                const product = await Product.findOne({ 
                    seller: seller._id, 
                    name: { $regex: searchName, $options: 'i' } 
                });

                if (!product) {
                    await sendMessage(phone, `❌ I couldn't find a product named "${searchName}".\n\nTry "List my products" to see your inventory.`);
                    return;
                }

                // Track what's being updated
                const updates = [];
                
                // Apply updates
                if (newPrice !== undefined && newPrice !== null) {
                    product.price = newPrice;
                    updates.push(`Price: PKR ${newPrice}`);
                }
                if (newStock !== undefined && newStock !== null) {
                    product.stock = newStock;
                    updates.push(`Stock: ${newStock}`);
                }
                if (newDescription) {
                    product.description = newDescription;
                    updates.push(`Description updated`);
                }
                
                if (updates.length === 0) {
                    await sendMessage(phone, `❌ No changes specified. What would you like to update?\n\nExamples:\n• "Update ${product.name} price to 15000"\n• "Set stock of ${product.name} to 5"`);
                    return;
                }
                
                await product.save();
                await sendMessage(phone, `✅ Updated *${product.name}*!\n\n${updates.join('\n')}`);
            }

            // DELETE
            else if (aiResult.type === 'ACTION' && aiResult.action === 'DELETE_PRODUCT') {
                const { productName } = aiResult.data;
                
                const deleted = await Product.findOneAndDelete({ 
                    seller: seller._id, 
                    name: { $regex: productName, $options: 'i' } 
                });

                if (deleted) {
                    // Also delete images from Cloudinary
                    if (deleted.images && deleted.images.length > 0) {
                        for (const imgUrl of deleted.images) {
                            const publicId = getPublicIdFromUrl(imgUrl);
                            if (publicId) {
                                await deleteFromCloudinary(publicId, 'image').catch(() => {});
                            }
                        }
                    }
                    if (deleted.video && deleted.video.publicId) {
                        await deleteFromCloudinary(deleted.video.publicId, 'video').catch(() => {});
                    }
                    
                    await sendMessage(phone, `🗑️ Deleted *${deleted.name}* from inventory.`);
                } else {
                    await sendMessage(phone, `❌ I couldn't find "${productName}" to delete.\n\nTry "List my products" to see your inventory.`);
                }
            }

            // LIST
            else if (aiResult.type === 'ACTION' && aiResult.action === 'LIST_PRODUCTS') {
                const { category } = aiResult.data;
                const query = { seller: seller._id };
                if (category) query.category = category.toLowerCase();

                const products = await Product.find(query).limit(15).sort({ createdAt: -1 });

                if (products.length === 0) {
                    let msg = category 
                        ? `No products found in the "${category}" category.` 
                        : "Your inventory is empty.";
                    msg += "\n\nTo add a product, say something like:\n• \"Add Yonex Astrox 99 racket for 28000\"";
                    await sendMessage(phone, msg);
                } else {
                    let msg = category 
                        ? `📋 *${category.charAt(0).toUpperCase() + category.slice(1)} Inventory:*\n\n`
                        : "📋 *Your Inventory:*\n\n";
                    
                    products.forEach((p, i) => {
                        const stockEmoji = p.stock > 5 ? '🟢' : p.stock > 0 ? '🟡' : '🔴';
                        msg += `${i + 1}. *${p.name}*\n`;
                        msg += `   💰 PKR ${p.price || 'N/A'} ${stockEmoji} ${p.stock} in stock\n\n`;
                    });
                    
                    if (products.length >= 15) {
                        msg += `_(Showing first 15 products)_`;
                    }
                    
                    await sendMessage(phone, msg);
                }
            }
            
            // SHOW HELP
            else if (aiResult.type === 'ACTION' && aiResult.action === 'SHOW_HELP') {
                const helpMsg = `🏸 *Badminton Store Manager - Help*\n\n` +
                    `Here's what I can do for you:\n\n` +
                    `*📦 Product Management:*\n` +
                    `• "Add a Yonex Astrox 99 racket for 25000" - Create product\n` +
                    `• "Create new product" - Start guided creation\n` +
                    `• "List my products" - View inventory\n` +
                    `• "Show rackets" - List by category\n` +
                    `• "Update price of [product] to 20000"\n` +
                    `• "Delete [product name]"\n\n` +
                    `*📸 Images & Video:*\n` +
                    `• "Add images to [product]" - Then send photos\n` +
                    `• "Delete image 1 from [product]"\n` +
                    `• "Add video to [product]"\n` +
                    `• "View media of [product]"\n\n` +
                    `*🎯 Smart Features:*\n` +
                    `• Send a product photo - I'll analyze it!\n` +
                    `• Natural language - Just describe what you want\n` +
                    `• "Cancel" - Abort current operation\n` +
                    `• "Status" - See pending operations\n\n` +
                    `*📁 Categories:*\n` +
                    `rackets, shoes, bags, apparel, shuttles, accessories\n\n` +
                    `Just type naturally - I'll understand! 🤖`;
                
                await sendMessage(phone, helpMsg);
            }
            
            // SHOW STATUS
            else if (aiResult.type === 'ACTION' && aiResult.action === 'SHOW_STATUS') {
                const ctx = getConversationContext(phone);
                let statusMsg = `📊 *Current Status*\n\n`;
                
                if (ctx.mode === 'creating_product') {
                    statusMsg += `🔄 You're creating a product:\n\n`;
                    statusMsg += formatProductSummary(ctx.pendingProduct, ctx.missingFields);
                    statusMsg += `\n\nSay "cancel" to abort, or provide the missing info.`;
                } else {
                    statusMsg += `✅ No pending operations.\n\n`;
                    statusMsg += `Ready for your next command! Say "help" for options.`;
                }
                
                // Check for pending media uploads
                const pending = pendingMediaUploads.get(phone);
                if (pending && Date.now() < pending.expiresAt) {
                    const product = await Product.findById(pending.productId);
                    if (product) {
                        statusMsg += `\n\n📸 Waiting for ${pending.type} upload for *${product.name}*`;
                    }
                }
                
                await sendMessage(phone, statusMsg);
            }
            
            // ADD PRODUCT IMAGES (prepare for upload)
            else if (aiResult.type === 'ACTION' && aiResult.action === 'ADD_PRODUCT_IMAGES') {
                const { productName } = aiResult.data;
                
                const product = await Product.findOne({ 
                    seller: seller._id, 
                    name: { $regex: productName, $options: 'i' } 
                });

                if (!product) {
                    await sendMessage(phone, `❌ I couldn't find a product named "${productName}".`);
                    return;
                }

                if (product.images.length >= MAX_IMAGES) {
                    await sendMessage(phone, `❌ **${product.name}** already has ${MAX_IMAGES} images (maximum).\n\nTo add more, first delete some:\n• "Delete image 1 from ${product.name}"\n• "Delete all images from ${product.name}"`);
                    return;
                }

                // Set pending upload state (expires in 5 minutes)
                pendingMediaUploads.set(phone, {
                    productId: product._id,
                    type: 'image',
                    expiresAt: Date.now() + 5 * 60 * 1000
                });

                const remaining = MAX_IMAGES - product.images.length;
                await sendMessage(phone, `📸 Ready to receive images for **${product.name}**!\n\nCurrent images: ${product.images.length}/${MAX_IMAGES}\nYou can add up to ${remaining} more.\n\n**Constraints:**\n• Max 2MB per image\n• JPG, PNG, WebP\n\nSend me the image(s) now! (This expires in 5 minutes)`);
            }

            // DELETE SPECIFIC IMAGE
            else if (aiResult.type === 'ACTION' && aiResult.action === 'DELETE_PRODUCT_IMAGE') {
                const { productName, imageNumber } = aiResult.data;
                
                const product = await Product.findOne({ 
                    seller: seller._id, 
                    name: { $regex: productName, $options: 'i' } 
                });

                if (!product) {
                    await sendMessage(phone, `❌ I couldn't find a product named "${productName}".`);
                    return;
                }

                if (!product.images || product.images.length === 0) {
                    await sendMessage(phone, `❌ **${product.name}** has no images to delete.`);
                    return;
                }

                const imgIndex = Math.round(imageNumber) - 1;
                if (imgIndex < 0 || imgIndex >= product.images.length) {
                    await sendMessage(phone, `❌ Invalid image number. **${product.name}** has ${product.images.length} image(s).\n\nUse a number between 1 and ${product.images.length}.`);
                    return;
                }

                // Delete from Cloudinary
                const imgUrl = product.images[imgIndex];
                const publicId = getPublicIdFromUrl(imgUrl);
                if (publicId) {
                    await deleteFromCloudinary(publicId, 'image');
                }

                // Remove from product
                product.images.splice(imgIndex, 1);
                await product.save();

                await sendMessage(phone, `✅ Deleted image #${imageNumber} from **${product.name}**.\n\n📸 Remaining images: ${product.images.length}/${MAX_IMAGES}`);
            }

            // DELETE ALL IMAGES
            else if (aiResult.type === 'ACTION' && aiResult.action === 'DELETE_ALL_PRODUCT_IMAGES') {
                const { productName } = aiResult.data;
                
                const product = await Product.findOne({ 
                    seller: seller._id, 
                    name: { $regex: productName, $options: 'i' } 
                });

                if (!product) {
                    await sendMessage(phone, `❌ I couldn't find a product named "${productName}".`);
                    return;
                }

                if (!product.images || product.images.length === 0) {
                    await sendMessage(phone, `❌ **${product.name}** has no images to delete.`);
                    return;
                }

                const imageCount = product.images.length;

                // Delete all from Cloudinary
                for (const imgUrl of product.images) {
                    const publicId = getPublicIdFromUrl(imgUrl);
                    if (publicId) {
                        await deleteFromCloudinary(publicId, 'image');
                    }
                }

                // Clear images array
                product.images = [];
                await product.save();

                await sendMessage(phone, `✅ Deleted all ${imageCount} image(s) from **${product.name}**.`);
            }

            // ADD PRODUCT VIDEO (prepare for upload)
            else if (aiResult.type === 'ACTION' && aiResult.action === 'ADD_PRODUCT_VIDEO') {
                const { productName } = aiResult.data;
                
                const product = await Product.findOne({ 
                    seller: seller._id, 
                    name: { $regex: productName, $options: 'i' } 
                });

                if (!product) {
                    await sendMessage(phone, `❌ I couldn't find a product named "${productName}".`);
                    return;
                }

                // Set pending upload state (expires in 5 minutes)
                pendingMediaUploads.set(phone, {
                    productId: product._id,
                    type: 'video',
                    expiresAt: Date.now() + 5 * 60 * 1000
                });

                let msg = `🎬 Ready to receive video for **${product.name}**!\n\n`;
                if (product.video && product.video.url) {
                    msg += "⚠️ This product already has a video. Sending a new one will replace it.\n\n";
                }
                msg += `**Constraints:**\n• Max ${MAX_VIDEO_DURATION} seconds\n• MP4, MOV, WebM\n\nSend me the video now! (This expires in 5 minutes)`;

                await sendMessage(phone, msg);
            }

            // DELETE PRODUCT VIDEO
            else if (aiResult.type === 'ACTION' && aiResult.action === 'DELETE_PRODUCT_VIDEO') {
                const { productName } = aiResult.data;
                
                const product = await Product.findOne({ 
                    seller: seller._id, 
                    name: { $regex: productName, $options: 'i' } 
                });

                if (!product) {
                    await sendMessage(phone, `❌ I couldn't find a product named "${productName}".`);
                    return;
                }

                if (!product.video || !product.video.url) {
                    await sendMessage(phone, `❌ **${product.name}** has no video to delete.`);
                    return;
                }

                // Delete from Cloudinary
                if (product.video.publicId) {
                    await deleteFromCloudinary(product.video.publicId, 'video');
                }

                // Clear video
                product.video = null;
                await product.save();

                await sendMessage(phone, `✅ Deleted video from **${product.name}**.`);
            }

            // VIEW PRODUCT MEDIA
            else if (aiResult.type === 'ACTION' && aiResult.action === 'VIEW_PRODUCT_MEDIA') {
                const { productName } = aiResult.data;
                
                const product = await Product.findOne({ 
                    seller: seller._id, 
                    name: { $regex: productName, $options: 'i' } 
                });

                if (!product) {
                    await sendMessage(phone, `❌ I couldn't find a product named "${productName}".`);
                    return;
                }

                let msg = `📎 **Media for ${product.name}:**\n\n`;
                
                // Images
                msg += `📸 **Images:** ${product.images?.length || 0}/${MAX_IMAGES}\n`;
                if (product.images && product.images.length > 0) {
                    product.images.forEach((img, i) => {
                        msg += `  ${i + 1}. ✓ Image ${i + 1}\n`;
                    });
                } else {
                    msg += "  (No images)\n";
                }

                msg += `\n🎬 **Video:** `;
                if (product.video && product.video.url) {
                    msg += "✓ Has video";
                } else {
                    msg += "(No video)";
                }

                msg += "\n\n**Commands:**\n";
                msg += `• "Add images to ${product.name}"\n`;
                msg += `• "Delete image 1 from ${product.name}"\n`;
                msg += `• "Add video to ${product.name}"\n`;
                msg += `• "Delete video from ${product.name}"`;

                await sendMessage(phone, msg);
            }
            
            // ERROR
            else if (aiResult.type === 'ERROR') {
                await sendMessage(phone, `⚠️ ${aiResult.text}`);
            }
            
            // CHAT
            else {
                await sendMessage(phone, aiResult.text || "I didn't understand.");
            }
        }

    } catch (error) {
        console.error('❌ [HANDLER] Error:', error.message);
        console.error('❌ [HANDLER] Stack:', error.stack);
        await sendMessage(phone, "Sorry, I encountered an error processing your request.");
    }
    console.log('---------- END HANDLE MESSAGE ----------\n');
}

// Helper function to send messages - ADD DETAILED LOGGING
async function sendMessage(to, text) {
    console.log('\n>>>>>> SEND MESSAGE <<<<<<');
    console.log('📤 [SEND] To:', to);
    console.log('📤 [SEND] Text:', text.substring(0, 100) + (text.length > 100 ? '...' : ''));
    console.log('📤 [SEND] Phone Number ID:', process.env.WHATSAPP_PHONE_NUMBER_ID);
    console.log('📤 [SEND] Access Token (first 20 chars):', process.env.WHATSAPP_ACCESS_TOKEN?.substring(0, 20) + '...');
    
    const url = `https://graph.facebook.com/v17.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
    console.log('📤 [SEND] URL:', url);
    
    const payload = {
        messaging_product: 'whatsapp',
        to: to,
        text: { body: text },
    };
    console.log('📤 [SEND] Payload:', JSON.stringify(payload, null, 2));
    
    try {
        const response = await axios({
            method: 'POST',
            url: url,
            headers: {
                'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
                'Content-Type': 'application/json',
            },
            data: payload,
        });
        console.log('✅ [SEND] Success! Response:', JSON.stringify(response.data, null, 2));
    } catch (error) {
        console.error('❌ [SEND] Error status:', error.response?.status);
        console.error('❌ [SEND] Error data:', JSON.stringify(error.response?.data, null, 2));
        console.error('❌ [SEND] Error message:', error.message);
    }
    console.log('>>>>>> END SEND MESSAGE <<<<<<\n');
}

module.exports = router;