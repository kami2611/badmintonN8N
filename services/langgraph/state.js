/**
 * LangGraph State Schema Definition
 * Defines the state structure for the conversation graph
 */

const { Annotation } = require("@langchain/langgraph");
const { BaseMessage } = require("@langchain/core/messages");

/**
 * State Annotation for the Seller Agent
 * This defines the schema for the graph state that persists across turns
 */
const SellerAgentState = Annotation.Root({
    // Conversation messages history
    messages: Annotation({
        reducer: (current, update) => [...current, ...update],
        default: () => [],
    }),
    
    // Partial product data being collected
    pendingProduct: Annotation({
        reducer: (current, update) => ({ ...current, ...update }),
        default: () => ({}),
    }),
    
    // Fields still needed for product creation
    missingFields: Annotation({
        reducer: (_, update) => update, // Replace entirely
        default: () => [],
    }),
    
    // Current conversation mode
    mode: Annotation({
        reducer: (_, update) => update,
        default: () => null, // null, 'creating_product', 'updating_product', 'adding_images'
    }),
    
    // The seller's ID (MongoDB ObjectId as string)
    sellerId: Annotation({
        reducer: (_, update) => update,
        default: () => null,
    }),
    
    // Phone number for identification
    phone: Annotation({
        reducer: (_, update) => update,
        default: () => null,
    }),
    
    // Final response to send back to user
    response: Annotation({
        reducer: (_, update) => update,
        default: () => null,
    }),
    
    // Action result from tool execution
    actionResult: Annotation({
        reducer: (_, update) => update,
        default: () => null,
    }),
    
    // Error state
    error: Annotation({
        reducer: (_, update) => update,
        default: () => null,
    }),
    
    // NEW: Current step in product creation conversation
    // 'idle' | 'awaiting_image' | 'analyzing_image' | 'asking_name' | 'asking_price' | 'asking_category' | 'confirming'
    conversationStep: Annotation({
        reducer: (_, update) => update,
        default: () => 'idle',
    }),
    
    // NEW: Image URL being processed in current workflow
    pendingProductImage: Annotation({
        reducer: (_, update) => update,
        default: () => null,
    }),
    
    // NEW: AI analysis results from image (extracted fields)
    // { category, brand, condition, suggestedName, confidence }
    productImageAnalysis: Annotation({
        reducer: (current, update) => ({ ...current, ...update }),
        default: () => ({}),
    }),
    
    // NEW: Timestamp of when current product creation started (for timeout)
    sessionStartTime: Annotation({
        reducer: (_, update) => update,
        default: () => null,
    }),
    
    // NEW: Active product ID when adding images/video to an existing product
    activeProductId: Annotation({
        reducer: (_, update) => update,
        default: () => null,
    }),
    
    // NEW: Current active task type
    // 'idle' | 'creating_product' | 'adding_images' | 'adding_video'
    activeTask: Annotation({
        reducer: (_, update) => update,
        default: () => 'idle',
    }),
    
    // NEW: Timestamp of last task interaction (for "recent" checks)
    lastTaskAt: Annotation({
        reducer: (_, update) => update,
        default: () => null,
    }),
    
    // NEW: Input type marker from route (helps agent distinguish context)
    // 'IMAGE_WITH_CAPTION' | 'IMAGE_ONLY' | 'TEXT_ONLY' | null
    inputType: Annotation({
        reducer: (_, update) => update,
        default: () => null,
    }),
});

// Required fields for product creation
const REQUIRED_FIELDS = ['name', 'category', 'price'];

// Valid category options
const CATEGORY_OPTIONS = ['rackets', 'shoes', 'accessories', 'apparel', 'bags', 'shuttles'];

/**
 * Check which required fields are missing
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
 * NEW: Get the next field to ask for during multi-turn collection
 */
function getNextMissingField(pendingProduct) {
    const missing = getMissingRequiredFields(pendingProduct);
    return missing.length > 0 ? missing[0] : null;
}

/**
 * Generate user-friendly prompt for a missing field
 */
function getFieldPrompt(field, category = null) {
    const prompts = {
        name: "📝 What's the *product name*? (e.g., 'Yonex Astrox 77')",
        category: "📦 What *category*?\n• rackets\n• shoes\n• accessories\n• apparel\n• bags\n• shuttles",
        price: "💰 What's the *price* in PKR?",
        description: "📄 Brief *description*? (or say 'skip')",
        brand: "🏷️ What *brand*? (or say 'skip')",
        stock: "📊 How many in *stock*? (default: 1)",
        condition: "✨ Is it *new* or *used*?"
    };
    
    return prompts[field] || `Please provide the ${field}:`;
}

/**
 * Format a summary of collected product data with image info
 */
function formatProductSummary(product, missing = [], imageUrl = null) {
    let summary = "📋 *Product Details So Far:*\n\n";
    
    if (imageUrl) {
        summary += `📸 Image: Attached\n`;
    }
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

// Helper to reset task state (for context switch)
function getResetTaskState() {
    return {
        activeProductId: null,
        activeTask: 'idle',
        pendingProduct: {},
        pendingProductImage: null,
        productImageAnalysis: {},
        conversationStep: 'idle',
        inputType: null,
    };
}

module.exports = {
    SellerAgentState,
    REQUIRED_FIELDS,
    CATEGORY_OPTIONS,
    getMissingRequiredFields,
    getNextMissingField,
    getFieldPrompt,
    formatProductSummary,
    getResetTaskState
};
