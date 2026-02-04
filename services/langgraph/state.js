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
 * Generate user-friendly prompt for a missing field
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

module.exports = {
    SellerAgentState,
    REQUIRED_FIELDS,
    CATEGORY_OPTIONS,
    getMissingRequiredFields,
    getFieldPrompt,
    formatProductSummary
};
