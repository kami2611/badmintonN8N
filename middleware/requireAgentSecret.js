/**
 * Agent Secret Middleware
 * Protects API routes that should only be called by the n8n agent
 */

/**
 * Middleware to verify the agent secret from request headers
 * Checks x-agent-secret header against AGENT_SECRET env variable
 */
function requireAgentSecret(req, res, next) {
    const agentSecret = req.headers['x-agent-secret'];
    
    if (!process.env.AGENT_SECRET) {
        console.error('❌ [AUTH] AGENT_SECRET not configured in environment');
        return res.status(500).json({ 
            error: 'Server configuration error',
            message: 'Agent authentication not configured'
        });
    }
    
    if (!agentSecret) {
        console.warn('⚠️ [AUTH] Missing x-agent-secret header from:', req.ip);
        return res.status(401).json({ 
            error: 'Unauthorized',
            message: 'Missing authentication header'
        });
    }
    
    if (agentSecret !== process.env.AGENT_SECRET) {
        console.warn('⚠️ [AUTH] Invalid agent secret from:', req.ip);
        return res.status(401).json({ 
            error: 'Unauthorized',
            message: 'Invalid authentication'
        });
    }
    
    // Secret is valid, proceed
    next();
}

module.exports = requireAgentSecret;
