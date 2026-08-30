// ═══════════════════════════════════════════════════════════════════════════
//  Structured logger with secret redaction.
//
//  Replaces ad-hoc console.* calls. Emits JSON in production (parseable by
//  log shippers) and readable lines in development. Any value that looks like
//  a credential is redacted before it reaches a transport, so an accidental
//  logger.info({ apiKey }) cannot leak.
// ═══════════════════════════════════════════════════════════════════════════

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 }

let configured = { level: 'info', json: false }
try {
    const env = require('../config/env')
    configured = { level: env.LOG_LEVEL, json: env.isProd, silent: env.isTest }
} catch {
    // env not validated yet (or invalid) — fall back to safe defaults so that
    // the logger itself can never be the reason boot fails.
}

const threshold = LEVELS[configured.level] ?? LEVELS.info

// Keys whose values must never be logged.
const SECRET_KEY = /(pass|secret|token|key|authorization|cookie|otp|mfa|credential|dsn|uri|url)/i

// Values that look like credentials regardless of their key.
const SECRET_VALUE = [
    /\bsk[-_][A-Za-z0-9_-]{12,}/g,          // provider API keys
    /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, // JWTs
    /\bmongodb(\+srv)?:\/\/[^\s"']+/gi,      // connection strings w/ credentials
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, // emails (PII)
]

function redactString(s) {
    let out = s
    for (const rx of SECRET_VALUE) out = out.replace(rx, '[redacted]')
    return out
}

function redact(value, depth = 0) {
    if (depth > 6) return '[depth-limit]'
    if (value == null) return value
    if (typeof value === 'string') return redactString(value)
    if (typeof value === 'number' || typeof value === 'boolean') return value
    if (value instanceof Error) {
        return { name: value.name, message: redactString(value.message), code: value.code }
    }
    if (Array.isArray(value)) return value.slice(0, 50).map(v => redact(v, depth + 1))
    if (typeof value === 'object') {
        const out = {}
        for (const [k, v] of Object.entries(value)) {
            out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1)
        }
        return out
    }
    return String(value)
}

function emit(level, msg, meta) {
    if (configured.silent) return
    if (LEVELS[level] > threshold) return

    const safeMsg = typeof msg === 'string' ? redactString(msg) : redact(msg)
    const safeMeta = meta === undefined ? undefined : redact(meta)

    /* eslint-disable no-console */
    const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log

    if (configured.json) {
        sink(JSON.stringify({ ts: new Date().toISOString(), level, msg: safeMsg, ...(safeMeta ? { meta: safeMeta } : {}) }))
    } else {
        const tag = level.toUpperCase().padEnd(5)
        sink(safeMeta !== undefined ? `${tag} ${safeMsg}` : `${tag} ${safeMsg}`, safeMeta !== undefined ? safeMeta : '')
    }
    /* eslint-enable no-console */
}

const logger = {
    error: (msg, meta) => emit('error', msg, meta),
    warn: (msg, meta) => emit('warn', msg, meta),
    info: (msg, meta) => emit('info', msg, meta),
    debug: (msg, meta) => emit('debug', msg, meta),

    /** Namespaced child logger: logger.child('auth').info('...') */
    child(scope) {
        return {
            error: (m, meta) => emit('error', `[${scope}] ${m}`, meta),
            warn: (m, meta) => emit('warn', `[${scope}] ${m}`, meta),
            info: (m, meta) => emit('info', `[${scope}] ${m}`, meta),
            debug: (m, meta) => emit('debug', `[${scope}] ${m}`, meta),
        }
    },

    redact,
}

module.exports = logger
