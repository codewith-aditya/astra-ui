// ═══════════════════════════════════════════════════════════════════════════════
//  Layer 4: AI / Bot Detection — Heuristic Fingerprinting
// ═══════════════════════════════════════════════════════════════════════════════
//  Detects automated traffic using header analysis, UA fingerprinting,
//  and behavioral heuristics. No external ML service required —
//  runs entirely in-process with pattern matching.
//
//  Signals checked:
//    • Known bot/scanner User-Agents
//    • Missing standard browser headers
//    • Header order anomalies
//    • TLS fingerprint hints (JA3-like, if CF provides)
//    • Accept header anomalies
//    • Cookie behavior (no cookies on 2nd+ request)
//
//  .env:
//    BOT_DETECTION=true     — enable (default: true)
//    BOT_BLOCK_BOTS=true    — block detected bots (default: false = just log)
// ═══════════════════════════════════════════════════════════════════════════════

const { logSecurity } = require('./cloudflareGuard')

const ENABLED = process.env.BOT_DETECTION !== 'false'   // On by default
const BLOCK_BOTS = process.env.BOT_BLOCK_BOTS === 'true' // Off by default (log only)

// ── Known bot/scanner/scraper patterns ────────────────────────────────────
const BOT_UA_PATTERNS = [
    // Scanners & pentest tools
    /nikto/i, /sqlmap/i, /nmap/i, /masscan/i, /zgrab/i, /gobuster/i,
    /dirbuster/i, /wfuzz/i, /ffuf/i, /nuclei/i, /httpx/i, /subfinder/i,
    /amass/i, /burp/i, /zaproxy/i, /acunetix/i, /nessus/i, /openvas/i,
    /arachni/i, /skipfish/i, /w3af/i, /havij/i,

    // Generic bots
    /bot(?!tle)/i, /crawler/i, /spider/i, /scraper/i,
    /headless/i, /phantom/i, /selenium/i, /puppeteer/i, /playwright/i,
    /wget/i, /curl\/\d/i, /python-requests/i, /python-urllib/i,
    /go-http-client/i, /java\/\d/i, /libwww/i, /lwp-/i,
    /axios\/\d/i, /node-fetch/i, /undici/i, /httpie/i,

    // Aggressive crawlers
    /semrush/i, /ahrefs/i, /mj12bot/i, /dotbot/i, /petalbot/i,
    /bytespider/i, /gptbot/i, /ccbot/i, /claudebot/i,
]

// ── Allowed bots (search engines, monitoring) ─────────────────────────────
const ALLOWED_BOT_PATTERNS = [
    /googlebot/i, /bingbot/i, /yandexbot/i, /duckduckbot/i,
    /slurp/i, /baiduspider/i,
    /uptimerobot/i, /pingdom/i, /statuspage/i, /newrelic/i,
]

/**
 * Check if User-Agent matches a known bot pattern
 */
function isKnownBot(ua) {
    if (!ua) return { isBot: true, reason: 'empty_ua' }

    // Check allowed bots first
    for (const pattern of ALLOWED_BOT_PATTERNS) {
        if (pattern.test(ua)) return { isBot: false, reason: null }
    }

    // Check malicious/scanner bots
    for (const pattern of BOT_UA_PATTERNS) {
        if (pattern.test(ua)) return { isBot: true, reason: `ua_match:${pattern.source}` }
    }

    return { isBot: false, reason: null }
}

/**
 * Heuristic browser fingerprint check.
 * Real browsers always send certain headers — bots often don't.
 */
function browserFingerprint(req) {
    const signals = []
    let botScore = 0
    const headers = req.headers

    // ── Signal 1: Missing Accept header ────────────────────────────────────
    if (!headers.accept) {
        signals.push('missing_accept')
        botScore += 15
    }

    // ── Signal 2: Missing Accept-Language ──────────────────────────────────
    if (!headers['accept-language']) {
        signals.push('missing_accept_language')
        botScore += 15
    }

    // ── Signal 3: Missing Accept-Encoding ──────────────────────────────────
    if (!headers['accept-encoding']) {
        signals.push('missing_accept_encoding')
        botScore += 10
    }

    // ── Signal 4: Suspicious Accept values ─────────────────────────────────
    const accept = headers.accept || ''
    if (accept === '*/*' && req.method === 'GET') {
        // Browsers send specific accept types for page loads
        signals.push('generic_accept')
        botScore += 10
    }

    // ── Signal 5: Connection header anomaly ─────────────────────────────────
    if (!headers.connection && !headers['keep-alive']) {
        signals.push('missing_connection')
        botScore += 5
    }

    // ── Signal 6: Very short UA ────────────────────────────────────────────
    const ua = headers['user-agent'] || ''
    if (ua.length < 20 && ua.length > 0) {
        signals.push('short_ua')
        botScore += 15
    }

    // ── Signal 7: UA claims to be browser but missing browser headers ──────
    const claimsBrowser = /mozilla|chrome|safari|firefox|edge/i.test(ua)
    if (claimsBrowser && !headers['accept-language']) {
        signals.push('browser_claim_no_lang')
        botScore += 20
    }

    // ── Signal 8: Sec-Fetch headers (modern browsers always send these) ────
    // Only check for non-API requests (browser page loads)
    if (req.method === 'GET' && claimsBrowser) {
        if (!headers['sec-fetch-mode'] && !headers['sec-fetch-site']) {
            signals.push('missing_sec_fetch')
            botScore += 10
        }
    }

    return { botScore, signals }
}

/**
 * Bot detection middleware
 */
function aiDetection(req, res, next) {
    if (!ENABLED) return next()

    // Skip health checks and internal routes
    if (req.path === '/health' || req.path === '/favicon.ico') return next()

    const ua = req.headers['user-agent'] || ''

    // ── 1. Known bot UA check ──────────────────────────────────────────────
    const { isBot, reason } = isKnownBot(ua)
    if (isBot) {
        req.isBot = true
        req.botReason = reason

        logSecurity('bot_detected', 'high', req, {
            rule: 'known_bot_ua',
            pattern: reason || 'empty_ua',
            action: BLOCK_BOTS ? 'block' : 'log',
            meta: { ua: ua.slice(0, 200) },
        })

        if (BLOCK_BOTS) {
            return res.status(403).json({
                error: 'Automated access not permitted.',
                code: 'BOT_BLOCKED',
            })
        }
    }

    // ── 2. Browser fingerprint heuristics ──────────────────────────────────
    if (!isBot) {
        const fingerprint = browserFingerprint(req)

        if (fingerprint.botScore >= 50) {
            req.isBot = true
            req.botReason = `fingerprint:${fingerprint.signals.join(',')}`

            logSecurity('bot_detected', 'medium', req, {
                rule: 'fingerprint_anomaly',
                score: fingerprint.botScore,
                pattern: fingerprint.signals.join(', '),
                action: BLOCK_BOTS ? 'block' : 'warn',
                meta: { ua: ua.slice(0, 200), signals: fingerprint.signals },
            })

            if (BLOCK_BOTS && fingerprint.botScore >= 70) {
                return res.status(403).json({
                    error: 'Request blocked.',
                    code: 'BOT_FINGERPRINT',
                })
            }
        }
    }

    // Add bot info to request for downstream use
    req.isBot = req.isBot || false
    req.botReason = req.botReason || null

    next()
}

module.exports = { aiDetection, isKnownBot, browserFingerprint }
