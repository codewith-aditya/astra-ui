// ─── Redis-based Rate Limiter (Upstash REST API) ──────────────────────────────
// Uses @upstash/redis — works via HTTP, no local Redis server needed.
// Get free Redis at https://upstash.com → create a database → copy REST URL + token.
//
// Set in .env:
//   UPSTASH_REDIS_REST_URL=https://xxxx.upstash.io
//   UPSTASH_REDIS_REST_TOKEN=your-token-here
// ─────────────────────────────────────────────────────────────────────────────

let redis = null

// Lazily initialize Redis so missing env vars don't crash the whole server
function getRedis() {
    if (redis) return redis
    const { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } = process.env
    if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) return null
    try {
        const { Redis } = require('@upstash/redis')
        redis = new Redis({
            url: UPSTASH_REDIS_REST_URL,
            token: UPSTASH_REDIS_REST_TOKEN,
        })
        console.log('✅ Upstash Redis connected — persistent rate limiting active')
        return redis
    } catch {
        console.warn('⚠️  @upstash/redis not installed — run: npm install @upstash/redis')
        return null
    }
}

// ─── Sliding window rate limiter using Redis sorted sets ─────────────────────
// Key: ratelimit:<userId>
// Members: timestamps (score = timestamp, value = timestamp)
// Window: 60 seconds, max count from plan limits
// ─────────────────────────────────────────────────────────────────────────────
async function checkRedisRateLimit(userId, maxPerMin) {
    const r = getRedis()

    // Fallback to in-memory if Redis not configured
    if (!r) return { allowed: true, usedRedis: false }

    const key = `ratelimit:${userId}`
    const now = Date.now()
    const windowStart = now - 60_000

    try {
        // Remove timestamps older than 60s
        await r.zremrangebyscore(key, '-inf', windowStart)

        // Count how many in current window
        const count = await r.zcard(key)

        if (count >= maxPerMin) {
            // Get the oldest timestamp to calculate retry-after
            const oldest = await r.zrange(key, 0, 0, { withScores: true })
            const oldestTs = oldest?.[0]?.score || now
            const retryAfter = Math.ceil((60_000 - (now - oldestTs)) / 1000)
            return { allowed: false, retryAfter, usedRedis: true }
        }

        // Add current timestamp and set TTL
        await r.zadd(key, { score: now, member: String(now) })
        await r.expire(key, 70)  // expire key a bit after window ends

        return { allowed: true, usedRedis: true }
    } catch (err) {
        console.error('[redisRateLimit] Redis error:', err.message)
        // Fail open — don't block user if Redis is down
        return { allowed: true, usedRedis: false }
    }
}

module.exports = { checkRedisRateLimit }
