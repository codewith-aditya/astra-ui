// ═══════════════════════════════════════════════════════════════════════════════
//  Layer 1: Cloudflare Guard — CDN / DDoS / IP Validation
// ═══════════════════════════════════════════════════════════════════════════════
//  Validates Cloudflare headers, extracts real client IP,
//  checks CF threat score, and blocks suspicious origins.
//
//  When behind Cloudflare:
//    CF-Connecting-IP  → real client IP
//    CF-IPCountry      → client country code
//    CF-Ray            → request trace ID
//    X-Forwarded-For   → proxy chain
//    cf-threat-score   → 0 (safe) to 100 (dangerous)
//
//  Set in .env:
//    BEHIND_CLOUDFLARE=true          — enforce CF header presence
//    CF_THREAT_THRESHOLD=30          — block above this score (default: 30)
//    BLOCKED_COUNTRIES=CN,RU,KP      — block these country codes (optional)
// ═══════════════════════════════════════════════════════════════════════════════

const SecurityLog = require('../models/SecurityLog')

const IS_CF = process.env.BEHIND_CLOUDFLARE === 'true'
const THREAT_THRESHOLD = parseInt(process.env.CF_THREAT_THRESHOLD) || 30

const BLOCKED_COUNTRIES = process.env.BLOCKED_COUNTRIES
    ? process.env.BLOCKED_COUNTRIES.split(',').map(c => c.trim().toUpperCase())
    : []

// ── Known bad IP ranges (private-as-public, bogon IPs) ────────────────────
const BOGON_PREFIXES = [
    '0.', '10.', '100.64.', '127.', '169.254.', '172.16.', '172.17.',
    '172.18.', '172.19.', '172.20.', '172.21.', '172.22.', '172.23.',
    '172.24.', '172.25.', '172.26.', '172.27.', '172.28.', '172.29.',
    '172.30.', '172.31.', '192.0.0.', '192.168.', '198.18.', '198.19.',
]

function isBogonIP(ip) {
    if (!ip) return false
    // In development, allow private IPs
    if (process.env.NODE_ENV !== 'production') return false
    return BOGON_PREFIXES.some(prefix => ip.startsWith(prefix))
}

/**
 * Extract the real client IP from request headers.
 * Priority: CF-Connecting-IP > X-Real-IP > X-Forwarded-For > req.ip
 */
function extractClientIP(req) {
    return (
        req.headers['cf-connecting-ip'] ||
        req.headers['x-real-ip'] ||
        (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
        req.ip ||
        req.connection?.remoteAddress ||
        'unknown'
    )
}

/**
 * Cloudflare guard middleware
 */
function cloudflareGuard(req, res, next) {
    // ── 1. Extract real IP ─────────────────────────────────────────────────
    const clientIP = extractClientIP(req)
    req.clientIP = clientIP  // Attach to req for downstream middleware

    // ── 2. Extract CF metadata ─────────────────────────────────────────────
    const cfRay = req.headers['cf-ray'] || null
    const cfCountry = (req.headers['cf-ipcountry'] || '').toUpperCase() || null
    const cfThreatScore = parseInt(req.headers['cf-threat-score']) || 0

    req.cfMeta = { cfRay, cfCountry, cfThreatScore }

    // ── 3. If behind Cloudflare, validate CF headers ──────────────────────
    if (IS_CF && !cfRay) {
        // Request didn't come through Cloudflare — direct access attempt
        logSecurity('cf_challenge', 'high', req, {
            rule: 'cf_bypass_attempt',
            pattern: 'Missing CF-Ray header on CF-protected endpoint',
        })
        return res.status(403).json({
            error: 'Direct access not allowed. Requests must come through CDN.',
        })
    }

    // ── 4. Bogon IP check (in production) ─────────────────────────────────
    if (isBogonIP(clientIP)) {
        logSecurity('ip_blocked', 'high', req, {
            rule: 'bogon_ip',
            pattern: `Bogon IP: ${clientIP}`,
        })
        return res.status(403).json({ error: 'Forbidden' })
    }

    // ── 5. CF Threat score check ──────────────────────────────────────────
    if (cfThreatScore > THREAT_THRESHOLD) {
        logSecurity('cf_challenge', 'high', req, {
            rule: 'cf_threat_score',
            pattern: `Threat score: ${cfThreatScore} > ${THREAT_THRESHOLD}`,
            score: cfThreatScore,
        })
        return res.status(403).json({
            error: 'Request blocked by threat detection.',
        })
    }

    // ── 6. Country blocking ───────────────────────────────────────────────
    if (cfCountry && BLOCKED_COUNTRIES.length > 0 && BLOCKED_COUNTRIES.includes(cfCountry)) {
        logSecurity('ip_blocked', 'medium', req, {
            rule: 'country_block',
            pattern: `Blocked country: ${cfCountry}`,
        })
        return res.status(403).json({ error: 'Service not available in your region.' })
    }

    next()
}

// ── Fire-and-forget security log ──────────────────────────────────────────
function logSecurity(type, severity, req, extra = {}) {
    SecurityLog.create({
        type,
        severity,
        ip: req.clientIP || extractClientIP(req),
        userAgent: (req.headers['user-agent'] || '').slice(0, 300),
        method: req.method,
        path: req.originalUrl?.slice(0, 200),
        origin: req.headers.origin || null,
        cfRay: req.cfMeta?.cfRay,
        cfCountry: req.cfMeta?.cfCountry,
        cfThreatScore: req.cfMeta?.cfThreatScore,
        ...extra,
    }).catch(() => {})  // Never let logging crash the server
}

module.exports = { cloudflareGuard, extractClientIP, logSecurity }
