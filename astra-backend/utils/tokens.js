// ─── JWT issuing / verification ──────────────────────────────────────────────
// Access tokens are short-lived and carry identity + plan.
// `tv` (token version) lets us invalidate every token a user holds by bumping
// User.tokenVersion — used by session revocation and password change.
// ─────────────────────────────────────────────────────────────────────────────
const jwt = require('jsonwebtoken')
const crypto = require('crypto')
const env = require('../config/env')

const ISSUER = 'astragpt'
const AUDIENCE = 'astragpt-api'

// Names must match config/env.js exactly: a typo here yields `undefined`, and
// jsonwebtoken rejects an undefined `expiresIn` at sign time rather than
// silently defaulting, so every login would fail.
const ACCESS_TTL = env.ACCESS_TOKEN_TTL
const REFRESH_TTL = `${env.REFRESH_TOKEN_TTL_DAYS}d`

function signAccessToken(user, { sessionId, mfa = false } = {}) {
    return jwt.sign(
        {
            sub: user.userId,
            email: user.email || '',
            plan: user.plan || 'free',
            tv: user.tokenVersion || 0,
            sid: sessionId || undefined,
            mfa,
            typ: 'access',
        },
        env.JWT_SECRET,
        { expiresIn: ACCESS_TTL, issuer: ISSUER, audience: AUDIENCE }
    )
}

function signRefreshToken(user, { sessionId } = {}) {
    return jwt.sign(
        {
            sub: user.userId,
            tv: user.tokenVersion || 0,
            sid: sessionId,
            typ: 'refresh',
            // Without a unique claim the payload is a pure function of (user,
            // session), and `iat` only has one-second resolution — so two tokens
            // minted for the same session inside the same second are byte
            // identical. Rotation then produces the same string it replaced, and
            // reuse detection (which compares digests) can never fire.
            jti: crypto.randomBytes(16).toString('hex'),
        },
        env.JWT_SECRET,
        { expiresIn: REFRESH_TTL, issuer: ISSUER, audience: AUDIENCE }
    )
}

// Short-lived token issued after password check, exchanged for a full token
// once the TOTP step succeeds. Cannot be used as an access token: typ differs.
function signMfaChallengeToken(user) {
    return jwt.sign(
        { sub: user.userId, tv: user.tokenVersion || 0, typ: 'mfa_challenge' },
        env.JWT_SECRET,
        { expiresIn: '10m', issuer: ISSUER, audience: AUDIENCE }
    )
}

function verifyToken(token, expectedTyp = 'access') {
    const payload = jwt.verify(token, env.JWT_SECRET, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ['HS256'],
    })
    if (expectedTyp && payload.typ !== expectedTyp) {
        const err = new Error('Wrong token type')
        err.name = 'JsonWebTokenError'
        throw err
    }
    return payload
}

function newSessionId() {
    return crypto.randomBytes(16).toString('hex')
}

// Refresh tokens are stored as SHA-256 digests. A database leak then yields no
// usable credential, and rotation can still detect reuse by comparing digests.
function hashToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex')
}

const MAX_SESSIONS_PER_USER = 10

function ttlToMs(ttl) {
    const m = /^(\d+)([smhd])$/.exec(String(ttl))
    if (!m) return 30 * 24 * 60 * 60 * 1000
    const n = Number(m[1])
    return n * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]]
}

function describeClient(req) {
    // Callers pass either a raw Express request or an already-extracted
    // { ip, userAgent } summary. Reading only req.headers meant the summary
    // shape yielded 'Unknown' for every field, so every session row recorded
    // Unknown/Unknown/Desktop and the "your devices" list was useless.
    const ua = String(
        req?.userAgent ?? req?.headers?.['user-agent'] ?? ''
    ).slice(0, 400)
    const lower = ua.toLowerCase()
    const os =
        lower.includes('windows') ? 'Windows' :
        lower.includes('mac os') || lower.includes('macintosh') ? 'macOS' :
        lower.includes('android') ? 'Android' :
        lower.includes('iphone') || lower.includes('ipad') ? 'iOS' :
        lower.includes('linux') ? 'Linux' : 'Unknown'
    const browser =
        lower.includes('edg/') ? 'Edge' :
        lower.includes('chrome/') && !lower.includes('edg/') ? 'Chrome' :
        lower.includes('firefox/') ? 'Firefox' :
        lower.includes('safari/') && !lower.includes('chrome/') ? 'Safari' : 'Unknown'
    const device = lower.includes('mobile') ? 'Mobile' : 'Desktop'
    return { os, browser, device, userAgent: ua, ip: req?.clientIp || req?.ip || '' }
}

/**
 * Create a session and return both tokens. The refresh token's digest is
 * persisted on the user document; the plaintext is returned to the caller once
 * and never stored.
 */
async function issueTokenPair(user, req, { mfa = false } = {}) {
    const sessionId = newSessionId()
    const refreshToken = signRefreshToken(user, { sessionId })
    const accessToken = signAccessToken(user, { sessionId, mfa })

    const client = describeClient(req)
    user.sessions = Array.isArray(user.sessions) ? user.sessions : []
    if (typeof user.pruneSessions === 'function') user.pruneSessions()

    user.sessions.push({
        sessionId,
        tokenHash: hashToken(refreshToken),
        expiresAt: new Date(Date.now() + ttlToMs(REFRESH_TTL)),
        // Recorded so a later rotation can reissue with the SAME second-factor
        // state. Rotation previously hardcoded mfa:true, which upgraded a
        // never-MFA-verified session into an MFA-satisfied one for free.
        mfaSatisfied: mfa === true,
        ...client,
    })

    // Cap concurrent sessions: drop the least recently used beyond the limit.
    if (user.sessions.length > MAX_SESSIONS_PER_USER) {
        user.sessions.sort((a, b) => new Date(b.lastActive) - new Date(a.lastActive))
        user.sessions = user.sessions.slice(0, MAX_SESSIONS_PER_USER)
    }

    await user.save()
    return { accessToken, refreshToken, sessionId, expiresIn: ACCESS_TTL }
}

/**
 * Exchange a refresh token for a new pair. The presented token must match the
 * stored digest for its session; a mismatch means the token was already
 * rotated (i.e. replayed), so every session is revoked as a precaution.
 */
async function rotateRefreshToken(presentedToken, req) {
    const payload = verifyToken(presentedToken, 'refresh')

    // Required lazily: models/User pulls mongoose, and utils/tokens is loaded by
    // config-time code that must not depend on the model layer.
    const User = require('../models/User')
    const user = await User.findOne({ userId: payload.sub }).select('+sessions')
    if (!user) return null
    if ((user.tokenVersion || 0) !== (payload.tv || 0)) return null
    if (user.banned) return null

    const idx = (user.sessions || []).findIndex(s => s.sessionId === payload.sid)
    if (idx === -1) return null

    const session = user.sessions[idx]
    if (session.tokenHash !== hashToken(presentedToken)) {
        // Replay of a superseded token: assume compromise, revoke everything.
        user.tokenVersion = (user.tokenVersion || 0) + 1
        user.sessions = []
        await user.save()
        return { reuseDetected: true }
    }
    if (new Date(session.expiresAt) <= new Date()) {
        user.sessions.splice(idx, 1)
        await user.save()
        return null
    }

    const refreshToken = signRefreshToken(user, { sessionId: session.sessionId })
    // Carry the session's recorded second-factor state forward. Hardcoding
    // mfa:true here let any refresh turn a non-MFA session into one that
    // satisfies requireMfa.
    const accessToken = signAccessToken(user, {
        sessionId: session.sessionId,
        mfa: session.mfaSatisfied === true,
    })

    session.tokenHash = hashToken(refreshToken)
    session.lastActive = new Date()
    session.expiresAt = new Date(Date.now() + ttlToMs(REFRESH_TTL))
    Object.assign(session, { ip: describeClient(req).ip })

    await user.save()
    return { user, accessToken, refreshToken, sessionId: session.sessionId, expiresIn: ACCESS_TTL }
}

/** Revoke one session (logout on this device). */
async function revokeSession(user, sessionId) {
    if (!Array.isArray(user.sessions)) return 0
    const before = user.sessions.length
    user.sessions = user.sessions.filter(s => s.sessionId !== sessionId)
    if (user.sessions.length !== before) await user.save()
    return before - user.sessions.length
}

/**
 * Revoke every session and invalidate all outstanding access tokens by bumping
 * tokenVersion. Used by password change, MFA changes and "sign out everywhere".
 */
async function revokeAllSessions(user, { keepSessionId = null } = {}) {
    user.tokenVersion = (user.tokenVersion || 0) + 1
    const kept = keepSessionId
        ? (user.sessions || []).filter(s => s.sessionId === keepSessionId)
        : []
    const removed = (user.sessions || []).length - kept.length
    user.sessions = kept
    await user.save()
    return removed
}

module.exports = {
    signAccessToken,
    signRefreshToken,
    signMfaChallengeToken,
    verifyToken,
    newSessionId,
    hashToken,
    describeClient,
    issueTokenPair,
    rotateRefreshToken,
    revokeSession,
    revokeAllSessions,
    ACCESS_TTL,
    REFRESH_TTL,
    MAX_SESSIONS_PER_USER,
}
