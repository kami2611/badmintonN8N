# LangGraph Integration for WhatsApp Bot

## Overview

This directory contains a production-grade LangGraph.js implementation that replaces the manual AI agent for the WhatsApp bot. It provides:

- **Persistent Conversations**: MongoDB-backed checkpoints that survive server restarts
- **Structured Tool Calling**: Zod schemas for type-safe tool definitions
- **State Graph**: Visual, maintainable conversation flow
- **No Regex Parsing**: Uses LangChain's structured output

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        WhatsApp Webhook                          │
│                              │                                    │
│                              ▼                                    │
│    ┌─────────────────────────────────────────────────────────┐   │
│    │               processUserMessage(phone, text)            │   │
│    │                         │                                │   │
│    │          ┌──────────────┴──────────────┐                │   │
│    │          ▼                             ▼                │   │
│    │   ┌──────────┐                  ┌──────────┐           │   │
│    │   │  START   │                  │ MongoDB  │           │   │
│    │   └────┬─────┘                  │Checkpoint│           │   │
│    │        │                        └──────────┘           │   │
│    │        ▼                                               │   │
│    │   ┌──────────┐    tool_calls    ┌──────────┐          │   │
│    │   │  Agent   │ ───────────────▶ │  Tools   │          │   │
│    │   │  (LLM)   │                  │  (Zod)   │          │   │
│    │   └────┬─────┘                  └────┬─────┘          │   │
│    │        │                             │                 │   │
│    │        │     no tool_calls           │                 │   │
│    │        │                             │                 │   │
│    │        ▼                             │                 │   │
│    │   ┌──────────┐◀──────────────────────┘                │   │
│    │   │ Response │                                        │   │
│    │   │ Formatter│                                        │   │
│    │   └────┬─────┘                                        │   │
│    │        │                                              │   │
│    │        ▼                                              │   │
│    │   ┌──────────┐                                        │   │
│    │   │   END    │ ──────▶ Return response to WhatsApp    │   │
│    │   └──────────┘                                        │   │
│    └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## Files

| File | Description |
|------|-------------|
| `state.js` | State schema using LangGraph Annotations |
| `tools.js` | Zod-validated tool definitions |
| `checkpointer.js` | MongoDB persistence setup |
| `agent.js` | Main StateGraph and entry point |
| `index.js` | Exports all modules |

## Installation

Add these dependencies to your `package.json`:

```bash
npm install @langchain/langgraph @langchain/google-genai @langchain/core @langchain/langgraph-checkpoint-mongodb zod
```

## Usage

### Switch to LangGraph Route

In your `App.js`, replace:

```javascript
// OLD
const whatsappRouter = require('./routes/whatsapp');
app.use('/whatsapp', whatsappRouter);

// NEW
const whatsappRouter = require('./routes/whatsapp-langgraph');
app.use('/whatsapp', whatsappRouter);
```

### Direct Usage

```javascript
const { processUserMessage } = require('./services/langgraph');

// Process a message
const result = await processUserMessage(
    '923001234567',           // phone number (used as thread_id)
    'Add a Yonex racket',     // user message
    '64abc123def456...'       // seller MongoDB ObjectId
);

console.log(result.response); // Message to send back
```

## State Schema

```javascript
{
    messages: BaseMessage[],      // Conversation history
    pendingProduct: {},           // Partial product being created
    missingFields: [],            // Fields still needed
    mode: null | 'creating_product' | 'adding_images',
    sellerId: string,
    phone: string,
    response: string,             // Final response to user
    actionResult: object,         // Result from tool execution
}
```

## Tools

All tools use Zod schemas for validation:

| Tool | Description |
|------|-------------|
| `create_product` | Create new product |
| `update_product` | Update existing product |
| `delete_product` | Delete a product |
| `list_products` | List inventory |
| `add_product_images` | Prepare for image upload |
| `add_product_video` | Prepare for video upload |
| `delete_product_image` | Delete specific image |
| `delete_all_product_images` | Clear all images |
| `delete_product_video` | Remove video |
| `view_product_media` | View attached media |
| `show_help` | Display help |
| `show_status` | Show current state |

## MongoDB Collections

The checkpointer creates these collections:

- `langgraph_checkpoints` - Stores conversation states
- `langgraph_writes` - Stores pending writes

Indexes are created automatically for:
- `thread_id` + `checkpoint_id` (fast lookup)
- TTL expiry after 7 days (auto-cleanup)

## Environment Variables

```env
GEMINI_API_KEY=your_gemini_api_key
MONGODB_URI=mongodb://localhost:27017/badminton-store
WHATSAPP_ACCESS_TOKEN=your_whatsapp_token
WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id
WEBHOOK_VERIFY_TOKEN=your_verify_token
```

## Error Handling

- Automatic retries on transient errors
- Graceful degradation if AI fails
- Cancel/reset commands clear state
- Session expiry after 7 days

## Migration from Old System

The new system is backward compatible. Simply:

1. Install dependencies
2. Switch to new route
3. Old in-memory state will be lost (users start fresh)

## Debugging

Enable verbose logging:

```javascript
// In agent.js
console.log('🤖 [Agent] Processing state:', state);
console.log('✅ [LangGraph] Result:', result);
```

View MongoDB checkpoints:
```javascript
db.langgraph_checkpoints.find({ thread_id: 'whatsapp_923001234567' })
```
