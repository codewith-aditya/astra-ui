// ═══════════════════════════════════════════════════════════════════════════
//  Terminal server proxy.
//
//  Targets come from the TERMINAL_SERVERS env var only — never from the
//  request — so this is not a user-controlled SSRF surface. Two problems were
//  fixed here:
//
//    1. The whole client header set was forwarded upstream after deleting only
//       `host` and `origin`. That leaked the caller's Authorization header (and
//       cookies) to a third-party terminal host. Only an explicit allow-list of
//       headers is forwarded now.
//    2. Proxy failures were returned as `Terminal proxy error: <err.message>`,
//       exposing internal hostnames, ports and connection details.
// ═══════════════════════════════════════════════════════════════════════════

const express = require('express')
const router = express.Router()

const auth = require('../middleware/auth')
const { asyncHandler } = require('../utils/asyncHandler')
const logger = require('../utils/logger')
const { NotFoundError, UpstreamError } = require('../utils/errors')
const { limiters } = require('../middleware/rateLimit')

const PROXY_TIMEOUT_MS = 30_000

// Headers safe to pass through to the terminal host. Deliberately excludes
// authorization, cookie, and anything else carrying caller credentials.
const FORWARDABLE_HEADERS = ['content-type', 'accept', 'accept-language', 'user-agent']

// Hop-by-hop and length headers must not be copied back to the client; the
// body is re-sent by Express with its own framing.
const SKIP_RESPONSE_HEADERS = new Set([
    'transfer-encoding', 'content-encoding', 'content-length',
    'connection', 'keep-alive', 'upgrade',
    'set-cookie', // never relay upstream cookies to our origin
])

const TERMINAL_SERVERS = (() => {
    const raw = process.env.TERMINAL_SERVERS
    if (!raw) return []
    try {
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) {
            logger.warn('TERMINAL_SERVERS must be a JSON array — ignoring')
            return []
        }
        return parsed.filter(s => s && typeof s.id === 'string' && typeof s.url === 'string')
    } catch (err) {
        logger.warn('TERMINAL_SERVERS is not valid JSON — ignoring', { error: err.message })
        return []
    }
})()

// ─── List configured terminal servers ────────────────────────────────────────
router.get('/api/terminals', auth, asyncHandler(async (_req, res) => {
    res.json({
        success: true,
        servers: TERMINAL_SERVERS.map(s => ({
            id: s.id,
            name: s.name || s.id,
            url: s.url,
            status: 'unknown',
        })),
    })
}))

// ─── Proxy through to a configured terminal server ───────────────────────────
router.all('/api/terminals/:serverId/*', auth, limiters.outbound, asyncHandler(async (req, res) => {
    const server = TERMINAL_SERVERS.find(s => s.id === req.params.serverId)
    if (!server) throw new NotFoundError('Terminal server not found', 'terminal_not_found')

    // Strip any traversal attempt out of the sub-path before joining.
    const proxyPath = String(req.params[0] || '')
        .split('/')
        .filter(seg => seg && seg !== '.' && seg !== '..')
        .join('/')

    const targetUrl = `${server.url.replace(/\/+$/, '')}/${proxyPath}`

    const headers = {}
    for (const name of FORWARDABLE_HEADERS) {
        const value = req.headers[name]
        if (value) headers[name] = value
    }
    headers['x-forwarded-for'] = req.clientIP || req.ip || ''
    // Identify the calling user to the terminal host without handing over the
    // caller's own bearer token.
    headers['x-astra-user'] = req.userId
    if (server.apiKey) headers.authorization = `Bearer ${server.apiKey}`

    const hasBody = !['GET', 'HEAD'].includes(req.method)

    let upstream
    try {
        upstream = await fetch(targetUrl, {
            method: req.method,
            headers,
            body: hasBody ? JSON.stringify(req.body ?? {}) : undefined,
            signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
        })
    } catch (err) {
        logger.error('Terminal proxy request failed', {
            serverId: server.id,
            error: err.message,
        })
        if (err.name === 'AbortError' || err.name === 'TimeoutError') {
            throw new UpstreamError('Terminal server timed out', 'terminal_timeout', 504)
        }
        throw new UpstreamError('Terminal server is unreachable', 'terminal_unreachable', 502)
    }

    res.status(upstream.status)
    for (const [key, value] of upstream.headers.entries()) {
        if (!SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) res.setHeader(key, value)
    }
    res.send(await upstream.text())
}))

module.exports = router
