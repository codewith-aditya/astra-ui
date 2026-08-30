// ═══════════════════════════════════════════════════════════════════════════════
//  Security Logger — Unified Audit Trail
// ═══════════════════════════════════════════════════════════════════════════════
//  Logs every request with security-relevant metadata.
//  Lightweight — only stores in memory (ring buffer) for real-time admin access.
//  Serious events are persisted to MongoDB via SecurityLog model.
//
//  Provides:
//    • In-memory ring buffer (last 500 requests) for admin /logs endpoint
//    • Response time tracking
//    • Summary stats (requests/min, error rate, top IPs)
// ═══════════════════════════════════════════════════════════════════════════════

const RING_SIZE = 500
const ringBuffer = []
let ringIndex = 0

// ── Live stats counters (reset every minute) ──────────────────────────────
const stats = {
    total: 0,
    blocked: 0,
    errors: 0,
    bots: 0,
    startedAt: Date.now(),
}

// Reset stats every 60 seconds and keep a rolling snapshot.
// unref'd: a bookkeeping timer must not hold the event loop open and delay
// process exit during a deploy or a test run.
let lastMinuteStats = { ...stats }
const statsResetTimer = setInterval(() => {
    lastMinuteStats = { ...stats }
    stats.total = 0
    stats.blocked = 0
    stats.errors = 0
    stats.bots = 0
    stats.startedAt = Date.now()
}, 60_000)
statsResetTimer.unref()

/**
 * Security logger middleware — runs early in the chain,
 * hooks into response finish to capture status + timing.
 */
function securityLogger(req, res, next) {
    const startTime = Date.now()

    // Hook into response finish
    res.on('finish', () => {
        const duration = Date.now() - startTime
        const entry = {
            ts: new Date().toISOString(),
            time: new Date().toLocaleTimeString('en-US', { hour12: false }),
            method: req.method,
            path: (req.originalUrl || req.url || '').slice(0, 150),
            status: res.statusCode,
            duration,
            ip: req.clientIP || req.ip || 'unknown',
            ua: (req.headers['user-agent'] || '').slice(0, 150),
            userId: req.userId || null,
            isBot: req.isBot || false,
            behaviorScore: req.behaviorScore || 0,
            cfCountry: req.cfMeta?.cfCountry || null,
            level: res.statusCode >= 500 ? 'error'
                : res.statusCode >= 400 ? 'warn'
                : 'info',
        }

        // Add to ring buffer
        ringBuffer[ringIndex % RING_SIZE] = entry
        ringIndex++

        // Update live stats
        stats.total++
        if (res.statusCode === 403 || res.statusCode === 429) stats.blocked++
        if (res.statusCode >= 500) stats.errors++
        if (req.isBot) stats.bots++
    })

    next()
}

/**
 * Get recent logs (for admin panel)
 * @param {Object} filters — { level, limit, ip }
 */
function getRecentLogs({ level, limit = 100, ip } = {}) {
    // Get logs from ring buffer (newest first)
    const logs = []
    const total = Math.min(ringIndex, RING_SIZE)
    const start = ringIndex - 1
    const end = Math.max(0, ringIndex - total)

    for (let i = start; i >= end && logs.length < limit; i--) {
        const entry = ringBuffer[i % RING_SIZE]
        if (!entry) continue
        if (level && entry.level !== level) continue
        if (ip && entry.ip !== ip) continue
        logs.push(entry)
    }

    return logs
}

/**
 * Get live stats (for admin dashboard)
 */
function getLiveStats() {
    return {
        currentMinute: { ...stats },
        lastMinute: { ...lastMinuteStats },
        bufferSize: Math.min(ringIndex, RING_SIZE),
    }
}

/**
 * Get top IPs by request count (for admin)
 */
function getTopIPs(limit = 20) {
    const ipCounts = new Map()
    const total = Math.min(ringIndex, RING_SIZE)

    for (let i = 0; i < total; i++) {
        const entry = ringBuffer[i]
        if (!entry) continue
        ipCounts.set(entry.ip, (ipCounts.get(entry.ip) || 0) + 1)
    }

    return Array.from(ipCounts.entries())
        .map(([ip, count]) => ({ ip, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, limit)
}

module.exports = { securityLogger, getRecentLogs, getLiveStats, getTopIPs }
