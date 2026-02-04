const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ========== Conversation Context Manager ==========

// In-memory conversation store (per phone number)
const conversationContexts = new Map();

// Conversation context structure
const createEmptyContext = () => ({
    mode: null,                    // 'creating_product', 'updating_product', null
    pendingProduct: {},            // Partial product data being built
    missingFields: [],             // Fields still needed
    lastAction: null,              // Last action type for context
    conversationHistory: [],       // Last few messages for context
    productNameForMedia: null,     // Product name when adding images
    expiresAt: Date.now() + 30 * 60 * 1000  // 30 minute timeout
});

// Required fields for product creation
const REQUIRED_FIELDS = ['name', 'category', 'price'];
const CATEGORY_OPTIONS = ['rackets', 'shoes', 'accessories', 'apparel', 'bags', 'shuttles'];

/**
 * Get or create conversation context for a user
 */
function getConversationContext(phone) {
    let context = conversationContexts.get(phone);
    
    // Check if context exists and is not expired
    if (!context || Date.now() > context.expiresAt) {
        context = createEmptyContext();
        conversationContexts.set(phone, context);
    }
    
    return context;
}

/**
 * Update conversation context
 */
function updateConversationContext(phone, updates) {
    const context = getConversationContext(phone);
    Object.assign(context, updates);
    context.expiresAt = Date.now() + 30 * 60 * 1000; // Reset expiry
    conversationContexts.set(phone, context);
    return context;
}

/**
 * Clear conversation context
 */
function clearConversationContext(phone) {
    conversationContexts.delete(phone);
}

/**
 * Add message to conversation history (keep last 10)
 */
function addToHistory(phone, role, message) {
    const context = getConversationContext(phone);
    context.conversationHistory.push({ role, message, timestamp: Date.now() });
    if (context.conversationHistory.length > 10) {
        context.conversationHistory.shift();
    }
    conversationContexts.set(phone, context);
}

/**
 * Check which required fields are missing from pending product
 */
function getMissingRequiredFields(pendingProduct) {
    const missing = [];
    
    if (!pendingProduct.name || pendingProduct.name.trim() === '') {
        missing.push('name');
    }
    if (!pendingProduct.category || !CATEGORY_OPTIONS.includes(pendingProduct.category.toLowerCase())) {
        missing.push('category');
    }
    if (!pendingProduct.price || pendingProduct.price <= 0) {
        missing.push('price');
    }
    
    return missing;
}

/**
 * Generate a helpful prompt for missing field
 */
function getFieldPrompt(field, category = null) {
    const prompts = {
        name: "📝 What would you like to *name* this product?",
        category: `📦 What *category* does this product belong to?\n\nOptions:\n• rackets\n• shoes\n• accessories\n• apparel\n• bags\n• shuttles`,
        price: "💰 What *price* (in PKR) would you like to set?",
        description: "📄 Add a brief *description* for this product (or say 'skip'):",
        brand: "🏷️ What *brand* is this product? (or say 'skip'):",
        stock: "📊 How many units in *stock*? (default: 1)",
        condition: "✨ Is this product *new* or *used*?"
    };
    
    return prompts[field] || `Please provide the ${field}:`;
}

/**
 * Format a summary of collected product data
 */
function formatProductSummary(product, missing = []) {
    let summary = "📋 *Product Details So Far:*\n\n";
    
    if (product.name) summary += `• Name: ${product.name}\n`;
    if (product.category) summary += `• Category: ${product.category}\n`;
    if (product.price) summary += `• Price: PKR ${product.price}\n`;
    if (product.brand) summary += `• Brand: ${product.brand}\n`;
    if (product.description) summary += `• Description: ${product.description}\n`;
    if (product.stock) summary += `• Stock: ${product.stock}\n`;
    if (product.condition) summary += `• Condition: ${product.condition}\n`;
    
    if (missing.length > 0) {
        summary += `\n⚠️ *Still needed:* ${missing.join(', ')}`;
    }
    
    return summary;
}

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
                required: [],  // We'll handle missing fields ourselves
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
        // Show Help
        {
            name: "show_help",
            description: "Show help and available commands when user asks for help, guidance, what can you do, how to use, commands, etc.",
            parameters: {
                type: "OBJECT",
                properties: {},
            },
        },
        // Show Current Status
        {
            name: "show_status",
            description: "Show current status of pending operations when user asks what's happening, status, where was I, etc.",
            parameters: {
                type: "OBJECT",
                properties: {},
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

/**
 * Process user command with conversation context support
 * @param {string} userText - User's message
 * @param {string} phone - User's phone number for context
 * @param {Object} existingContext - Optional existing context
 * @returns {Object} AI result with action/reply and context updates
 */
async function processUserCommand(userText, phone = null, existingContext = null) {
    let retries = 0;
    const maxRetries = 3;
    
    // Get conversation context if phone provided
    const context = phone ? getConversationContext(phone) : (existingContext || createEmptyContext());
    
    // Add user message to history
    if (phone) {
        addToHistory(phone, 'user', userText);
    }
    
    while (true) {
        try {
            // Build context-aware system instruction
            const systemPrompt = buildSystemPrompt(context);
            
            const model = genAI.getGenerativeModel({ 
                model: "gemini-2.5-flash",
                tools: [tools],
                systemInstruction: {
                    parts: [{ text: systemPrompt }]
                }
            });

            // Include conversation history in the prompt if in a multi-turn flow
            let promptText = userText;
            if (context.mode === 'creating_product' && context.missingFields.length > 0) {
                const currentField = context.missingFields[0];
                promptText = `[CONTEXT: User is providing "${currentField}" for product creation. Current pending data: ${JSON.stringify(context.pendingProduct)}]\n\nUser says: "${userText}"`;
            }

            const chat = model.startChat();
            const result = await chat.sendMessage(promptText);
            const response = result.response;
            const functionCalls = response.functionCalls();

            if (functionCalls && functionCalls.length > 0) {
                const call = functionCalls[0];
                const args = call.args;

                // Map function names to Action Types
                if (call.name === "create_product") {
                    if(args.category) args.category = args.category.toLowerCase();
                    
                    // Merge with any existing pending data
                    const mergedData = { ...context.pendingProduct, ...args };
                    const missing = getMissingRequiredFields(mergedData);
                    
                    if (missing.length > 0) {
                        // Update context with partial data
                        if (phone) {
                            updateConversationContext(phone, {
                                mode: 'creating_product',
                                pendingProduct: mergedData,
                                missingFields: missing,
                                lastAction: 'CREATE_PRODUCT_PARTIAL'
                            });
                        }
                        
                        return { 
                            type: "NEED_MORE_INFO", 
                            action: "CREATE_PRODUCT_PARTIAL",
                            data: mergedData,
                            missingFields: missing,
                            prompt: getFieldPrompt(missing[0], mergedData.category),
                            summary: formatProductSummary(mergedData, missing)
                        };
                    }
                    
                    // All required fields present - clear context and create
                    if (phone) {
                        clearConversationContext(phone);
                    }
                    
                    return { type: "ACTION", action: "CREATE_PRODUCT", data: mergedData };
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
                
                // Help and Status
                if (call.name === "show_help") {
                    return { type: "ACTION", action: "SHOW_HELP", data: {} };
                }
                if (call.name === "show_status") {
                    return { type: "ACTION", action: "SHOW_STATUS", data: { context } };
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

/**
 * Build context-aware system prompt
 */
function buildSystemPrompt(context) {
    let basePrompt = `You are an intelligent inventory assistant for a badminton equipment store on WhatsApp. You help sellers manage their products.

CAPABILITIES:
- Create, Update, Delete, and List products
- Manage product images and videos
- Extract product details from natural language descriptions

REQUIRED FIELDS for product creation:
1. name (product name) - REQUIRED
2. category (rackets/shoes/accessories/apparel/bags/shuttles) - REQUIRED  
3. price (in PKR) - REQUIRED
4. Other fields (brand, description, stock, condition) are optional

IMPORTANT RULES:
1. Extract as much information as possible from what the user says
2. If creating a product, identify name, category, and price from the message
3. For prices: "5000", "5k", "5000 rupees", "PKR 5000" all mean 5000
4. For categories: "racket", "bat" → rackets; "shoe", "footwear" → shoes; etc.
5. Be conversational and helpful
6. If user gives partial info, still call create_product with what you have

`;

    // Add context-specific instructions
    if (context.mode === 'creating_product') {
        basePrompt += `
CURRENT CONTEXT: User is in the middle of creating a product.
Pending product data: ${JSON.stringify(context.pendingProduct)}
Missing required fields: ${context.missingFields.join(', ')}

The user's next message is likely providing one of the missing fields. Extract the value and call create_product with all the data combined.
`;
    }

    if (context.conversationHistory.length > 0) {
        basePrompt += `
RECENT CONVERSATION:
${context.conversationHistory.slice(-5).map(h => `${h.role}: ${h.message}`).join('\n')}
`;
    }

    return basePrompt;
}

/**
 * Process a field value when user is providing missing info
 * @param {string} phone - User's phone number
 * @param {string} userText - User's message
 * @returns {Object} Updated context and next action
 */
async function processFieldInput(phone, userText) {
    const context = getConversationContext(phone);
    
    if (context.mode !== 'creating_product' || context.missingFields.length === 0) {
        return null; // Not in field-input mode
    }
    
    const currentField = context.missingFields[0];
    let value = userText.trim();
    let isValid = true;
    let errorMessage = null;
    
    // Validate and parse based on field type
    switch (currentField) {
        case 'category':
            value = value.toLowerCase();
            // Handle common variations
            const categoryMap = {
                'racket': 'rackets', 'bat': 'rackets', 'racquette': 'rackets',
                'shoe': 'shoes', 'footwear': 'shoes',
                'accessory': 'accessories', 'acc': 'accessories',
                'clothes': 'apparel', 'clothing': 'apparel', 'shirt': 'apparel', 'shorts': 'apparel',
                'bag': 'bags',
                'shuttle': 'shuttles', 'shuttlecock': 'shuttles', 'cock': 'shuttles', 'birdie': 'shuttles'
            };
            value = categoryMap[value] || value;
            
            if (!CATEGORY_OPTIONS.includes(value)) {
                isValid = false;
                errorMessage = `❌ Invalid category. Please choose from:\n• rackets\n• shoes\n• accessories\n• apparel\n• bags\n• shuttles`;
            }
            break;
            
        case 'price':
            // Parse price from various formats
            value = value.replace(/[^\d.]/g, ''); // Remove non-numeric except decimal
            value = parseFloat(value);
            
            // Handle "5k" = 5000
            if (userText.toLowerCase().includes('k')) {
                const numMatch = userText.match(/(\d+\.?\d*)\s*k/i);
                if (numMatch) {
                    value = parseFloat(numMatch[1]) * 1000;
                }
            }
            
            if (isNaN(value) || value <= 0) {
                isValid = false;
                errorMessage = "❌ Please provide a valid price (number greater than 0).";
            }
            break;
            
        case 'name':
            if (value.length < 2) {
                isValid = false;
                errorMessage = "❌ Product name is too short. Please provide a proper name.";
            }
            break;
            
        case 'stock':
            value = parseInt(value) || 1;
            break;
            
        case 'condition':
            value = value.toLowerCase();
            if (value !== 'new' && value !== 'used') {
                // Try to interpret
                if (value.includes('new') || value.includes('fresh') || value.includes('sealed')) {
                    value = 'new';
                } else if (value.includes('used') || value.includes('second') || value.includes('old')) {
                    value = 'used';
                } else {
                    value = 'new'; // Default
                }
            }
            break;
    }
    
    if (!isValid) {
        return { 
            type: "VALIDATION_ERROR", 
            field: currentField,
            error: errorMessage,
            context: context
        };
    }
    
    // Update pending product with validated value
    context.pendingProduct[currentField] = value;
    context.missingFields.shift(); // Remove the field we just got
    
    // Check if there are more missing fields
    if (context.missingFields.length > 0) {
        updateConversationContext(phone, context);
        
        const nextField = context.missingFields[0];
        return {
            type: "NEED_MORE_INFO",
            action: "CREATE_PRODUCT_PARTIAL",
            data: context.pendingProduct,
            missingFields: context.missingFields,
            prompt: getFieldPrompt(nextField, context.pendingProduct.category),
            summary: formatProductSummary(context.pendingProduct, context.missingFields)
        };
    }
    
    // All fields collected - ready to create
    const finalData = { ...context.pendingProduct };
    clearConversationContext(phone);
    
    return {
        type: "ACTION",
        action: "CREATE_PRODUCT",
        data: finalData
    };
}

/**
 * Analyze image and extract product information
 * @param {Buffer} imageBuffer - Image data
 * @param {Object} pendingProduct - Existing product data to enhance
 * @returns {Object} Enhanced product data
 */
async function analyzeProductImage(imageBuffer, pendingProduct = {}) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        
        // Convert buffer to base64
        const base64Image = imageBuffer.toString('base64');
        
        const prompt = `You are a badminton equipment expert. Analyze this product image and extract information.

Current known data: ${JSON.stringify(pendingProduct)}

Based on the image, provide a JSON response with any information you can determine:
{
    "category": "rackets/shoes/accessories/apparel/bags/shuttles or empty if unclear",
    "brand": "brand name if visible or identifiable",
    "condition": "new or used based on appearance",
    "color": "main colors",
    "description": "brief 2-3 sentence product description",
    "suggestedName": "suggested product name if not already provided",
    "confidence": "high/medium/low - how confident are you in these details",
    "additionalSpecs": {
        // Any category-specific details you can see
    }
}

RULES:
1. Return ONLY valid JSON
2. Use empty string "" for fields you cannot determine
3. Be accurate - don't guess if unsure
4. For condition: look for signs of wear, packaging, etc.`;

        const result = await model.generateContent([
            prompt,
            {
                inlineData: {
                    mimeType: 'image/jpeg',
                    data: base64Image
                }
            }
        ]);

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
        console.error('AI Image Analysis Error:', error.message);
        return { success: false, error: error.message };
    }
}

/**
 * Check if user wants to cancel current operation
 */
function isCancel(text) {
    const cancelWords = ['cancel', 'stop', 'abort', 'never mind', 'nevermind', 'forget it', 'quit', 'exit'];
    const lowerText = text.toLowerCase();
    return cancelWords.some(word => lowerText.includes(word));
}

/**
 * Check if user wants to skip optional field
 */
function isSkip(text) {
    const skipWords = ['skip', 'pass', 'next', 'no', 'none', "don't have", 'dont have', 'na', 'n/a'];
    const lowerText = text.toLowerCase();
    return skipWords.some(word => lowerText.includes(word));
}

module.exports = { 
    processUserCommand, 
    analyzeProductForForm,
    analyzeProductImage,
    processFieldInput,
    getConversationContext,
    updateConversationContext,
    clearConversationContext,
    getMissingRequiredFields,
    getFieldPrompt,
    formatProductSummary,
    isCancel,
    isSkip,
    REQUIRED_FIELDS,
    CATEGORY_OPTIONS
};