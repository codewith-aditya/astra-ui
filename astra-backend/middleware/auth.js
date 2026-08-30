// ─── Authentication middleware ────────────────────────────────────────────────
// Accepts a signed JWT (issued by /api/auth) or a Supabase access token.
// A bearer value is NEVER trusted as a bare user id: identity must be proven by
// a signature. Users are never auto-created here.
//
//   requireAuth  — 401 unless a valid token resolves to an existing, unbanned user
//   optionalAuth — attaches identity when present, never rejects
//   requireMfa   — 403 unless the token was minted after a TOTP step
// ─────────────────────────────────────────────────────────────────────────────
const User = require('../models/User')
const { verifyToken } = require('../utils/tokens')
const { verifySupabaseJWT } = require('./supabaseAuth')
const { UnauthorizedError, ForbiddenError } = require('../utils/errors')
const logger = require('../utils/logger')

function extractBearer(req) {
    const header = req.headers['authorization'] || ''
    if (!header.startsWith('Bearer ')) return null
    const token = header.slice(7).trim()
    return token || null
}

// Resolve a bearer token to a userId, or null. Tries our own JWT first (cheap,
// local) then falls back to Supabase (network call) for tokens we didn't mint.
async function resolveIdentity(token) {
    try {
        const payload = verifyToken(token, 'access')
        return {
            userId: payload.sub,
            tokenVersion: payload.tv || 0,
            sessionId: payload.sid || null,
            mfaSatisfied: payload.mfa === true,
            source: 'jwt',
        }
    } catch (err) {
        // Not one of ours (or expired/tampered) — try Supabase.
        if (err.name !== 'TokenExpiredError') {
            const supa = await verifySupabaseJWT(token)
            if (supa) {
                return {
                    userId: supa.userId,
                    tokenVersion: null,   // Supabase tokens aren't version-tracked
                    sessionId: null,
                    mfaSatisfied: false,
                    source: 'supabase',
                }
            }
        }
        return { error: err }
    }
}

async function authenticate(req, { required }) {
    const token = extractBearer(req)

    if (!token) {
        if (required) throw new UnauthorizedError('Missing Authorization header. Use: Authorization: Bearer <token>', 'missing_token')
        return null
    }

    const identity = await resolveIdentity(token)

    if (identity.error || !identity.userId) {
        if (!required) return null
        const expired = identity.error?.name === 'TokenExpiredError'
        throw new UnauthorizedError(
            expired ? 'Token expired' : 'Invalid or malformed token',
            expired ? 'token_expired' : 'invalid_token'
        )
    }

    const user = await User.findOne({ userId: identity.userId })

    if (!user) {
        // A validly-signed token for a deleted user, or a Supabase user who has
        // never been provisioned. Either way we do not create one here.
        if (!required) return null
        throw new UnauthorizedError('User account not found', 'unknown_user')
    }

    if (user.banned) {
        throw new ForbiddenError(user.banReason || 'This account has been suspended', 'account_banned')
    }

    // Reject tokens minted before the last credential change / session revoke.
    if (identity.source === 'jwt' && identity.tokenVersion !== (user.tokenVersion || 0)) {
        if (!required) return null
        throw new UnauthorizedError('Session has been revoked. Please sign in again.', 'token_revoked')
    }

    req.userId = user.userId
    req.user = user
    req.sessionId = identity.sessionId
    req.authSource = identity.source
    req.mfaSatisfied = identity.mfaSatisfied

    // Best-effort activity tracking — must never fail the request.
    User.updateOne({ userId: user.userId }, { $set: { lastActive: new Date() } })
        .catch(err => logger.debug('lastActive update failed', { err: err.message }))

    return user
}

const requireAuth = (req, _res, next) => {
    authenticate(req, { required: true }).then(() => next()).catch(next)
}

const optionalAuth = (req, _res, next) => {
    authenticate(req, { required: false }).then(() => next()).catch(() => next())
}

// Must run after requireAuth.
const requireMfa = (req, _res, next) => {
    if (!req.user) return next(new UnauthorizedError('Authentication required'))
    if (!req.user.mfaEnabled) return next()
    if (req.mfaSatisfied) return next()
    next(new ForbiddenError('Two-factor authentication required', 'mfa_required'))
}

module.exports = requireAuth
module.exports.requireAuth = requireAuth
module.exports.optionalAuth = optionalAuth
module.exports.requireMfa = requireMfa
module.exports.extractBearer = extractBearer
module.exports.resolveIdentity = resolveIdentity
