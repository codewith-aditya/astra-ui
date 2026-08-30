// ═══════════════════════════════════════════════════════════════════════════
//  MCP (Model Context Protocol) tool servers.
//
//  SSRF fix: `url` arrives from the request body and was previously fetched
//  with no validation at all, letting a caller reach cloud metadata endpoints
//  (169.254.169.254), localhost admin ports, or any host on the VPS's private
//  network. All outbound requests now go through utils/safeFetch, which
//  resolves DNS and rejects private/loopback/link-local address space —
//  including on every redirect hop.
// ═══════════════════════════════════════════════════════════════════════════

const express = require('express')
const router = express.Router()

const Config = require('../models/Config')
const auth = require('../middleware/auth')
const { asyncHandler } = require('../utils/asyncHandler')
const { outboundLimiter, writeLimiter } = require('../middleware/rateLimit')
const { safeFetch } = require('../utils/safeFetch')
const logger = require('../utils/logger')
const v = require('../utils/validate')
const { BadRequestError, NotFoundError, ServiceUnavailableError, UpstreamError } = require('../utils/errors')

const CONFIG_KEY = 'mcp_servers'
const MAX_SERVERS_PER_USER = 25

// Live connection state. Persistent definitions live in Config; this only
// caches discovered tools and reachability for the current process.
const mcpServers = new Map()

function publicView(entry) {
    const { apiKey, ...rest } = entry
    return { ...rest, hasApiKey: Boolean(apiKey) }
}

async function loadServers(userId) {
    const doc = await Config.findOne({ userId, key: CONFIG_KEY }).lean()
    return Array.isArray(doc?.value) ? doc.value : []
}

async function saveServers(userId, servers) {
    await Config.findOneAndUpdate(
        { userId, key: CONFIG_KEY },
        { $set: { value: servers, updatedAt: new Date() } },
        { upsert: true }
    )
}

// ─── POST /api/mcp/servers — register a server ───────────────────────────────
router.post('/api/mcp/servers', auth, writeLimiter, asyncHandler(async (req, res) => {
    const name = v.str(req.body.name, 'name', { max: 120 })
    const url = v.httpUrl(req.body.url, 'url')
    const apiKey = v.str(req.body.apiKey, 'apiKey', { max: 500, allowEmpty: true }) || ''
    const description = v.str(req.body.description, 'description', { max: 1000, allowEmpty: true }) || ''

    const servers = await loadServers(req.userId)
    if (servers.length >= MAX_SERVERS_PER_USER) {
        throw new BadRequestError(`Maximum ${MAX_SERVERS_PER_USER} MCP servers allowed`, 'server_limit_reached')
    }

    const serverId = `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const entry = {
        id: serverId,
        name,
        url,
        apiKey,
        description,
        status: 'disconnected',
        tools: [],
        addedBy: req.userId,
        addedAt: new Date().toISOString(),
    }

    // Attempt discovery. Unreachable is not an error — the server is stored as
    // disconnected — but an SSRF-blocked target is a client error worth surfacing.
    try {
        const response = await safeFetch(`${url.replace(/\/$/, '')}/tools`, {
            headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
            timeoutMs: 10_000,
            maxBytes: 1_000_000,
        })
        if (response.ok) {
            const data = await response.json().catch(() => null)
            entry.tools = Array.isArray(data?.tools) ? data.tools : (Array.isArray(data) ? data : [])
            entry.status = 'connected'
        }
    } catch (err) {
        if (err.code === 'blocked_address' || err.code === 'invalid_url_scheme') {
            throw new BadRequestError(
                'That URL resolves to a blocked or private address.',
                'blocked_address'
            )
        }
        logger.debug('MCP discovery failed', { serverId, error: err.message })
    }

    mcpServers.set(serverId, entry)
    servers.push({ id: serverId, name, url, apiKey, description })
    await saveServers(req.userId, servers)

    res.status(201).json({ success: true, server: publicView(entry) })
}))

// ─── GET /api/mcp/servers ────────────────────────────────────────────────────
router.get('/api/mcp/servers', auth, asyncHandler(async (req, res) => {
    const saved = await loadServers(req.userId)
    const servers = saved.map(s => {
        const live = mcpServers.get(s.id)
        return publicView({
            ...s,
            status: live?.status || 'disconnected',
            tools: live?.tools || [],
        })
    })
    res.json({ success: true, servers })
}))

// ─── DELETE /api/mcp/servers/:id ─────────────────────────────────────────────
router.delete('/api/mcp/servers/:id', auth, writeLimiter, asyncHandler(async (req, res) => {
    const serverId = v.id(req.params.id, 'serverId')
    const servers = await loadServers(req.userId)
    const remaining = servers.filter(s => s.id !== serverId)

    if (remaining.length === servers.length) {
        throw new NotFoundError('MCP server not found', 'server_not_found')
    }

    mcpServers.delete(serverId)
    await saveServers(req.userId, remaining)
    res.json({ success: true, message: 'MCP server removed' })
}))

// ─── POST /api/mcp/execute ───────────────────────────────────────────────────
router.post('/api/mcp/execute', auth, outboundLimiter, asyncHandler(async (req, res) => {
    const serverId = v.id(req.body.serverId, 'serverId')
    // Tool names become a path segment — restrict to a safe character set so a
    // value like "../../admin" cannot traverse to another endpoint.
    const toolName = v.str(req.body.toolName, 'toolName', {
        max: 120,
        pattern: /^[A-Za-z0-9_.-]+$/,
    })
    const args = v.safeObject(req.body.arguments, 'arguments') || {}

    // Confirm the caller owns this server before using its stored credentials.
    const owned = (await loadServers(req.userId)).find(s => s.id === serverId)
    if (!owned) throw new NotFoundError('MCP server not found', 'server_not_found')

    const live = mcpServers.get(serverId)
    if (!live || live.status !== 'connected') {
        throw new ServiceUnavailableError('MCP server is not connected', 'server_disconnected')
    }

    let response
    try {
        response = await safeFetch(`${owned.url.replace(/\/$/, '')}/tools/${encodeURIComponent(toolName)}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(owned.apiKey ? { Authorization: `Bearer ${owned.apiKey}` } : {}),
            },
            body: JSON.stringify({ arguments: args }),
            timeoutMs: 30_000,
            maxBytes: 5_000_000,
        })
    } catch (err) {
        if (err.code === 'blocked_address') {
            throw new BadRequestError('That server resolves to a blocked address.', 'blocked_address')
        }
        throw new UpstreamError('MCP server request failed', 'mcp_unreachable')
    }

    if (!response.ok) {
        // Upstream body is not echoed to the client: it can carry internal
        // hostnames and stack traces from the remote server.
        logger.warn('MCP tool returned an error', { serverId, toolName, status: response.status })
        throw new UpstreamError('MCP tool returned an error', 'mcp_tool_error')
    }

    const result = await response.json().catch(() => null)
    res.json({ success: true, result })
}))

module.exports = router
