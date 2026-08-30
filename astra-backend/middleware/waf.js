// ═══════════════════════════════════════════════════════════════════════════════
//  Layer 2: WAF — Web Application Firewall
// ═══════════════════════════════════════════════════════════════════════════════
//  Inspects URL, query params, headers, and body for attack patterns.
//  Detects: SQL injection, XSS, path traversal, command injection,
//           protocol smuggling, SSRF, prototype pollution.
//
//  IMPORTANT: Chat messages (user prompts) are whitelisted — users can
//  discuss code / SQL / scripts without being blocked. Only structural
//  fields (URL, headers, non-message body keys) are inspected.
// ═══════════════════════════════════════════════════════════════════════════════

const { logSecurity } = require('./cloudflareGuard')

// ── Attack pattern definitions ────────────────────────────────────────────
const WAF_RULES = [
    // ── SQL Injection ──────────────────────────────────────────────────────
    {
        id: 'sqli_union',
        severity: 'critical',
        pattern: /(\bunion\b\s+(all\s+)?select\b)/i,
        desc: 'SQL UNION injection',
    },
    {
        id: 'sqli_comment',
        severity: 'high',
        pattern: /(--|#|\/\*\*\/)\s*(drop|alter|delete|update|insert|create|exec)\b/i,
        desc: 'SQL comment injection',
    },
    {
        id: 'sqli_tautology',
        severity: 'high',
        pattern: /('|")\s*(or|and)\s*('|"|\d)\s*=\s*('|"|\d)/i,
        desc: 'SQL tautology attack',
    },
    {
        id: 'sqli_sleep',
        severity: 'high',
        pattern: /\b(sleep|benchmark|waitfor|pg_sleep)\s*\(/i,
        desc: 'SQL time-based injection',
    },

    // ── XSS ────────────────────────────────────────────────────────────────
    {
        id: 'xss_script',
        severity: 'high',
        pattern: /<script[\s>]/i,
        desc: 'XSS script tag',
    },
    {
        id: 'xss_event',
        severity: 'high',
        pattern: /\bon(error|load|click|mouse|focus|blur|submit|change|input)\s*=/i,
        desc: 'XSS event handler',
    },
    {
        id: 'xss_eval',
        severity: 'high',
        pattern: /(javascript|vbscript|data)\s*:/i,
        desc: 'XSS protocol injection',
    },

    // ── Path Traversal ─────────────────────────────────────────────────────
    {
        id: 'path_traversal',
        severity: 'critical',
        pattern: /(\.\.[\/\\]){2,}/,
        desc: 'Path traversal attack',
    },
    {
        id: 'path_sensitive',
        severity: 'high',
        pattern: /\/(etc\/passwd|proc\/self|\.env|\.git\/|wp-admin|phpmyadmin)/i,
        desc: 'Sensitive path access',
    },

    // ── Command Injection ──────────────────────────────────────────────────
    {
        id: 'cmd_injection',
        severity: 'critical',
        pattern: /[;&|`]\s*(cat|curl|wget|nc|ncat|bash|sh|python|perl|ruby|node)\b/i,
        desc: 'Command injection',
    },
    {
        id: 'cmd_backtick',
        severity: 'high',
        pattern: /`[^`]*`/,
        desc: 'Backtick command execution',
    },

    // ── SSRF ───────────────────────────────────────────────────────────────
    {
        id: 'ssrf_metadata',
        severity: 'critical',
        pattern: /(169\.254\.169\.254|metadata\.google|100\.100\.100\.200)/,
        desc: 'Cloud metadata SSRF',
    },
    {
        id: 'ssrf_internal',
        severity: 'high',
        pattern: /https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|10\.\d|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/i,
        desc: 'Internal network SSRF',
    },

    // ── Prototype Pollution ────────────────────────────────────────────────
    {
        id: 'proto_pollution',
        severity: 'critical',
        pattern: /__proto__|constructor\s*\[|prototype\s*\[/i,
        desc: 'Prototype pollution attempt',
    },

    // ── Log Injection / Header Injection ───────────────────────────────────
    {
        id: 'header_injection',
        severity: 'medium',
        pattern: /[\r\n](Set-Cookie|Location|X-Forwarded):/i,
        desc: 'HTTP header injection',
    },
]

// ── Fields in request body that contain user chat content or image data (whitelisted) ────
const CHAT_CONTENT_FIELDS = new Set([
    'content', 'text', 'message', 'prompt', 'query', 'avatarurl', 'avatar', 'image', 'imagedata', 'base64', 'file', 'data'
])

/**
 * Recursively extract all string values from an object,
 * EXCLUDING whitelisted chat content and image fields.
 */
function extractInspectableStrings(obj, parentKey = '') {
    const strings = []
    if (!obj || typeof obj !== 'object') return strings

    for (const [key, value] of Object.entries(obj)) {
        // Skip chat content & image data fields — users can discuss code / upload avatar freely
        if (CHAT_CONTENT_FIELDS.has(key.toLowerCase())) continue

        // Skip the messages array (it contains chat history with code etc)
        if (key === 'messages' && Array.isArray(value)) continue

        if (typeof value === 'string') {
            // Skip base64 image data strings
            if (value.startsWith('data:image/') || value.length > 5000) continue
            strings.push({ key, value })
        } else if (typeof value === 'object' && value !== null) {
            strings.push(...extractInspectableStrings(value, key))
        }
    }
    return strings
}

/**
 * WAF middleware — inspects request for attack patterns
 */
function waf(req, res, next) {
    const violations = []

    // ── 1. Inspect URL + query string ──────────────────────────────────────
    const urlToCheck = decodeURIComponent(req.originalUrl || req.url || '')
    for (const rule of WAF_RULES) {
        if (rule.pattern.test(urlToCheck)) {
            violations.push({ rule: rule.id, severity: rule.severity, location: 'url', match: urlToCheck.slice(0, 100) })
        }
    }

    // ── 2. Inspect non-standard headers ────────────────────────────────────
    const SKIP_HEADERS = new Set(['host', 'content-type', 'content-length', 'authorization',
        'user-agent', 'accept', 'accept-language', 'accept-encoding', 'connection',
        'origin', 'referer', 'cookie', 'x-admin-secret', 'cf-ray', 'cf-connecting-ip',
        'cf-ipcountry', 'x-forwarded-for', 'x-real-ip', 'x-request-id'])

    for (const [hdr, val] of Object.entries(req.headers)) {
        if (SKIP_HEADERS.has(hdr.toLowerCase())) continue
        if (typeof val !== 'string') continue
        for (const rule of WAF_RULES) {
            if (rule.pattern.test(val)) {
                violations.push({ rule: rule.id, severity: rule.severity, location: `header:${hdr}`, match: val.slice(0, 100) })
            }
        }
    }

    // ── 3. Inspect body (excluding chat content) ───────────────────────────
    if (req.body && typeof req.body === 'object') {
        const inspectable = extractInspectableStrings(req.body)
        for (const { key, value } of inspectable) {
            for (const rule of WAF_RULES) {
                if (rule.pattern.test(value)) {
                    violations.push({ rule: rule.id, severity: rule.severity, location: `body:${key}`, match: value.slice(0, 100) })
                }
            }
        }
    }

    // ── 4. Payload size guard ──────────────────────────────────────────────
    const contentLength = parseInt(req.headers['content-length'] || '0')
    if (contentLength > 25 * 1024 * 1024) {  // 25MB hard limit
        violations.push({ rule: 'payload_too_large', severity: 'medium', location: 'header', match: `${contentLength} bytes` })
    }

    // ── 5. Block or pass ───────────────────────────────────────────────────
    if (violations.length > 0) {
        // Pick the highest severity violation
        const severityOrder = { critical: 4, high: 3, medium: 2, low: 1 }
        violations.sort((a, b) => (severityOrder[b.severity] || 0) - (severityOrder[a.severity] || 0))
        const top = violations[0]

        logSecurity('waf_block', top.severity, req, {
            rule: top.rule,
            pattern: top.match,
            meta: { violations: violations.length, all: violations.slice(0, 5) },
        })

        return res.status(403).json({
            error: 'Request blocked by security filter.',
            code: 'WAF_BLOCK',
        })
    }

    next()
}

module.exports = { waf, WAF_RULES }
