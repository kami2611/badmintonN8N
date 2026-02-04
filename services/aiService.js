const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ========== AI Product Analysis for Form Auto-Fill (Text Only - No Vision) ==========

/**
 * Generate product details based on product name and category
 * @param {string} productName - Product name entered by seller
 * @param {string} category - Product category
 * @returns {Object} Suggested field values
 */
async function analyzeProductForForm(productName, category) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        
        // Build category-specific prompt
        const prompt = buildCategoryPrompt(productName, category);
        
        const result = await model.generateContent(prompt);
        
        const response = result.response;
        const text = response.text();
        
        // Parse JSON from response
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            return { success: true, data: parsed };
        }
        
        return { success: false, error: 'Could not parse AI response' };
        
    } catch (error) {
        console.error('AI Product Analysis Error:', error.message);
        return { success: false, error: error.message };
    }
}

function buildCategoryPrompt(productName, category) {
    const basePrompt = `You are a badminton product expert. The seller has named this product: "${productName}".
Category: ${category}

Based on the product name, provide realistic product details in JSON format. Use your knowledge of badminton equipment to suggest appropriate specifications.

IMPORTANT RULES:
1. Return ONLY valid JSON, no markdown, no explanation
2. For fields you cannot determine from the name, use empty string "" or leave as default
3. Price should be in Pakistani Rupees (PKR) - estimate realistic market price
4. Description should be 2-3 sentences, appealing for e-commerce
5. Try to identify the brand from the product name if mentioned

`;

    const categoryFields = {
        rackets: `Return this JSON structure:
{
    "brand": "brand name if visible, or guess from design",
    "description": "product description",
    "price": estimated price number,
    "condition": "new" or "used",
    "color": "main colors",
    "weightClass": "2U" or "3U" or "4U" or "5U" or "",
    "gripSize": "G4" or "G5" or "G6" or "G7" or "",
    "flexibility": "extra-stiff" or "stiff" or "medium" or "flexible" or "",
    "balance": "head-heavy" or "even" or "head-light" or "",
    "stringStatus": "strung" or "unstrung" or "",
    "frameMaterial": "material if known"
}`,
        
        shoes: `Return this JSON structure:
{
    "brand": "brand name if visible",
    "description": "product description",
    "price": estimated price number,
    "condition": "new" or "used",
    "color": "main colors",
    "sizeEU": "EU size if visible or common size",
    "width": "narrow" or "standard" or "wide" or "",
    "closureType": "lace-up" or "velcro" or "slip-on" or "",
    "soleType": "sole description"
}`,
        
        bags: `Return this JSON structure:
{
    "brand": "brand name if visible",
    "description": "product description",
    "price": estimated price number,
    "condition": "new" or "used",
    "color": "main colors",
    "capacity": "3-racket" or "6-racket" or "9-racket" or "12-racket" or "",
    "bagType": "backpack" or "duffel" or "thermal" or "tote" or "",
    "compartments": estimated number or 0,
    "hasShoeCompartment": true or false,
    "hasThermalLining": true or false
}`,
        
        apparel: `Return this JSON structure:
{
    "brand": "brand name if visible",
    "description": "product description",
    "price": estimated price number,
    "condition": "new" or "used",
    "color": "main colors",
    "apparelType": "t-shirt" or "polo" or "shorts" or "skirt" or "jacket" or "tracksuit" or "",
    "apparelSize": "XS" or "S" or "M" or "L" or "XL" or "2XL" or "3XL" or "",
    "gender": "men" or "women" or "unisex" or "",
    "fabricType": "fabric type"
}`,
        
        shuttles: `Return this JSON structure:
{
    "brand": "brand name if visible",
    "description": "product description",
    "price": estimated price number,
    "condition": "new",
    "shuttleType": "feather" or "nylon" or "",
    "speed": "75" or "76" or "77" or "78" or "79" or "",
    "quantityPerTube": number (usually 12),
    "grade": "grade if visible"
}`,
        
        accessories: `Return this JSON structure:
{
    "brand": "brand name if visible",
    "description": "product description",
    "price": estimated price number,
    "condition": "new" or "used",
    "color": "main colors",
    "accessoryType": "grip" or "string" or "towel" or "wristband" or "headband" or "socks" or "other" or "",
    "packQuantity": number in pack
}`
    };
    
    return basePrompt + (categoryFields[category] || categoryFields.accessories);
}

// ========== Original AI Service Functions ==========

// Define the tool (function) definition
const tools = {
    functionDeclarations: [
        {
            name: "create_product",
            description: "Create a new product. Requires Name, Price, Category, Stock, Brand, Description.",
            parameters: {
                type: "OBJECT",
                properties: {
                    name: { type: "STRING" },
                    price: { type: "NUMBER" },
                    category: { type: "STRING" },
                    stock: { type: "NUMBER" },
                    brand: { type: "STRING" },
                    description: { type: "STRING" }
                },
                required: ["name", "price", "category", "stock", "brand", "description"],
            },
        },
        // NEW: Update Product
        {
            name: "update_product",
            description: "Update an existing product. User must specify the product name to find it, and then the fields to change.",
            parameters: {
                type: "OBJECT",
                properties: {
                    searchName: { type: "STRING", description: "The name of the product to update" },
                    newPrice: { type: "NUMBER", description: "New price (optional)" },
                    newStock: { type: "NUMBER", description: "New stock quantity (optional)" },
                    newDescription: { type: "STRING", description: "New description (optional)" }
                },
                required: ["searchName"],
            },
        },
        // NEW: Delete Product
        {
            name: "delete_product",
            description: "Delete a product permanently from inventory.",
            parameters: {
                type: "OBJECT",
                properties: {
                    productName: { type: "STRING", description: "The name of the product to delete" }
                },
                required: ["productName"],
            },
        },
        // NEW: List Products
        {
            name: "list_products",
            description: "List products in the inventory. Can filter by category or show all.",
            parameters: {
                type: "OBJECT",
                properties: {
                    category: { type: "STRING", description: "Category to filter by (optional)" }
                },
            },
        },
        // Image Management
        {
            name: "add_product_images",
            description: "Prepare to add images to a product. User says something like 'add images to [product name]' or 'upload photos for [product]'. The user will then send images in following messages.",
            parameters: {
                type: "OBJECT",
                properties: {
                    productName: { type: "STRING", description: "The name of the product to add images to" }
                },
                required: ["productName"],
            },
        },
        {
            name: "delete_product_image",
            description: "Delete a specific image from a product by image number (1-5).",
            parameters: {
                type: "OBJECT",
                properties: {
                    productName: { type: "STRING", description: "The name of the product" },
                    imageNumber: { type: "NUMBER", description: "The image number to delete (1-5)" }
                },
                required: ["productName", "imageNumber"],
            },
        },
        {
            name: "delete_all_product_images",
            description: "Delete all images from a product.",
            parameters: {
                type: "OBJECT",
                properties: {
                    productName: { type: "STRING", description: "The name of the product to remove all images from" }
                },
                required: ["productName"],
            },
        },
        // Video Management
        {
            name: "add_product_video",
            description: "Prepare to add or replace video on a product. User says something like 'add video to [product]' or 'upload video for [product]'. The user will then send the video.",
            parameters: {
                type: "OBJECT",
                properties: {
                    productName: { type: "STRING", description: "The name of the product to add video to" }
                },
                required: ["productName"],
            },
        },
        {
            name: "delete_product_video",
            description: "Delete the video from a product.",
            parameters: {
                type: "OBJECT",
                properties: {
                    productName: { type: "STRING", description: "The name of the product to remove video from" }
                },
                required: ["productName"],
            },
        },
        {
            name: "view_product_media",
            description: "View/list images and video of a product to see what media is attached.",
            parameters: {
                type: "OBJECT",
                properties: {
                    productName: { type: "STRING", description: "The name of the product to view media for" }
                },
                required: ["productName"],
            },
        }
    ],
};

// Helper function for delay
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function processUserCommand(userText) {
    let retries = 0;
    const maxRetries = 3;
    
    while (true) {
        try {
            const model = genAI.getGenerativeModel({ 
                model: "gemini-2.5-flash",
                tools: [tools],
                systemInstruction: {
                    parts: [{ text: "You are an inventory assistant. You can Create, Update, Delete, and List products. For updates and deletes, ask for the product name if not provided. Be helpful and concise." }]
                }
            });

            const chat = model.startChat();
            const result = await chat.sendMessage(userText);
            const response = result.response;
            const functionCalls = response.functionCalls();

            if (functionCalls && functionCalls.length > 0) {
                const call = functionCalls[0];
                const args = call.args;

                // Map function names to Action Types
                if (call.name === "create_product") {
                    if(args.category) args.category = args.category.toLowerCase();
                    return { type: "ACTION", action: "CREATE_PRODUCT", data: args };
                }
                if (call.name === "update_product") {
                    return { type: "ACTION", action: "UPDATE_PRODUCT", data: args };
                }
                if (call.name === "delete_product") {
                    return { type: "ACTION", action: "DELETE_PRODUCT", data: args };
                }
                if (call.name === "list_products") {
                    return { type: "ACTION", action: "LIST_PRODUCTS", data: args };
                }
                
                // Image management
                if (call.name === "add_product_images") {
                    return { type: "ACTION", action: "ADD_PRODUCT_IMAGES", data: args };
                }
                if (call.name === "delete_product_image") {
                    return { type: "ACTION", action: "DELETE_PRODUCT_IMAGE", data: args };
                }
                if (call.name === "delete_all_product_images") {
                    return { type: "ACTION", action: "DELETE_ALL_PRODUCT_IMAGES", data: args };
                }
                
                // Video management
                if (call.name === "add_product_video") {
                    return { type: "ACTION", action: "ADD_PRODUCT_VIDEO", data: args };
                }
                if (call.name === "delete_product_video") {
                    return { type: "ACTION", action: "DELETE_PRODUCT_VIDEO", data: args };
                }
                if (call.name === "view_product_media") {
                    return { type: "ACTION", action: "VIEW_PRODUCT_MEDIA", data: args };
                }
            }

            return { type: "REPLY", text: response.text() };

        } catch (error) {
            console.error(`Gemini AI Error (Attempt ${retries + 1}):`, error.message);
            
            // Check for 503 Service Unavailable or Overloaded
            if (error.message.includes("503") || error.message.includes("overloaded")) {
                retries++;
                if (retries > maxRetries) {
                    return { type: "ERROR", text: "The AI model is currently overloaded. Please try again in a few moments." };
                }
                
                // Exponential backoff: 1s, 2s, 4s
                const waitTime = 1000 * Math.pow(2, retries - 1);
                await delay(waitTime);
                continue;
            }

            return { type: "ERROR", text: "System error." };
        }
    }
}

module.exports = { processUserCommand, analyzeProductForForm };