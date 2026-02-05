/**
 * LangGraph Seller Agent
 * Production-grade AI agent for WhatsApp inventory management
 * 
 * Architecture:
 * - StateGraph with MongoDB persistence
 * - Gemini 2.5 Flash model with structured tool calling
 * - Nodes: Agent (reasoning) → Tools (execution) → Response (formatting)
 */

const { StateGraph, END, START } = require("@langchain/langgraph");
const { ChatGoogleGenerativeAI } = require("@langchain/google-genai");
const { HumanMessage, AIMessage, ToolMessage, SystemMessage } = require("@langchain/core/messages");
const { ToolNode } = require("@langchain/langgraph/prebuilt");

const { 
    SellerAgentState, 
    REQUIRED_FIELDS, 
    CATEGORY_OPTIONS,
    getMissingRequiredFields,
    getNextMissingField,
    getFieldPrompt,
    formatProductSummary,
    getResetTaskState
} = require("./state");
const { createSellerTools } = require("./tools");
const { 
    initializeCheckpointerFromMongoose, 
    createThreadConfig,
    clearUserSession 
} = require("./checkpointer");

require('dotenv').config();

// ============ Constants ============

const CANCEL_WORDS = ['cancel', 'stop', 'abort', 'never mind', 'nevermind', 'forget it', 'quit', 'exit'];
const SKIP_WORDS = ['skip', 'pass', 'next', 'no', 'none', "don't have", 'dont have', 'na', 'n/a'];

// ============ Model Configuration ============

function createModel() {
    return new ChatGoogleGenerativeAI({
        model: "gemini-2.0-flash-lite-001",
        apiKey: process.env.GEMINI_API_KEY,
        temperature: 0.3,
        maxOutputTokens: 1024,
    });
}

// ============ System Prompt ============

function buildSystemPrompt(state) {
    let prompt = `You are an intelligent, conversational inventory assistant for a badminton equipment store on WhatsApp. You help sellers manage products through multi-turn conversations.

PRIMARY GOAL:
Help sellers quickly create products by collecting required fields across multiple messages.

CAPABILITIES:
- Create, Update, Delete, and List products
- Analyze product images to extract details
- Guide sellers through interactive product creation
- Manage product images and videos

⚠️ CRITICAL CONTEXT-SWITCH RULES (INPUT_TYPE):
1. If inputType is "IMAGE_WITH_CAPTION":
   - This is a NEW product creation request. The caption IS the product description.
   - DO NOT associate this image with any previous product or pending task.
   - IGNORE any activeProductId from previous context.
   - Extract product details from the caption and create a NEW product.

2. If inputType is "IMAGE_ONLY" (no caption):
   - Check if activeTask is "adding_images" and activeProductId exists.
   - If YES and lastTaskAt was recent (within 5 minutes): Add image to that product.
   - If NO or too old: Ask the user which product to add the image to.

3. When a new product description arrives (even without image):
   - Start FRESH product creation. Clear any previous pending product context.

REQUIRED FIELDS for product creation:
1. name (product name) - REQUIRED
2. category (rackets/shoes/accessories/apparel/bags/shuttles) - REQUIRED  
3. price (in PKR) - REQUIRED
Optional: brand, description, stock, condition, imageUrl

MULTI-TURN CONVERSATION RULES:
1. If user provides partial product info, ACKNOWLEDGE what you received and ASK for the next missing field
2. Use conversational language with appropriate emojis
3. Track context across multiple messages within same conversation
4. When in product creation mode:
   - Extract ALL data from user message
   - If fields are still missing, use get_field_prompt tool to generate next question
   - Confirm collected data before calling create_product
   - Support user providing one field per message

IMAGE ANALYSIS:
- If images are provided, analyze them using analyze_product_image tool
- Extract: product type, brand, condition, visible specs
- Use analysis to suggest product details to user
- Include image URL in final product creation

CONVERSATION FLOW for Product Creation:
1. User mentions product → Enter product creation mode
2. Extract all available data from message
3. If missing required fields:
   - Get next missing field using get_field_prompt
   - Send friendly prompt to user
   - Wait for response
4. Repeat step 3 until all required fields collected
5. Call create_product with ALL collected data
6. Confirm creation with summary

PRICE PARSING:
- "5k" or "5K" = 5000
- "25,000" = 25000
- "Rate 9999/=" = 9999

CATEGORY MAPPING:
- racket, bat, racquette → rackets
- shoe, footwear → shoes
- accessory, acc → accessories
- clothes, clothing, shirt → apparel
- bag → bags
- shuttle, shuttlecock, birdie → shuttles

RESPONSE TYPES:
- DIRECT_MESSAGE: Just respond conversationally
- COLLECT_FIELD: Ask for a specific missing field
- COLLECT_MORE_INFO: User is providing product info, extract and ask for next field
- CREATE_PRODUCT: All fields ready, create the product
- MULTIPLE_OPTIONS: Offer choices when ambiguous
`;

    // Add multi-turn context if user is in product creation
    if (state.conversationStep && state.conversationStep !== 'idle') {
        prompt += `
CURRENT CONVERSATION STATE:
- Step: ${state.conversationStep}
- Pending Product Data: ${JSON.stringify(state.pendingProduct || {})}
- Product Image: ${state.pendingProductImage ? 'Yes (analyzing...)' : 'No'}
- Session Duration: ${state.sessionStartTime ? Math.round((Date.now() - state.sessionStartTime) / 1000) + 's' : 'New'}

TASK: Continue from where we left off. Extract any new information from user message and either:
1. Ask for the next missing field (use get_field_prompt tool)
2. Create the product if all required fields are now available
`;
    }

    return prompt;
}

// ============ Graph Nodes ============

/**
 * Agent Node - The reasoning engine
 * Decides what action to take based on user input
 */
async function agentNode(state, config) {
    console.log('🤖 [Agent] Processing state:', {
        mode: state.mode,
        pendingProduct: state.pendingProduct,
        missingFields: state.missingFields,
        messageCount: state.messages.length
    });
    
    const model = createModel();
    const tools = createSellerTools(state.sellerId);
    const modelWithTools = model.bindTools(tools);
    
    // Build messages for the model
    const systemMessage = new SystemMessage(buildSystemPrompt(state));
    const messages = [systemMessage, ...state.messages];
    
    try {
        const response = await modelWithTools.invoke(messages);
        
        // Safely extract content string (may be string or array of objects)
        let contentPreview = '';
        if (typeof response.content === 'string') {
            contentPreview = response.content.substring(0, 100);
        } else if (Array.isArray(response.content)) {
            contentPreview = response.content[0]?.text?.substring(0, 100) || '[array content]';
        } else {
            contentPreview = '[complex content]';
        }
        
        console.log('🤖 [Agent] Response:', {
            hasToolCalls: response.tool_calls?.length > 0,
            toolCalls: response.tool_calls?.map(t => t.name),
            content: contentPreview
        });
        
        return {
            messages: [response],
            actionResult: null, // Reset for this turn
        };
        
    } catch (error) {
        console.error('❌ [Agent] Error:', error.message);
        return {
            error: error.message,
            response: "I'm having trouble processing your request. Please try again.",
        };
    }
}

/**
 * Tools Node - Executes tool calls
 * Uses LangGraph's built-in ToolNode
 */
function createToolsNode(sellerId) {
    const tools = createSellerTools(sellerId);
    return new ToolNode(tools);
}

/**
 * Response Formatter Node
 * Formats the final response for WhatsApp
 */
async function responseNode(state) {
    const messages = state.messages;
    const lastMessage = messages[messages.length - 1];
    
    // If there's a tool result, format it nicely
    if (lastMessage._getType() === 'tool') {
        try {
            const toolResult = JSON.parse(lastMessage.content);
            
            // Handle image analysis
            if (toolResult.action === 'IMAGE_ANALYZED') {
                const analysis = toolResult.analysis || {};
                const updateState = {
                    productImageAnalysis: analysis,
                    conversationStep: 'analyzing_image',
                };
                
                // Suggest next field to ask for
                const nextField = getNextMissingField(state.pendingProduct || {});
                if (nextField) {
                    const fieldPrompt = getFieldPrompt(nextField, analysis.productType);
                    updateState.response = `📸 *Image analyzed!*\n\nFound: ${analysis.visibleDetails || 'Product details'}\n\n${fieldPrompt}`;
                    updateState.conversationStep = 'asking_' + nextField;
                } else {
                    updateState.response = `✅ Image analyzed! Product details ready. Creating...`;
                }
                
                return updateState;
            }
            
            // Handle field prompt generation
            if (toolResult.action === 'FIELD_PROMPT_GENERATED') {
                return {
                    conversationStep: 'asking_' + toolResult.field,
                    response: toolResult.prompt,
                };
            }
            
            // Handle show help
            if (toolResult.action === 'SHOW_HELP') {
                return {
                    response: formatHelpMessage(),
                };
            }
            
            if (toolResult.action === 'SHOW_STATUS') {
                return {
                    response: formatStatusMessage(state),
                };
            }
            
            if (toolResult.action === 'AWAIT_IMAGES') {
                return {
                    conversationStep: 'adding_images',
                    activeTask: 'adding_images',
                    activeProductId: toolResult.productId || null,
                    lastTaskAt: Date.now(),
                    response: formatAwaitImagesMessage(toolResult),
                    actionResult: toolResult,
                };
            }
            
            if (toolResult.action === 'AWAIT_VIDEO') {
                return {
                    conversationStep: 'adding_video',
                    activeTask: 'adding_video',
                    activeProductId: toolResult.productId || null,
                    lastTaskAt: Date.now(),
                    response: formatAwaitVideoMessage(toolResult),
                    actionResult: toolResult,
                };
            }
            
            // Product created successfully - CLEAR all task state
            if (toolResult.success && toolResult.product) {
                return {
                    conversationStep: 'idle',
                    activeTask: 'idle',
                    activeProductId: null,
                    pendingProduct: {},
                    pendingProductImage: null,
                    productImageAnalysis: {},
                    inputType: null,
                    response: formatProductCreatedMessage(toolResult),
                };
            }
            
            // List products
            if (toolResult.success && toolResult.products) {
                return {
                    response: formatProductListMessage(toolResult),
                };
            }
            
            // Generic success message
            if (toolResult.success && toolResult.message) {
                return {
                    conversationStep: 'idle',
                    response: `✅ ${toolResult.message}`,
                };
            }
            
            // Error from tool
            if (!toolResult.success && toolResult.error) {
                return {
                    response: `❌ ${toolResult.error}`,
                };
            }
            
        } catch (e) {
            // Not JSON, use raw content
        }
    }
    
    // Use AI message content directly
    if (lastMessage._getType() === 'ai' && lastMessage.content) {
        return {
            response: lastMessage.content,
        };
    }
    
    return {
        response: state.response || "I'm here to help! Say 'help' to see what I can do.",
    };
}

/**
 * Validator Node - Validates state before proceeding
 * Checks for missing required fields in product creation
 */
async function validatorNode(state) {
    const messages = state.messages;
    const lastMessage = messages[messages.length - 1];
    
    // Check if this was a create_product call with missing fields
    if (lastMessage._getType() === 'tool') {
        try {
            const toolResult = JSON.parse(lastMessage.content);
            
            // If product was created but missing required fields detected
            if (toolResult.success === false && toolResult.missingFields) {
                return {
                    mode: 'creating_product',
                    pendingProduct: toolResult.partialData || state.pendingProduct,
                    missingFields: toolResult.missingFields,
                    response: `${formatProductSummary(toolResult.partialData, toolResult.missingFields)}\n\n${getFieldPrompt(toolResult.missingFields[0])}`,
                };
            }
        } catch (e) {
            // Not JSON, continue
        }
    }
    
    return {};
}

// ============ Message Formatting Helpers ============

function formatHelpMessage() {
    return `🏸 *Badminton Store Manager - Help*

Here's what I can do for you:

*📦 Product Management:*
• "Add a Yonex Astrox 99 racket for 25000" - Create product
• "Create new product" - Start guided creation
• "List my products" - View inventory
• "Show rackets" - List by category
• "Update price of [product] to 20000"
• "Delete [product name]"

*📸 Images & Video:*
• "Add images to [product]" - Then send photos
• "Delete image 1 from [product]"
• "Add video to [product]"
• "View media of [product]"

*🎯 Smart Features:*
• Natural language - Just describe what you want
• "Cancel" - Abort current operation
• "Status" - See pending operations

*📁 Categories:*
rackets, shoes, bags, apparel, shuttles, accessories

Just type naturally - I'll understand! 🤖`;
}

function formatStatusMessage(state) {
    let msg = `📊 *Current Status*\n\n`;
    
    if (state.mode === 'creating_product') {
        msg += `🔄 You're creating a product:\n\n`;
        msg += formatProductSummary(state.pendingProduct, state.missingFields);
        msg += `\n\nSay "cancel" to abort, or provide the missing info.`;
    } else if (state.mode === 'adding_images') {
        msg += `📸 Waiting for images...\n\nSend photos or say "done" to finish.`;
    } else if (state.mode === 'adding_video') {
        msg += `🎬 Waiting for video...\n\nSend a video or say "cancel".`;
    } else {
        msg += `✅ No pending operations.\n\nReady for your next command! Say "help" for options.`;
    }
    
    return msg;
}

function formatAwaitImagesMessage(result) {
    return `📸 Ready to receive images for *${result.productName}*!

Current images: ${result.currentImages}/5
You can add up to ${result.remainingSlots} more.

*Constraints:*
• Max 2MB per image
• JPG, PNG, WebP

Send me the image(s) now! (This expires in 5 minutes)`;
}

function formatAwaitVideoMessage(result) {
    let msg = `🎬 Ready to receive video for *${result.productName}*!\n\n`;
    
    if (result.hasExistingVideo) {
        msg += "⚠️ This product already has a video. Sending a new one will replace it.\n\n";
    }
    
    msg += `*Constraints:*
• Max 20 seconds
• MP4, MOV, WebM

Send me the video now! (This expires in 5 minutes)`;
    
    return msg;
}

function formatProductCreatedMessage(result) {
    const p = result.product;
    return `✅ *Product Created Successfully!*

📦 *${p.name}*

• Category: ${p.category}
• Price: PKR ${p.price}
• Stock: ${p.stock}
${p.brand ? `• Brand: ${p.brand}\n` : ''}• Condition: ${p.condition}

📸 To add images, say: "Add images to ${p.name}"`;
}

function formatProductListMessage(result) {
    if (result.count === 0) {
        let msg = result.category !== 'all' 
            ? `No products found in the "${result.category}" category.`
            : "Your inventory is empty.";
        msg += "\n\nTo add a product, say something like:\n• \"Add Yonex Astrox 99 racket for 28000\"";
        return msg;
    }
    
    let msg = result.category !== 'all'
        ? `📋 *${result.category.charAt(0).toUpperCase() + result.category.slice(1)} Inventory:*\n\n`
        : "📋 *Your Inventory:*\n\n";
    
    result.products.forEach((p, i) => {
        const stockEmoji = p.stock > 5 ? '🟢' : p.stock > 0 ? '🟡' : '🔴';
        msg += `${i + 1}. *${p.name}*\n`;
        msg += `   💰 PKR ${p.price} ${stockEmoji} ${p.stock} in stock\n\n`;
    });
    
    if (result.count >= 15) {
        msg += `_(Showing first 15 products)_`;
    }
    
    return msg;
}

// ============ Routing Logic ============

/**
 * Determine next node after agent
 */
function shouldContinue(state) {
    const messages = state.messages;
    const lastMessage = messages[messages.length - 1];
    
    // If there are tool calls, go to tools node
    if (lastMessage._getType() === 'ai' && lastMessage.tool_calls?.length > 0) {
        return "tools";
    }
    
    // Otherwise, go to response formatting
    return "response";
}

/**
 * After tools, always go to response
 */
function afterTools(state) {
    return "response";
}

// ============ Graph Builder ============

/**
 * Build the agent graph for a specific seller
 * @param {string} sellerId - The seller's MongoDB ObjectId
 * @returns {CompiledGraph} Compiled graph ready for execution
 */
async function buildAgentGraph(sellerId) {
    // Create the tools node with seller-specific tools
    const toolsNode = createToolsNode(sellerId);
    
    // Build the graph
    const workflow = new StateGraph(SellerAgentState)
        .addNode("agent", agentNode)
        .addNode("tools", toolsNode)
        .addNode("format_response", responseNode)
        .addEdge(START, "agent")
        .addConditionalEdges("agent", shouldContinue, {
            tools: "tools",
            response: "format_response",
        })
        .addEdge("tools", "format_response")
        .addEdge("format_response", END);
    
    // Get checkpointer for persistence
    const checkpointer = await initializeCheckpointerFromMongoose();
    
    // Compile with checkpointer
    const app = workflow.compile({
        checkpointer: checkpointer,
    });
    
    return app;
}

// ============ Main Entry Point ============

// Cache compiled graphs per seller
const graphCache = new Map();

/**
 * Process a user message through the agent
 * Main entry point for WhatsApp integration
 * 
 * @param {string} phone - User's phone number (used as thread_id)
 * @param {string} text - User's message text
 * @param {string} sellerId - The seller's MongoDB ObjectId
 * @returns {Promise<{response: string, actionResult?: object}>}
 */
async function processUserMessage(phone, text, sellerId) {
    console.log('\n========== LANGGRAPH AGENT ==========');
    console.log('📱 Phone:', phone);
    console.log('💬 Text:', text);
    console.log('🏪 Seller:', sellerId);
    
    try {
        // Check for cancel command
        if (CANCEL_WORDS.some(word => text.toLowerCase().includes(word))) {
            await clearUserSession(phone);
            return {
                response: "✅ Operation cancelled. How can I help you?",
            };
        }
        
        // Get or create compiled graph for this seller
        let graph = graphCache.get(sellerId);
        if (!graph) {
            graph = await buildAgentGraph(sellerId);
            graphCache.set(sellerId, graph);
        }
        
        // Create thread config using phone number
        const threadConfig = createThreadConfig(phone);
        
        // Create the input state
        const input = {
            messages: [new HumanMessage(text)],
            phone: phone,
            sellerId: sellerId,
        };
        
        // Run the graph
        const result = await graph.invoke(input, threadConfig);
        
        console.log('✅ [LangGraph] Result:', {
            response: result.response?.substring(0, 100),
            mode: result.mode,
            hasActionResult: !!result.actionResult,
        });
        
        return {
            response: result.response || "I'm here to help! Say 'help' to see what I can do.",
            actionResult: result.actionResult,
            mode: result.mode,
        };
        
    } catch (error) {
        console.error('❌ [LangGraph] Error:', error);
        
        return {
            response: "Sorry, I encountered an error. Please try again or say 'help' for options.",
            error: error.message,
        };
    }
}

/**
 * Get current state for a user (for debugging/status)
 */
async function getUserState(phone, sellerId) {
    try {
        let graph = graphCache.get(sellerId);
        if (!graph) {
            graph = await buildAgentGraph(sellerId);
            graphCache.set(sellerId, graph);
        }
        
        const threadConfig = createThreadConfig(phone);
        const state = await graph.getState(threadConfig);
        
        return state?.values || null;
        
    } catch (error) {
        console.error('❌ [LangGraph] Error getting state:', error);
        return null;
    }
}

/**
 * Reset a user's conversation state
 */
async function resetUserState(phone) {
    await clearUserSession(phone);
}

module.exports = {
    processUserMessage,
    getUserState,
    resetUserState,
    buildAgentGraph,
};
