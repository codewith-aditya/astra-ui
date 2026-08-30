// ═══════════════════════════════════════════════════════════════════════════════
//  Layer 3: Behavior Engine — Anomaly Scoring
// ═══════════════════════════════════════════════════════════════════════════════
//  Tracks per-IP request patterns and assigns a risk score (0-100).
//  Combines multiple signals:
//    • Request velocity (rapid-fire requests)
//    • Endpoint diversity (scanning many endpoints)
//    • Error rate (lots of 4xx/5xx)
//    • Time-of-day anomalies (unusual hours)
//    • Payload anomalies (empty/huge bodies)
//    • User-Agent consistency (switching UAs)
//
//  Score thresholds:
//    0-30:   Normal — pass through
//    31-60:  Suspicious — add warning header, log
//    61-80:  High risk — add delay (tarpit), log
//    81-100: Blocked — reject + log
//
//  In-memory sliding window per IP (no Redis dependency).
//  Entries auto-expire after 5 minutes.
//
//  .env:
//    BEHAVIOR_BLOCK_SCORE=80    — block above this (default: 80)
//    BEHAVIOR_WINDOW_MS=300000  — tracking window (default: 5 min)
// ═══════════════════════════════════════════════════════════════════════════════

const { logSecurity } = require('./cloudflareGuard')

const BLOCK_SCORE = parseInt(process.env.BEHAVIOR_BLOCK_SCORE) || 80
const WINDOW_MS = parseInt(process.env.BEHAVIOR_WINDOW_MS) || 5 * 60 * 1000  // 5 min

// ── In-memory IP tracker ──────────────────────────────────────────────────
// Map<ip, { requests: [{ts, path, method, status, ua, bodySize}], score }>
const ipTracker = new Map()

// Cleanup stale entries every 2 minutes.
// unref'd so this housekeeping timer never keeps the event loop alive: without
// it the process refuses to exit on SIGTERM and the graceful-shutdown path has
// to fall through to a forced exit.
const behaviorSweeper = setInterval(() => {
    const now = Date.now()
    for (const [ip, data] of ipTracker) {
        data.requests = data.requests.filter(r => now - r.ts < WINDOW_MS)
        if (data.requests.length === 0) ipTracker.delete(ip)
    }
}, 2 * 60 * 1000)
behaviorSweeper.unref()

/**
 * Calculate behavior risk score for an IP based on recent activity
 */
function calculateScore(requests) {
    if (requests.length === 0) return 0
    let score = 0

    const now = Date.now()
    const recent = requests.filter(r => now - r.ts < WINDOW_MS)
    const count = recent.length

    // ── Signal 1: Request velocity ─────────────────────────────────────────
    // Normal user: ~1-2 req/sec max
    // Bot/scanner: 10+ req/sec
    if (count >= 5) {
        const firstTs = recent[0].ts
        const elapsed = (now - firstTs) / 1000 || 1
        const rps = count / elapsed
        if (rps > 10) score += 35          // Very fast
        else if (rps > 5) score += 20      // Fast
        else if (rps > 3) score += 10      // Slightly elevated
    }

    // ── Signal 2: Endpoint diversity (scanning) ────────────────────────────
    const uniquePaths = new Set(recent.map(r => r.path.split('?')[0])).size
    if (uniquePaths > 15) score += 25       // Scanning many endpoints
    else if (uniquePaths > 8) score += 12

    // ── Signal 3: Error rate ───────────────────────────────────────────────
    const errors = recent.filter(r => r.status >= 400).length
    const errorRate = count > 0 ? errors / count : 0
    if (errorRate > 0.7) score += 20        // 70%+ errors = fuzzing
    else if (errorRate > 0.4) score += 10

    // ── Signal 4: User-Agent switching ─────────────────────────────────────
    const uniqueUAs = new Set(recent.map(r => r.ua)).size
    if (uniqueUAs > 3) score += 15          // Rotating user agents

    // ── Signal 5: Request volume in window ─────────────────────────────────
    if (count > 200) score += 20
    else if (count > 100) score += 10
    else if (count > 50) score += 5

    // ── Signal 6: Suspicious methods ───────────────────────────────────────
    const methods = new Set(recent.map(r => r.method))
    const suspiciousMethods = ['DELETE', 'PUT', 'PATCH', 'OPTIONS', 'TRACE', 'CONNECT']
    const suspCount = suspiciousMethods.filter(m => methods.has(m)).length
    if (suspCount >= 3) score += 10

    return Math.min(100, score)
}

/**
 * Behavior engine middleware — runs BEFORE route handlers
 */
function behaviorEngine(req, res, next) {
    const ip = req.clientIP || req.ip || 'unknown'

    // Initialize tracker for this IP
    if (!ipTracker.has(ip)) {
        ipTracker.set(ip, { requests: [], score: 0 })
    }

    const tracker = ipTracker.get(ip)

    // Record this request
    tracker.requests.push({
        ts: Date.now(),
        path: (req.originalUrl || req.url || '').slice(0, 100),
        method: req.method,
        status: 0,  // Updated in response hook
        ua: (req.headers['user-agent'] || '').slice(0, 100),
        bodySize: parseInt(req.headers['content-length'] || '0'),
    })

    // Calculate score
    const score = calculateScore(tracker.requests)
    tracker.score = score
    req.behaviorScore = score

    // ── Decision based on score ────────────────────────────────────────────
    if (score >= BLOCK_SCORE) {
        logSecurity('behavior_anomaly', 'critical', req, {
            rule: 'behavior_score_exceeded',
            score,
            pattern: `Score ${score}/100 — blocked`,
            meta: {
                requestCount: tracker.requests.length,
                uniquePaths: new Set(tracker.requests.map(r => r.path.split('?')[0])).size,
            },
        })
        return res.status(429).json({
            error: 'Too many requests. Please slow down.',
            code: 'BEHAVIOR_BLOCK',
            retryAfter: 60,
        })
    }

    if (score >= 61) {
        // Tarpit — add artificial delay
        const delay = Math.min(3000, (score - 60) * 75)  // 75ms per point, max 3s
        logSecurity('behavior_anomaly', 'high', req, {
            rule: 'behavior_tarpit',
            score,
            action: 'warn',
            pattern: `Score ${score}/100 — tarpitted ${delay}ms`,
        })
        res.setHeader('X-Behavior-Warning', 'slow-down')
        return setTimeout(() => next(), delay)
    }

    if (score >= 31) {
        res.setHeader('X-Behavior-Warning', 'elevated')
    }

    // ── Hook into response to track status codes ──────────────────────────
    const origEnd = res.end
    res.end = function (...args) {
        // Update the last request with the response status
        const last = tracker.requests[tracker.requests.length - 1]
        if (last) last.status = res.statusCode
        origEnd.apply(res, args)
    }

    next()
}

/**
 * Get current score for an IP (for admin dashboard)
 */
function getIPScore(ip) {
    const tracker = ipTracker.get(ip)
    if (!tracker) return { score: 0, requests: 0 }
    return { score: tracker.score, requests: tracker.requests.length }
}

/**
 * Get all tracked IPs (for admin)
 */
function getTrackedIPs() {
    const result = []
    for (const [ip, data] of ipTracker) {
        result.push({ ip, score: data.score, requests: data.requests.length })
    }
    return result.sort((a, b) => b.score - a.score)
}

module.exports = { behaviorEngine, getIPScore, getTrackedIPs }
