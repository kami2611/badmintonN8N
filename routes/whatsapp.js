const express = require('express');
const router = express.Router();
const axios = require('axios');
const Seller = require('../models/Seller'); // Import Seller Model
const bcrypt = require('bcrypt'); // Needed to generate dummy password
const { processUserCommand } = require('../services/aiService'); // Import AI Service
const Product = require('../models/Product'); // Import Product Model

// 1. Verification Endpoint (GET) - Keep this as is
router.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
            console.log('WEBHOOK_VERIFIED');
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    }
});

// 2. Message Receiver (POST)
router.post('/webhook', async (req, res) => {
    const body = req.body;

    if (body.object) {
        if (
            body.entry &&
            body.entry[0].changes &&
            body.entry[0].changes[0].value.messages &&
            body.entry[0].changes[0].value.messages[0]
        ) {
            const messageObj = body.entry[0].changes[0].value.messages[0];
            const from = messageObj.from; // Phone number
            const msgBody = messageObj.text ? messageObj.text.body : '';

            // Only process text messages for now
            if (msgBody) {
                await handleIncomingMessage(from, msgBody);
            }
        }
        res.sendStatus(200);
    } else {
        res.sendStatus(404);
    }
});

// Core Logic Handler
async function handleIncomingMessage(phone, text) {
    try {
        // 1. Find the seller by phone
        let seller = await Seller.findOne({ phone: phone });

        // SCENARIO A: New User (Start Signup)
        if (!seller) {
            // Create a placeholder account
            // We generate a random password because the model requires it
            const dummyPassword = await bcrypt.hash(Date.now().toString(), 10);
            
            seller = new Seller({
                phone: phone,
                name: 'Pending', // Temporary
                storeName: 'Pending', // Temporary
                password: dummyPassword,
                onboardingStep: 'new'
            });
            await seller.save();

            await sendMessage(phone, "Welcome to Badminton Store Manager! 🏸\n\nI see you are new here. Let's get you set up.\n\nFirst, what is your **Full Name**?");
            return;
        }

        // SCENARIO B: User is in Onboarding Flow
        if (seller.onboardingStep === 'new') {
            // The user just sent their name
            seller.name = text;
            seller.onboardingStep = 'name_entered';
            await seller.save();

            await sendMessage(phone, `Nice to meet you, ${text}! 👋\n\nNow, what is the name of your **Store**?`);
            return;
        }

        if (seller.onboardingStep === 'name_entered') {
            // The user just sent their store name
            seller.storeName = text;
            seller.onboardingStep = 'complete';
            await seller.save();

            await sendMessage(phone, `Awesome! Your store **${text}** is now registered. 🎉\n\nYou can now manage your inventory here.\n\n(AI Integration coming next...)`);
            return;
        }

        // SCENARIO C: Fully Registered User
        if (seller.onboardingStep === 'complete') {
            
            // 1. Send "Thinking..." indicator (Optional but good UX)
            // await sendMessage(phone, "Thinking... 🤔");

            // 2. Ask AI what to do
            const aiResult = await processUserCommand(text);

            if (aiResult.type === 'REPLY') {
                // The AI just wants to chat (e.g., "Hello")
                await sendMessage(phone, aiResult.text);
            } 
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
            else {
                await sendMessage(phone, "I didn't understand that command.");
            }
        }

    } catch (error) {
        console.error('Error processing message:', error);
        await sendMessage(phone, "Sorry, I encountered an error processing your request.");
    }
}

// Helper function to send messages
async function sendMessage(to, text) {
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
    } catch (error) {
        console.error('Error sending message:', error.response ? error.response.data : error.message);
    }
}

module.exports = router;