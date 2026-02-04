const express = require('express');
const router = express.Router();
const axios = require('axios');
const Seller = require('../models/Seller');
const bcrypt = require('bcrypt');
const { processUserCommand } = require('../services/aiService');
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

        // Check if there's a pending image upload for this user
        const pending = pendingMediaUploads.get(phone);
        
        if (!pending || pending.type !== 'image' || Date.now() > pending.expiresAt) {
            await sendMessage(phone, "📷 I received your image, but I don't know which product to add it to.\n\nSay something like:\n• \"Add images to [product name]\"\n• \"Upload photos for [product name]\"");
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

// Core Logic Handler - ADD LOGGING
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
            await sendMessage(phone, `Awesome! Your store **${text}** is now registered. 🎉\n\nYou can now manage your inventory here.\n\n(AI Integration coming next...)`);
            return;
        }

        // SCENARIO C: Fully Registered User
        if (seller.onboardingStep === 'complete') {
            console.log('🤖 [HANDLER] Seller is complete, calling AI service...');
            
            const aiResult = await processUserCommand(text);
            console.log('🤖 [HANDLER] AI Result:', JSON.stringify(aiResult, null, 2));

            if (aiResult.type === 'REPLY') {
                console.log('📤 [HANDLER] Sending AI reply...');
                await sendMessage(phone, aiResult.text);
            } 
            // CREATE
            else if (aiResult.type === 'ACTION' && aiResult.action === 'CREATE_PRODUCT') {
                const productData = aiResult.data;

                // 🛡️ No more guessing. We trust the AI has gathered everything.
                const finalProductData = {
                    ...productData,
                    seller: seller._id,
                    image: '/images/products/default-racket.jpg'
                };

                // Save to MongoDB
                const newProduct = new Product(finalProductData);
                await newProduct.save();

                const successMsg = `✅ **Product Created!**\n\nName: ${finalProductData.name}\nPrice: $${finalProductData.price}\nStock: ${finalProductData.stock}\nCategory: ${finalProductData.category}\nBrand: ${finalProductData.brand}`;
                await sendMessage(phone, successMsg);
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
                    await sendMessage(phone, `❌ I couldn't find a product named "${searchName}".`);
                    return;
                }

                // Apply updates
                if (newPrice) product.price = newPrice;
                if (newStock) product.stock = newStock;
                if (newDescription) product.description = newDescription;
                
                await product.save();
                await sendMessage(phone, `✅ Updated **${product.name}**.\nPrice: ${product.price}\nStock: ${product.stock}`);
            }

            // DELETE
            else if (aiResult.type === 'ACTION' && aiResult.action === 'DELETE_PRODUCT') {
                const { productName } = aiResult.data;
                
                const deleted = await Product.findOneAndDelete({ 
                    seller: seller._id, 
                    name: { $regex: productName, $options: 'i' } 
                });

                if (deleted) {
                    await sendMessage(phone, `🗑️ Deleted **${deleted.name}** from inventory.`);
                } else {
                    await sendMessage(phone, `❌ I couldn't find "${productName}" to delete.`);
                }
            }

            // LIST
            else if (aiResult.type === 'ACTION' && aiResult.action === 'LIST_PRODUCTS') {
                const { category } = aiResult.data;
                const query = { seller: seller._id };
                if (category) query.category = category.toLowerCase();

                const products = await Product.find(query).limit(10); // Limit to 10 to avoid spamming

                if (products.length === 0) {
                    await sendMessage(phone, "Your inventory is empty.");
                } else {
                    let msg = "📋 **Your Inventory:**\n\n";
                    products.forEach(p => {
                        msg += `• ${p.name} - $${p.price} (${p.stock} left)\n`;
                    });
                    await sendMessage(phone, msg);
                }
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