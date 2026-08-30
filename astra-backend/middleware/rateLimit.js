// ─── Rate limiting ────────────────────────────────────────────────────────────
// Sliding-window limiter with a Redis backend and an in-memory fallback.
//
// Two deliberate design points, both reversing prior behaviour:
//
//   1. FAIL CLOSED. If the Redis backend errors, we do not wave the request
//      through. An attacker who can degrade Redis must not thereby disable
//      every limit in the system. Callers that genuinely prefer availability
//      over enforcement can opt in per-limiter with `failOpen: true`.
//
//   2. The in-memory fallback is per-process, so it is correct only for a
//      single instance. `describeBackend()` reports which backend is live so
//      startup can warn when running clustered without Redis.
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto')
const { RateLimitError } = require('../utils/errors')
const logger = require('../utils/logger')

let redis = null
let redisChecked = false

function getRedis() {
    if (redisChecked) return redis
    redisChecked = true
    const { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } = process.env
    if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
        logger.warn('Rate limiting: Redis not configured, using in-memory store (single-process only)')
        return null
    }
    try {
        const { Redis } = require('@upstash/redis')
        redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN })
        logger.info('Rate limiting: Upstash Redis backend active')
        return redis
    } catch (err) {
        logger.error('Rate limiting: @upstash/redis configured but not installed', { error: err.message })
        return null
    }
}

function describeBackend() {
    return getRedis() ? 'redis' : 'memory'
}

// ─── In-memory sliding window ────────────────────────────────────────────────
const memStore = new Map()

const sweeper = setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of memStore) {
        const recent = entry.hits.filter(t => now - t < entry.windowMs)
        if (recent.length === 0) memStore.delete(key)
        else entry.hits = recent
    }
}, 60_000)
// Do not hold the event loop open on shutdown.
sweeper.unref()

function memCheck(key, limit, windowMs) {
    const now = Date.now()
    const entry = memStore.get(key) || { hits: [], windowMs }
    entry.windowMs = windowMs
    entry.hits = entry.hits.filter(t => now - t < windowMs)

    if (entry.hits.length >= limit) {
        const oldest = Math.min(...entry.hits)
        const retryAfter = Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000))
        memStore.set(key, entry)
        return { allowed: false, retryAfter, remaining: 0 }
    }

    entry.hits.push(now)
    memStore.set(key, entry)
    return { allowed: true, retryAfter: 0, remaining: limit - entry.hits.length }
}

async function redisCheck(client, key, limit, windowMs) {
    const now = Date.now()
    const windowStart = now - windowMs

    await client.zremrangebyscore(key, '-inf', windowStart)
    const count = await client.zcard(key)

    if (count >= limit) {
        const oldest = await client.zrange(key, 0, 0, { withScores: true })
        const oldestTs = oldest?.[0]?.score ?? now
        const retryAfter = Math.max(1, Math.ceil((windowMs - (now - oldestTs)) / 1000))
        return { allowed: false, retryAfter, remaining: 0 }
    }

    // Unique member so concurrent requests in the same millisecond both count.
    const member = `${now}-${crypto.randomBytes(4).toString('hex')}`
    await client.zadd(key, { score: now, member })
    await client.expire(key, Math.ceil(windowMs / 1000) + 10)

    return { allowed: true, retryAfter: 0, remaining: limit - count - 1 }
}

/**
 * Consume one unit from a named bucket.
 * @returns {Promise<{allowed:boolean, retryAfter:number, remaining:number}>}
 */
async function consume(bucket, identifier, limit, windowMs, { failOpen = false } = {}) {
    const key = `rl:${bucket}:${identifier}`
    const client = getRedis()

    if (!client) return memCheck(key, limit, windowMs)

    try {
        return await redisCheck(client, key, limit, windowMs)
    } catch (err) {
        logger.error('Rate limit backend error', { bucket, error: err.message })
        if (failOpen) return { allowed: true, retryAfter: 0, remaining: 0, degraded: true }
        // Fail closed, but fall back to the in-memory window rather than
        // rejecting outright — still enforced, just not shared across processes.
        return memCheck(key, limit, windowMs)
    }
}

// ─── Identifier strategies ───────────────────────────────────────────────────

function ipKey(req) {
    return req.realIp || req.ip || req.socket?.remoteAddress || 'unknown'
}

function userKey(req) {
    return req.userId || ipKey(req)
}

/**
 * Hash an identifier that may contain PII (e.g. an email address) so it does
 * not land in Redis or logs in the clear.
 */
function hashed(value) {
    return crypto.createHash('sha256').update(String(value).toLowerCase()).digest('hex').slice(0, 32)
}

/**
 * Build an Express middleware enforcing a sliding-window limit.
 *
 * @param {object}   opts
 * @param {string}   opts.bucket   Namespace for the limit.
 * @param {number}   opts.limit    Max requests per window.
 * @param {number}   opts.windowMs Window length in milliseconds.
 * @param {Function} [opts.key]    (req) => identifier. Defaults to client IP.
 * @param {string}   [opts.message]
 * @param {boolean}  [opts.failOpen]
 */
function rateLimit({ bucket, limit, windowMs, key = ipKey, message, failOpen = false }) {
    if (!bucket) throw new Error('rateLimit requires a bucket name')

    return async function rateLimitMiddleware(req, res, next) {
        // Test-only escape hatch so a suite exercising unrelated routes is not
        // throttled. Read per-request rather than captured at module load so a
        // test can toggle it to assert that limiting itself still works.
        if (process.env.RATE_LIMIT_DISABLED === '1') return next()

        let identifier
        try {
            identifier = key(req)
        } catch {
            identifier = ipKey(req)
        }

        const result = await consume(bucket, identifier, limit, windowMs, { failOpen })

        res.setHeader('X-RateLimit-Limit', String(limit))
        res.setHeader('X-RateLimit-Remaining', String(Math.max(0, result.remaining ?? 0)))

        if (!result.allowed) {
            res.setHeader('Retry-After', String(result.retryAfter))
            return next(new RateLimitError(
                message || `Too many requests. Try again in ${result.retryAfter}s.`,
                result.retryAfter,
            ))
        }

        next()
    }
}

// ─── Preset limiters ─────────────────────────────────────────────────────────
// Tight limits on anything that sends mail, mutates credentials, spends money
// upstream, or performs heavy server-side work.

const limiters = {
    // Email-sending endpoints: strict, keyed on the target address so one
    // attacker cannot mail-bomb a victim from many IPs.
    otpSend: rateLimit({
        bucket: 'otp:send',
        limit: 3,
        windowMs: 15 * 60_000,
        key: req => hashed(req.body?.email || ipKey(req)),
        message: 'Too many verification codes requested. Please wait 15 minutes.',
    }),

    // Also cap per-IP so one host cannot enumerate many addresses.
    otpSendPerIp: rateLimit({
        bucket: 'otp:send:ip',
        limit: 10,
        windowMs: 15 * 60_000,
        message: 'Too many verification requests from this address.',
    }),

    // Code submission: the primary brute-force defence alongside the
    // per-record attempt counter.
    otpVerify: rateLimit({
        bucket: 'otp:verify',
        limit: 10,
        windowMs: 15 * 60_000,
        key: req => hashed(req.body?.email || ipKey(req)),
        message: 'Too many verification attempts. Please request a new code.',
    }),

    otpVerifyPerIp: rateLimit({
        bucket: 'otp:verify:ip',
        limit: 30,
        windowMs: 15 * 60_000,
    }),

    // Password mutation.
    passwordChange: rateLimit({
        bucket: 'auth:password',
        limit: 5,
        windowMs: 60 * 60_000,
        key: userKey,
        message: 'Too many password change attempts. Please wait an hour.',
    }),

    // MFA code submission — a 6-digit space needs a hard cap.
    mfaVerify: rateLimit({
        bucket: 'mfa:verify',
        limit: 10,
        windowMs: 15 * 60_000,
        key: userKey,
        message: 'Too many 2FA attempts. Please wait 15 minutes.',
    }),

    // Paid upstream inference.
    inference: rateLimit({
        bucket: 'inference',
        limit: 60,
        windowMs: 60_000,
        key: userKey,
    }),

    // Heavy server-side work: parsing, document generation, transcription.
    heavy: rateLimit({
        bucket: 'heavy',
        limit: 20,
        windowMs: 60_000,
        key: userKey,
        message: 'Too many resource-intensive requests. Please slow down.',
    }),

    // Container spawns.
    sandbox: rateLimit({
        bucket: 'sandbox',
        limit: 10,
        windowMs: 60_000,
        key: userKey,
        message: 'Too many code executions. Please wait a moment.',
    }),

    // Outbound fetches on behalf of a user (SSRF-adjacent surface).
    outbound: rateLimit({
        bucket: 'outbound',
        limit: 30,
        windowMs: 60_000,
        key: userKey,
    }),

    // Unauthenticated public forms.
    publicForm: rateLimit({
        bucket: 'public:form',
        limit: 5,
        windowMs: 60 * 60_000,
        message: 'Too many submissions. Please try again later.',
    }),

    // Coupon redemption — prevents brute-forcing codes.
    coupon: rateLimit({
        bucket: 'coupon',
        limit: 10,
        windowMs: 60 * 60_000,
        key: userKey,
        message: 'Too many coupon attempts. Please wait an hour.',
    }),

    // Admin surface: generous, but not unbounded.
    admin: rateLimit({
        bucket: 'admin',
        limit: 100,
        windowMs: 60_000,
    }),

    // Broad backstop applied to the whole API.
    global: rateLimit({
        bucket: 'global',
        limit: 300,
        windowMs: 60_000,
        // Availability matters more than precision for the outermost limit.
        failOpen: true,
    }),

    // Writes that create persistent records.
    write: rateLimit({
        bucket: 'write',
        limit: 120,
        windowMs: 60_000,
        key: userKey,
    }),
}

// ─── Named aliases ───────────────────────────────────────────────────────────
// Convenience names used at route call sites. Each is a plain middleware, so
// `router.post(path, otpLimiter, handler)` works directly.

module.exports = {
    rateLimit,
    consume,
    limiters,
    describeBackend,
    hashed,
    ipKey,
    userKey,

    // Credential + email surfaces
    authLimiter: limiters.passwordChange,
    otpLimiter: limiters.otpSend,
    otpVerifyLimiter: limiters.otpVerify,
    mfaLimiter: limiters.mfaVerify,

    // Workload surfaces
    inferenceLimiter: limiters.inference,
    heavyLimiter: limiters.heavy,
    sandboxLimiter: limiters.sandbox,
    outboundLimiter: limiters.outbound,
    publicFormLimiter: limiters.publicForm,
    couponLimiter: limiters.coupon,
    adminLimiter: limiters.admin,
    globalLimiter: limiters.global,
    writeLimiter: limiters.write,
}
