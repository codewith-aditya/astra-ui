// ─── SecurityLog — Audit Trail for all security events ────────────────────────
// Stores blocked requests, WAF triggers, behavior anomalies, bot detections
// Auto-expires after 30 days via TTL index
// ─────────────────────────────────────────────────────────────────────────────

const mongoose = require('mongoose')

const securityLogSchema = new mongoose.Schema({
    // ── Event classification ───────────────────────────────────────────────
    type: {
        type: String,
        enum: [
            'waf_block',          // SQL injection, XSS, path traversal, etc.
            'rate_limit',         // Too many requests
            'behavior_anomaly',   // Suspicious behavior pattern
            'bot_detected',       // Automated traffic detected
            'cf_challenge',       // Cloudflare challenge triggered
            'ip_blocked',        // IP reputation block
            'auth_failure',       // Failed admin login, invalid token
            'payload_violation',  // Oversized / malformed payload
        ],
        required: true,
        index: true,
    },

    severity: {
        type: String,
        enum: ['low', 'medium', 'high', 'critical'],
        default: 'medium',
        index: true,
    },

    // ── Request context ────────────────────────────────────────────────────
    ip: { type: String, index: true },
    userAgent: String,
    method: String,
    path: String,
    origin: String,

    // ── User context (if authenticated) ────────────────────────────────────
    userId: { type: String, index: true, default: null },

    // ── Detection details ──────────────────────────────────────────────────
    rule: String,              // Which rule triggered (e.g. 'sqli_union', 'xss_script')
    pattern: String,           // The matched pattern/payload (truncated for safety)
    score: Number,             // Behavior score at time of event
    action: {                  // What action was taken
        type: String,
        enum: ['block', 'challenge', 'warn', 'log'],
        default: 'block',
    },

    // ── Cloudflare headers (if behind CF) ──────────────────────────────────
    cfRay: String,             // CF-Ray header
    cfCountry: String,         // CF-IPCountry
    cfThreatScore: Number,     // CF threat score (0-100)

    // ── Extra metadata ─────────────────────────────────────────────────────
    meta: { type: Object, default: {} },

}, {
    timestamps: true,          // createdAt, updatedAt
})

// ── TTL index: auto-delete logs after 30 days ──────────────────────────────
securityLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 })

// ── Compound index for dashboard queries ───────────────────────────────────
securityLogSchema.index({ type: 1, createdAt: -1 })
securityLogSchema.index({ ip: 1, createdAt: -1 })

module.exports = mongoose.model('SecurityLog', securityLogSchema)
