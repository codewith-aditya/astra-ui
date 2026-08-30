// ═══════════════════════════════════════════════════════════════════════════
//  Per-request correlation id + request logging.
//
//  Every response carries an X-Request-Id. When a 5xx occurs the client sees
//  only that id while the full error (message, stack, route, user) goes to the
//  log, so support can join the two without the response ever leaking
//  internals.
// ═══════════════════════════════════════════════════════════════════════════

const crypto = require('crypto')
const logger = require('../utils/logger')

// Paths that are high-volume and uninteresting; logged at debug instead of info.
const QUIET_PATHS = new Set(['/health', '/healthz', '/readyz', '/favicon.ico'])

function requestContext(req, res, next) {
    // Honour an upstream id (nginx / Cloudflare) so a single request can be
    // traced across hops, but only if it looks sane.
    const inbound = req.headers['x-request-id']
    req.id = (typeof inbound === 'string' && /^[\w-]{8,64}$/.test(inbound))
        ? inbound
        : crypto.randomBytes(8).toString('hex')

    res.setHeader('X-Request-Id', req.id)

    const startedAt = process.hrtime.bigint()

    res.on('finish', () => {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6
        const level = res.statusCode >= 500 ? 'error'
            : res.statusCode >= 400 ? 'warn'
                : QUIET_PATHS.has(req.path) ? 'debug' : 'info'

        logger[level]('http', {
            requestId: req.id,
            method: req.method,
            path: req.path,
            status: res.statusCode,
            durationMs: Math.round(durationMs),
            userId: req.userId || undefined,
            ip: req.clientIp || req.ip,
        })
    })

    next()
}

module.exports = { requestContext }
