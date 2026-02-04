/**
 * MongoDB Checkpointer Setup for LangGraph
 * Provides persistent conversation state across sessions using MongoDB
 */

const { MongoDBSaver } = require("@langchain/langgraph-checkpoint-mongodb");
const { MongoClient } = require("mongodb");
require('dotenv').config();

// Singleton MongoDB client and checkpointer
let mongoClient = null;
let checkpointer = null;
let dbInstance = null;

/**
 * Initialize MongoDB connection and checkpointer
 * @returns {Promise<MongoDBSaver>} The initialized checkpointer
 */
async function initializeCheckpointer() {
    if (checkpointer) {
        return checkpointer;
    }
    
    try {
        // Use the same MongoDB URI from your existing app
        const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/badminton-store';
        
        // Create MongoDB client
        mongoClient = new MongoClient(mongoUri);
        await mongoClient.connect();
        
        console.log('✅ [LangGraph] MongoDB connected for checkpointing');
        
        // Get the database instance
        dbInstance = mongoClient.db();
        
        // Initialize the checkpointer with constructor (not fromConnInfo)
        // MongoDBSaver API: new MongoDBSaver({ client, dbName, checkpointCollectionName, checkpointWritesCollectionName })
        checkpointer = new MongoDBSaver({
            client: mongoClient,
            dbName: dbInstance.databaseName,
            checkpointCollectionName: "langgraph_checkpoints",
            checkpointWritesCollectionName: "langgraph_writes",
        });
        
        // Ensure indexes for performance
        await ensureIndexes(dbInstance);
        
        console.log('✅ [LangGraph] Checkpointer initialized');
        
        return checkpointer;
        
    } catch (error) {
        console.error('❌ [LangGraph] Failed to initialize checkpointer:', error);
        throw error;
    }
}

/**
 * Alternative initialization using existing Mongoose connection
 * Call this if you want to reuse Mongoose's MongoDB connection
 */
async function initializeCheckpointerFromMongoose() {
    if (checkpointer) {
        return checkpointer;
    }
    
    try {
        const mongoose = require('mongoose');
        
        // Wait for mongoose to be connected
        if (mongoose.connection.readyState !== 1) {
            console.log('⏳ [LangGraph] Waiting for Mongoose connection...');
            await new Promise((resolve, reject) => {
                mongoose.connection.once('connected', resolve);
                mongoose.connection.once('error', reject);
                setTimeout(() => reject(new Error('Mongoose connection timeout')), 10000);
            });
        }
        
        // Get the underlying MongoDB client from Mongoose
        mongoClient = mongoose.connection.getClient();
        dbInstance = mongoose.connection.db;
        
        // Initialize the checkpointer with constructor (not fromConnInfo)
        // MongoDBSaver API: new MongoDBSaver({ client, dbName, checkpointCollectionName, checkpointWritesCollectionName })
        checkpointer = new MongoDBSaver({
            client: mongoClient,
            dbName: dbInstance.databaseName,
            checkpointCollectionName: "langgraph_checkpoints",
            checkpointWritesCollectionName: "langgraph_writes",
        });
        
        await ensureIndexes(dbInstance);
        
        console.log('✅ [LangGraph] Checkpointer initialized from Mongoose connection');
        
        return checkpointer;
        
    } catch (error) {
        console.error('❌ [LangGraph] Failed to initialize checkpointer from Mongoose:', error);
        throw error;
    }
}

/**
 * Ensure MongoDB indexes for checkpoint queries
 */
async function ensureIndexes(db) {
    try {
        const checkpointsCollection = db.collection('langgraph_checkpoints');
        const writesCollection = db.collection('langgraph_writes');
        
        // Index for fast lookup by thread_id (phone number)
        await checkpointsCollection.createIndex(
            { thread_id: 1, checkpoint_id: -1 },
            { name: 'idx_thread_checkpoint' }
        );
        
        // Index for writes
        await writesCollection.createIndex(
            { thread_id: 1, checkpoint_id: 1 },
            { name: 'idx_writes_thread_checkpoint' }
        );
        
        // TTL index to auto-expire old sessions (optional - 7 days)
        await checkpointsCollection.createIndex(
            { "metadata.created_at": 1 },
            { 
                name: 'idx_ttl_cleanup',
                expireAfterSeconds: 7 * 24 * 60 * 60 // 7 days
            }
        ).catch(() => {}); // Ignore if already exists with different options
        
    } catch (error) {
        console.warn('⚠️ [LangGraph] Could not create indexes:', error.message);
    }
}

/**
 * Get the checkpointer instance
 * @returns {MongoDBSaver|null}
 */
function getCheckpointer() {
    return checkpointer;
}

/**
 * Create a thread config for a user based on phone number
 * @param {string} phone - User's phone number
 * @returns {Object} Thread configuration
 */
function createThreadConfig(phone) {
    return {
        configurable: {
            thread_id: `whatsapp_${phone}`, // Unique per user
        },
    };
}

/**
 * Clean up resources
 */
async function closeCheckpointer() {
    if (mongoClient) {
        await mongoClient.close();
        mongoClient = null;
        checkpointer = null;
        console.log('✅ [LangGraph] Checkpointer connection closed');
    }
}

/**
 * Delete a user's conversation history
 * Useful for "reset" or "start over" commands
 * @param {string} phone - User's phone number
 */
async function clearUserSession(phone) {
    if (!dbInstance) {
        console.warn('⚠️ [LangGraph] No database instance for clearing session');
        return;
    }
    
    try {
        const threadId = `whatsapp_${phone}`;
        
        await dbInstance.collection('langgraph_checkpoints').deleteMany({ thread_id: threadId });
        await dbInstance.collection('langgraph_writes').deleteMany({ thread_id: threadId });
        
        console.log(`✅ [LangGraph] Cleared session for ${phone}`);
    } catch (error) {
        console.error('❌ [LangGraph] Failed to clear session:', error);
    }
}

module.exports = {
    initializeCheckpointer,
    initializeCheckpointerFromMongoose,
    getCheckpointer,
    createThreadConfig,
    closeCheckpointer,
    clearUserSession,
};
