const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Define the tool (function) definition
const tools = {
    functionDeclarations: [
        {
            name: "create_product",
            description: "Create a new product. Only call this when you have ALL details. If details are missing, ask the user for them.",
            parameters: {
                type: "OBJECT",
                properties: {
                    name: { type: "STRING", description: "Product name" },
                    price: { type: "NUMBER", description: "Price" },
                    category: { type: "STRING", description: "Category (rackets, shoes, accessories)" },
                    stock: { type: "NUMBER", description: "Stock quantity" },
                    brand: { type: "STRING", description: "Brand name" },
                    description: { type: "STRING", description: "Product description" }
                },
                required: ["name", "price", "category", "stock", "brand", "description"],
            },
        }
    ],
};

async function processUserCommand(userText) {
    try {
        // Use gemini-1.5-flash as it supports system instructions and tools well
        const model = genAI.getGenerativeModel({ 
            model: "gemini-flash-latest",
            tools: [tools],
            systemInstruction: {
                parts: [{ text: "You are an inventory assistant. To add a product, you STRICTLY need: Name, Price, Category, Stock, Brand, and Description. If the user misses ANY of these, do NOT call the create_product function. Instead, ask for the missing information politely. Do NOT guess values." }]
            }
        });

        const chat = model.startChat();
        
        const result = await chat.sendMessage(userText);
        const response = result.response;
        
        const functionCalls = response.functionCalls();

        if (functionCalls && functionCalls.length > 0) {
            const call = functionCalls[0];
            if (call.name === "create_product") {
                const productData = call.args;
                if(productData.category) productData.category = productData.category.toLowerCase();

                return {
                    type: "ACTION",
                    action: "CREATE_PRODUCT",
                    data: productData
                };
            }
        }

        return {
            type: "REPLY",
            text: response.text()
        };

    } catch (error) {
        console.error("Gemini AI Error:", error);
        return { type: "ERROR", text: "I'm having trouble connecting to my brain right now." };
    }
}

module.exports = { processUserCommand };