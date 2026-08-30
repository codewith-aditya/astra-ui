// ═══════════════════════════════════════════════════════════════════════════
//  AstraGPT API — application entrypoint.
//
//  Layer order (outermost first):
//    trust proxy → security headers → CORS → request id + logging
//    → body parse → global rate limit → CF guard → WAF → behaviour → bot
//    → routes → 404 → error handler
//
//  Two structural changes from the previous version:
//
//  1. Routers are mounted under explicit prefixes. Previously almost everything
//     was mounted at '/' and each router declared its own full /api/... path,
//     which made the real URL of an endpoint impossible to determine from this
//     file and caused collisions — routes/groups.js declared '/' and '/:id',
//     so a wildcard GET /:id sat at the application root and swallowed any
//     unclaimed single-segment path.
//
//  2. Nothing bypasses the security stack any more. /uploads was previously
//     mounted before the WAF (and mounted twice), so stored user content was
//     served with no inspection.
// ═══════════════════════════════════════════════════════════════════════════

const env = require('./config/env')

const path = require('path')
const http = require('http')
const express = require('express')
const cors = require('cors')
const mongoose = require('mongoose')
const { Server: SocketIO } = require('socket.io')

const logger = require('./utils/logger')
const { connectDatabase, disconnectDatabase } = require('./db')
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler')
const { requestContext } = require('./middleware/requestContext')
const { securityHeaders } = require('./middleware/securityHeaders')
const { limiters } = require('./middleware/rateLimit')
const { adminGuard } = require('./middleware/adminGuard')
const { registerSocketHandlers } = require('./middleware/socketAuth')

const app = express()
const httpServer = http.createServer(app)

// ─── Proxy awareness ────────────────────────────────────────────────────────
// nginx terminates the connection, so req.ip must come from X-Forwarded-For or
// every per-IP rate limit would key on 127.0.0.1 and act as one global bucket.
app.set('trust proxy', env.TRUST_PROXY)
app.disable('x-powered-by')

// ─── Layer 0: security headers ──────────────────────────────────────────────
app.use(securityHeaders)

// ─── Layer 1: CORS ──────────────────────────────────────────────────────────
// A request with no Origin header is no longer blanket-allowed: that exempted
// every non-browser client from the origin check while credentials were on.
const corsOptions = {
    origin(origin, cb) {
        if (!origin) {
            // Same-origin, curl, or server-to-server. Permitted only because
            // authentication is enforced per-route; cookies are not used.
            return cb(null, true)
        }
        if (env.ALLOWED_ORIGINS.includes(origin)) return cb(null, true)
        const err = new Error('Origin not allowed')
        err.code = 'cors_denied'   // mapped to 403 by the error handler
        return cb(err)
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-secret', 'x-user-id', 'x-request-id'],
    exposedHeaders: ['x-request-id', 'Retry-After'],
    maxAge: 86400,
}
app.use(cors(corsOptions))
app.options('*', cors(corsOptions))

// ─── Layer 2: request id + access log ───────────────────────────────────────
app.use(requestContext)

// ─── Health / readiness ─────────────────────────────────────────────────────
// Liveness stays dependency-free so a database outage cannot trigger a restart
// loop. Readiness reports the database state for the load balancer.
app.get('/health', (_req, res) => res.json({
    status: 'ok',
    service: 'AstraGPT API',
    version: require('./package.json').version,
    time: new Date().toISOString(),
}))

app.get('/ready', (_req, res) => {
    const dbUp = mongoose.connection.readyState === 1
    res.status(dbUp ? 200 : 503).json({
        status: dbUp ? 'ready' : 'degraded',
        database: dbUp ? 'connected' : 'disconnected',
    })
})

// ─── Layer 3: body parsing ──────────────────────────────────────────────────
app.use(express.json({ limit: env.JSON_BODY_LIMIT }))
app.use(express.urlencoded({ extended: false, limit: env.JSON_BODY_LIMIT }))

// ─── Layer 4: global rate limit ─────────────────────────────────────────────
app.use(limiters.global)

// ─── Layer 5-8: existing security stack ─────────────────────────────────────
const { cloudflareGuard } = require('./middleware/cloudflareGuard')
const { securityLogger, getRecentLogs, getLiveStats, getTopIPs } = require('./middleware/securityLogger')
const { waf } = require('./middleware/waf')
const { behaviorEngine, getTrackedIPs } = require('./middleware/behaviorEngine')
const { aiDetection } = require('./middleware/aiDetection')

app.use(cloudflareGuard)
app.use(securityLogger)
app.use(waf)
app.use(behaviorEngine)
app.use(aiDetection)

// ─── Static uploads ─────────────────────────────────────────────────────────
// Mounted after the security stack. Content-Disposition: attachment plus a
// restrictive CSP stops a file that passed upload validation from executing in
// a victim's browser context on our origin.
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
    index: false,
    dotfiles: 'deny',
    maxAge: '7d',
    setHeaders(res) {
        res.setHeader('Content-Disposition', 'attachment')
        res.setHeader('X-Content-Type-Options', 'nosniff')
        res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
    },
}))

// ═══════════════════════════════════════════════════════════════════════════
//  Routes
// ═══════════════════════════════════════════════════════════════════════════

// Routers that declare full /api/... paths internally.
//
// Order matters. Express matches in registration order, so any router holding a
// parameterised path must be mounted AFTER routers that declare literal paths
// under the same prefix. features.js owns `GET /api/analytics/:userId`, which
// otherwise captures `/api/analytics/users` (treating "users" as a userId and
// failing its ownership check with a 403) and shadows the admin endpoint in
// analytics.js entirely.
const selfPrefixed = [
    './routes/chat',
    './routes/analytics',   // literal /api/analytics/{dashboard,models,users,tokens}
    './routes/features',    // parameterised /api/analytics/:userId — must follow
    './routes/rag',
    './routes/knowledge',
    './routes/tools',
    './routes/functions',
    './routes/codeExec',
    './routes/channels',
    './routes/evaluations',
    './routes/tasks',
    './routes/audio',
    './routes/folders',
    './routes/skills',
    './routes/terminals',
    './routes/configs',
    './routes/mcp',
    './routes/imageUpload',
    './routes/sandbox',
]
for (const modulePath of selfPrefixed) app.use('/', require(modulePath))

// Routers that declare paths relative to a mount prefix.
app.use('/api/auth', require('./routes/auth'))
app.use('/api/mfa', require('./routes/mfa'))
app.use('/api/ax-ctrl', require('./routes/admin'))
// Previously mounted at '/', which put an authenticated wildcard GET /:id at
// the application root and left GET /api/groups nonexistent.
app.use('/api/groups', require('./routes/groups'))
app.use('/', require('./routes/coupon'))

// ─── Security dashboard (admin) ─────────────────────────────────────────────
app.get('/api/ax-ctrl/security/logs', adminGuard, (req, res) => {
    const v = require('./utils/validate')
    res.json({
        logs: getRecentLogs({
            level: req.query.level,
            limit: v.clampInt(req.query.limit, { min: 1, max: 500, fallback: 100 }),
            ip: req.query.ip,
        }),
        stats: getLiveStats(),
        topIPs: getTopIPs(),
        trackedIPs: getTrackedIPs(),
    })
})

// ─── 404 + error handler (must be last) ─────────────────────────────────────
app.use(notFoundHandler)
app.use(errorHandler)

// ═══════════════════════════════════════════════════════════════════════════
//  Socket.IO — authenticated
// ═══════════════════════════════════════════════════════════════════════════
// Previously any client could emit `register` with an arbitrary userId and join
// that user's private room, or join any chat/channel room by id. Identity now
// comes from a verified access token and is never taken from client payloads.

const io = new SocketIO(httpServer, {
    cors: { origin: env.ALLOWED_ORIGINS, methods: ['GET', 'POST'], credentials: true },
    maxHttpBufferSize: 1e6,
    pingTimeout: 30_000,
})

// Handlers live in middleware/socketAuth.js. The inline copy that used to sit
// here duplicated them, but skipped two checks the module performs: it never
// compared the token's `tv` against User.tokenVersion (so a socket opened before
// a password change or "sign out everywhere" kept streaming), never rejected a
// banned account, and tracked presence as one socketId per user — so closing any
// one tab marked the user offline while other tabs were still connected.
const onlineUsers = new Map()
registerSocketHandlers(io, onlineUsers)

app.set('io', io)
app.set('onlineUsers', onlineUsers)

// ═══════════════════════════════════════════════════════════════════════════
//  Startup / shutdown
// ═══════════════════════════════════════════════════════════════════════════

let shuttingDown = false

async function start() {
    // The database is a hard dependency: starting without it produced a server
    // that accepted traffic and 500'd on every request.
    await connectDatabase()

    await new Promise((resolve, reject) => {
        httpServer.once('error', reject)
        httpServer.listen(env.PORT, '0.0.0.0', resolve)
    })

    logger.info('AstraGPT API listening', {
        port: env.PORT,
        env: env.NODE_ENV,
        rateLimitBackend: require('./middleware/rateLimit').describeBackend(),
    })

    if (env.SANDBOX_WARM_IMAGES) {
        // Pre-pull container images so the first user request does not pay the
        // pull cost and time out.
        require('./utils/sandbox').warmImages().catch(err =>
            logger.warn('Sandbox image warm-up failed', { err: err.message }))
    }
}

// Graceful shutdown: stop accepting connections, close sockets, drain, then
// close the database. Without this, a deploy severed in-flight SSE streams and
// could interrupt a Mongo write mid-operation.
async function shutdown(signal) {
    if (shuttingDown) return
    shuttingDown = true
    logger.info('Shutting down', { signal })

    const forceExit = setTimeout(() => {
        logger.error('Graceful shutdown timed out — forcing exit')
        process.exit(1)
    }, env.SHUTDOWN_TIMEOUT_MS)
    forceExit.unref()

    try {
        io.close()
        await new Promise(resolve => httpServer.close(resolve))
        await disconnectDatabase()
        clearTimeout(forceExit)
        logger.info('Shutdown complete')
        process.exit(0)
    } catch (err) {
        logger.error('Error during shutdown', err)
        process.exit(1)
    }
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

// A process in an undefined state must not keep serving traffic. Log, then let
// the supervisor restart cleanly.
process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', reason instanceof Error ? reason : { reason })
    shutdown('unhandledRejection')
})

process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', err)
    shutdown('uncaughtException')
})

if (require.main === module) {
    start().catch(err => {
        logger.error('Failed to start server', err)
        process.exit(1)
    })
}

module.exports = { app, httpServer, io, start, shutdown }
