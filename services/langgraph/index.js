/**
 * LangGraph Services Index
 * Export all LangGraph-related functionality
 */

const { processUserMessage, getUserState, resetUserState } = require('./agent');
const { createSellerTools } = require('./tools');
const { 
    initializeCheckpointer, 
    initializeCheckpointerFromMongoose,
    createThreadConfig,
    clearUserSession 
} = require('./checkpointer');
const { 
    SellerAgentState,
    REQUIRED_FIELDS,
    CATEGORY_OPTIONS,
    getMissingRequiredFields,
    getFieldPrompt,
    formatProductSummary
} = require('./state');

module.exports = {
    // Main agent entry point
    processUserMessage,
    getUserState,
    resetUserState,
    
    // Tools
    createSellerTools,
    
    // Checkpointer
    initializeCheckpointer,
    initializeCheckpointerFromMongoose,
    createThreadConfig,
    clearUserSession,
    
    // State utilities
    SellerAgentState,
    REQUIRED_FIELDS,
    CATEGORY_OPTIONS,
    getMissingRequiredFields,
    getFieldPrompt,
    formatProductSummary,
};
