// ═══════════════════════════════════════════════════════════════════════════
//  Admin authorisation — single implementation.
//
//  Previously this check was hand-written in six places, and two of those
//  variants read `if (adminSecret && provided !== adminSecret)`, which SKIPS
//  the comparison entirely when ADMIN_SECRET is unset or empty — i.e. the
//  endpoint opens up in exactly the misconfiguration you most want covered.
//
//  Rules here:
//    • A missing/blank server-side secret always DENIES (fail closed).
//    • Comparison is constant-time to avoid leaking the secret byte-by-byte.
//    • Failures are logged with the client IP for the audit trail.
// ═══════════════════════════════════════════════════════════════════════════

const crypto = require('crypto')
const { ForbiddenError } = require('../utils/errors')
const logger = require('../utils/logger')

/** Length-independent constant-time string compare. */
function safeEqual(a, b) {
    const bufA = Buffer.from(String(a), 'utf8')
    const bufB = Buffer.from(String(b), 'utf8')
    // Hash first so differing lengths don't short-circuit (timingSafeEqual
    // throws unless the buffers are the same size).
    const hashA = crypto.createHash('sha256').update(bufA).digest()
    const hashB = crypto.createHash('sha256').update(bufB).digest()
    return crypto.timingSafeEqual(hashA, hashB)
}

function adminGuard(req, _res, next) {
    const expected = process.env.ADMIN_SECRET
    const provided = req.headers['x-admin-secret']

    // Fail closed: no configured secret means no admin access, ever.
    if (!expected || String(expected).trim().length === 0) {
        logger.error('admin.secret_not_configured', {
            path: req.originalUrl,
            ip: req.clientIp || req.ip,
        })
        return next(new ForbiddenError('Admin access is not configured', 'admin_not_configured'))
    }

    if (typeof provided !== 'string' || provided.length === 0 || !safeEqual(provided, expected)) {
        logger.warn('admin.denied', {
            path: req.originalUrl,
            ip: req.clientIp || req.ip,
            method: req.method,
        })
        return next(new ForbiddenError('Invalid admin credentials', 'admin_forbidden'))
    }

    req.isAdmin = true
    next()
}

module.exports = { adminGuard, safeEqual }
