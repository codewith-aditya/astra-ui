// ═══════════════════════════════════════════════════════════════════════════
//  Environment configuration — validated once at boot.
//
//  Nothing in this codebase may fall back to a hardcoded secret. A missing
//  required secret must stop the process, not silently substitute a literal
//  that is committed to git and therefore public.
// ═══════════════════════════════════════════════════════════════════════════

require('dotenv').config()

const errors = []
const warnings = []

const NODE_ENV = process.env.NODE_ENV || 'development'
const isProd = NODE_ENV === 'production'

function required(name, { minLength = 0 } = {}) {
    const value = process.env[name]
    if (!value || !value.trim()) {
        errors.push(`${name} is required but not set`)
        return ''
    }
    if (minLength && value.length < minLength) {
        errors.push(`${name} must be at least ${minLength} characters (got ${value.length})`)
    }
    return value.trim()
}

function optional(name, fallback = '') {
    const value = process.env[name]
    return value && value.trim() ? value.trim() : fallback
}

function feature(name, vars) {
    const missing = vars.filter(v => !process.env[v] || !process.env[v].trim())
    if (missing.length) {
        warnings.push(`${name} disabled — missing ${missing.join(', ')}`)
        return false
    }
    return true
}

function int(name, fallback) {
    const raw = process.env[name]
    if (!raw) return fallback
    const n = parseInt(raw, 10)
    return Number.isFinite(n) ? n : fallback
}

function list(name, fallback = []) {
    const raw = process.env[name]
    if (!raw || !raw.trim()) return fallback
    return raw.split(',').map(s => s.trim()).filter(Boolean)
}

/**
 * Express's `trust proxy` accepts a hop count, a boolean, or a comma-separated
 * list of trusted addresses — but NOT an empty string, which it parses as an
 * address list and rejects with "invalid IP address:" at startup.
 *
 * Behind nginx (the deployed topology) exactly one hop is trusted, so req.ip
 * resolves to the real client rather than 127.0.0.1. Trusting every hop would
 * let a caller spoof X-Forwarded-For and defeat every IP-keyed rate limit.
 */
function trustProxy(name, { fallback }) {
    const raw = (process.env[name] || '').trim()
    if (!raw) return fallback

    if (raw === 'false' || raw === '0') return false
    if (raw === 'true') return 1

    const hops = parseInt(raw, 10)
    if (String(hops) === raw && hops >= 0) return hops

    // Otherwise treat it as an address/subnet list.
    const addresses = raw.split(',').map(s => s.trim()).filter(Boolean)
    if (addresses.length) return addresses

    return fallback
}

// ─── Core ────────────────────────────────────────────────────────────────────
const env = {
    NODE_ENV,
    isProd,
    isTest: NODE_ENV === 'test',
    PORT: int('PORT', 4000),

    MONGO_URI: required('MONGO_URI'),

    // Signing key for our own session tokens. 32 bytes minimum; there is no
    // default, because a default would be the key every deployment shares.
    JWT_SECRET: required('JWT_SECRET', { minLength: 32 }),
    JWT_ISSUER: optional('JWT_ISSUER', 'astragpt'),
    ACCESS_TOKEN_TTL: optional('ACCESS_TOKEN_TTL', '30m'),
    REFRESH_TOKEN_TTL_DAYS: int('REFRESH_TOKEN_TTL_DAYS', 30),

    ADMIN_SECRET: required('ADMIN_SECRET', { minLength: 16 }),

    ALLOWED_ORIGINS: list('ALLOWED_ORIGINS'),
    // Express parses a *string* value as a comma-separated IP/subnet list, so an
    // empty string is an invalid address and throws on the first request. Coerce
    // to a hop count (number) or `false` — the two forms Express always accepts.
    // Behind nginx (and optionally Cloudflare) the default of 1 hop is correct;
    // set TRUST_PROXY=2 when a second proxy is in front of nginx.
    TRUST_PROXY: trustProxy('TRUST_PROXY', isProd ? 1 : 0),
    BEHIND_CLOUDFLARE: optional('BEHIND_CLOUDFLARE') === '1',

    // ─── Upstream model providers ────────────────────────────────────────────
    AISUBSCRIPTION_API_URL: optional('AISUBSCRIPTION_API_URL', 'http://127.0.0.1:8080/v1/chat/completions'),
    AISUBSCRIPTION_API_KEY: optional('AISUBSCRIPTION_API_KEY'),
    NEXUSIFY_API_URL: optional('NEXUSIFY_API_URL', 'https://api.nexusify.co/v1/responses'),
    NEXUSIFY_API_KEY: optional('NEXUSIFY_API_KEY'),
    OPENAI_API_KEY: optional('OPENAI_API_KEY'),

    // ─── Optional integrations ───────────────────────────────────────────────
    SUPABASE_URL: optional('SUPABASE_URL'),
    SUPABASE_SERVICE_ROLE_KEY: optional('SUPABASE_SERVICE_ROLE_KEY'),
    SUPABASE_JWT_SECRET: optional('SUPABASE_JWT_SECRET'),

    UPSTASH_REDIS_REST_URL: optional('UPSTASH_REDIS_REST_URL'),
    UPSTASH_REDIS_REST_TOKEN: optional('UPSTASH_REDIS_REST_TOKEN'),

    SMTP_HOST: optional('SMTP_HOST', 'smtp.gmail.com'),
    SMTP_PORT: int('SMTP_PORT', 587),
    SMTP_USER: optional('SMTP_USER'),
    SMTP_PASS: optional('SMTP_PASS'),
    SMTP_FROM: optional('SMTP_FROM'),
    SMTP_REJECT_UNAUTHORIZED: optional('SMTP_REJECT_UNAUTHORIZED', 'true') !== 'false',

    DISCORD_CONTACT_WEBHOOK: optional('DISCORD_CONTACT_WEBHOOK'),
    TERMINAL_SERVERS: optional('TERMINAL_SERVERS'),

    // ─── Feature flags ───────────────────────────────────────────────────────
    ENABLE_TOOLS: optional('ENABLE_TOOLS') === '1',
    ENABLE_SANDBOX: optional('ENABLE_SANDBOX', '1') === '1',
    SANDBOX_IMG_PY: optional('SANDBOX_IMG_PY', 'python:3.12-slim'),
    SANDBOX_IMG_NODE: optional('SANDBOX_IMG_NODE', 'node:20-alpine'),
    SANDBOX_IMG_SH: optional('SANDBOX_IMG_SH', 'alpine:3.20'),
    SANDBOX_MAX_CONCURRENT: int('SANDBOX_MAX_CONCURRENT', 4),
    SANDBOX_WARM_IMAGES: optional('SANDBOX_WARM_IMAGES') === '1',

    // Absolute origin used to build public URLs for uploaded files. Empty means
    // emit a same-origin relative URL, which is correct for every current
    // deployment; the old code hardcoded a VPS IP that disagreed with nginx.
    PUBLIC_BASE_URL: optional('PUBLIC_BASE_URL'),

    // ─── Limits ──────────────────────────────────────────────────────────────
    MAX_UPLOAD_BYTES: int('MAX_UPLOAD_BYTES', 20 * 1024 * 1024),
    MAX_IMAGE_BYTES: int('MAX_IMAGE_BYTES', 10 * 1024 * 1024),
    JSON_BODY_LIMIT: optional('JSON_BODY_LIMIT', '20mb'),
    LOG_LEVEL: optional('LOG_LEVEL', isProd ? 'info' : 'debug'),

    // Must have a real default: server.js passes this straight to setTimeout,
    // and setTimeout(fn, undefined) fires on the next tick — which would force
    // an immediate exit and cut every in-flight request the drain exists to
    // protect.
    SHUTDOWN_TIMEOUT_MS: int('SHUTDOWN_TIMEOUT_MS', 15_000),
}

// ─── Derived feature availability ────────────────────────────────────────────
env.features = {
    email: feature('Email/OTP delivery', ['SMTP_USER', 'SMTP_PASS']),
    supabase: feature('Supabase identity verification', ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']),
    redis: feature('Redis rate limiting', ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']),
    aisubscription: feature('AISubscription provider', ['AISUBSCRIPTION_API_KEY']),
    nexusify: feature('Nexusify provider', ['NEXUSIFY_API_KEY']),
    openai: feature('OpenAI audio (STT/TTS)', ['OPENAI_API_KEY']),
}

// In production, CORS must be an explicit allow-list. Defaulting to localhost
// in production silently breaks the deployment instead of failing loudly.
if (isProd && env.ALLOWED_ORIGINS.length === 0) {
    errors.push('ALLOWED_ORIGINS is required in production (comma-separated list of exact origins)')
}
if (!isProd && env.ALLOWED_ORIGINS.length === 0) {
    env.ALLOWED_ORIGINS = ['http://localhost:5173', 'http://localhost:4173']
}

// A weak or well-known secret is equivalent to no secret at all.
const KNOWN_LEAKED = [
    'astragpt_vps_super_secret_jwt_key_2026',
    'changeme', 'secret', 'password',
]
if (env.JWT_SECRET && KNOWN_LEAKED.includes(env.JWT_SECRET)) {
    errors.push('JWT_SECRET is a known/committed value and must be rotated')
}

function report() {
    for (const w of warnings) {
        // eslint-disable-next-line no-console
        console.warn(`[env] ${w}`)
    }
    if (errors.length) {
        // eslint-disable-next-line no-console
        console.error('\n[env] Refusing to start — invalid configuration:')
        for (const e of errors) console.error(`  ✗ ${e}`)
        console.error('\nSee .env.example for the full list of variables.\n')
        throw new Error(`Invalid environment configuration (${errors.length} error(s))`)
    }
}

env.report = report
env.errors = errors
env.warnings = warnings

module.exports = env
