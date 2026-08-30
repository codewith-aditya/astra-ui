// ═══════════════════════════════════════════════════════════════════════════
//  Security response headers.
//
//  Set in the application rather than only at the reverse proxy so the
//  guarantees hold even when the app is reached directly (local dev, a second
//  proxy, a future container platform). nginx.conf sets the same headers; the
//  duplication is intentional defence in depth.
// ═══════════════════════════════════════════════════════════════════════════

const env = require('../config/env')

// This is a JSON API, not an HTML app: the safest policy is to forbid
// everything. Any HTML we serve (the maintenance page) is static and inline-free.
const CSP = [
    "default-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
].join('; ')

function securityHeaders(_req, res, next) {
    // Never let a browser sniff a JSON response into something executable.
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Content-Security-Policy', CSP)
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()')

    // Only advertise HSTS when the deployment actually terminates TLS —
    // sending it over plain HTTP is ignored by browsers and misleading to
    // operators.
    if (env.TRUST_PROXY || env.NODE_ENV === 'production') {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    }

    // Remove the framework fingerprint.
    res.removeHeader('X-Powered-By')

    next()
}

module.exports = { securityHeaders }
