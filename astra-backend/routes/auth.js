// ═══════════════════════════════════════════════════════════════════════════
//  Authentication routes — OTP signup/login, password reset, profile.
//
//  Security model:
//    • Access tokens are short-lived signed JWTs (see utils/tokens.js).
//    • Refresh tokens are opaque random strings; only their SHA-256 hash is
//      stored, so a database leak cannot be replayed as a session.
//    • Every mutating endpoint derives the target user from req.user, never
//      from the request body.
//    • OTP codes come from crypto.randomInt and are stored as bcrypt hashes
//      with a hard attempt cap.
// ═══════════════════════════════════════════════════════════════════════════

const express = require('express')
const router = express.Router()
const bcrypt = require('bcryptjs')
const crypto = require('crypto')

const User = require('../models/User')
const Otp = require('../models/Otp')
const Chat = require('../models/Chat')

const auth = require('../middleware/auth')
const { asyncHandler } = require('../utils/asyncHandler')
const logger = require('../utils/logger')
const v = require('../utils/validate')
const { sendMail } = require('../utils/mailer')
const { otpEmail } = require('../utils/emailTemplates')
const {
    issueTokenPair, rotateRefreshToken, revokeSession, revokeAllSessions, verifyToken,
} = require('../utils/tokens')
const { verifyTotp } = require('../utils/totp')
const { authLimiter, otpLimiter, otpVerifyLimiter } = require('../middleware/rateLimit')
const {
    BadRequestError, UnauthorizedError, NotFoundError, ForbiddenError, TooManyRequestsError,
} = require('../utils/errors')

const OTP_TTL_SECONDS = 300
const MAX_OTP_ATTEMPTS = 5
const BCRYPT_ROUNDS = 12
const MIN_PASSWORD_LENGTH = 8

// A fixed-cost dummy hash. Compared against when no user exists so that the
// response time of a wrong email matches that of a wrong password, preventing
// account enumeration through timing.
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer-not-a-real-password', BCRYPT_ROUNDS)

// ─── Helpers ────────────────────────────────────────────────────────────────

function generateOtpCode() {
    // crypto.randomInt is CSPRNG-backed. Math.random is not and its internal
    // state is recoverable from observed outputs, which would make subsequent
    // codes predictable.
    return String(crypto.randomInt(100000, 1000000))
}

async function issueOtp(email, purpose) {
    const code = generateOtpCode()
    await Otp.deleteMany({ email, purpose })
    await Otp.create({
        email,
        codeHash: await bcrypt.hash(code, BCRYPT_ROUNDS),
        purpose,
        attempts: 0,
    })
    return code
}

/**
 * Consume an OTP. Deletes the record on success or once attempts are exhausted,
 * so a single code can never be brute-forced within its TTL.
 */
async function consumeOtp(email, purpose, submittedCode) {
    const record = await Otp.findOne({ email, purpose }).select('+codeHash')
    if (!record) throw new BadRequestError('Invalid or expired code.', 'invalid_otp')

    if (record.attempts >= MAX_OTP_ATTEMPTS) {
        await Otp.deleteOne({ _id: record._id })
        throw new TooManyRequestsError('Too many incorrect attempts. Request a new code.', 'otp_attempts_exceeded')
    }

    const ok = await bcrypt.compare(submittedCode, record.codeHash)
    if (!ok) {
        record.attempts += 1
        const remaining = MAX_OTP_ATTEMPTS - record.attempts
        if (remaining <= 0) {
            await Otp.deleteOne({ _id: record._id })
            throw new TooManyRequestsError('Too many incorrect attempts. Request a new code.', 'otp_attempts_exceeded')
        }
        await record.save()
        throw new BadRequestError('Invalid or expired code.', 'invalid_otp')
    }

    await Otp.deleteOne({ _id: record._id })
    return true
}

function publicUser(user) {
    return {
        uid: user.userId,
        userId: user.userId,
        email: user.email,
        name: user.name || (user.email ? user.email.split('@')[0] : ''),
        avatarUrl: user.avatarUrl || '',
        plan: user.getActivePlan ? user.getActivePlan() : user.plan,
        mfaEnabled: !!user.mfaEnabled,
    }
}

function clientMeta(req) {
    return {
        ip: req.realIp || req.ip,
        userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
    }
}

// A deliberately generic reply used wherever a specific answer would reveal
// whether an email is registered.
const GENERIC_OTP_REPLY = {
    success: true,
    message: 'If that email can receive a code, one has been sent.',
}

// ─── 1. Send OTP (signup) ───────────────────────────────────────────────────
router.post('/send-otp', otpLimiter, asyncHandler(async (req, res) => {
    const email = v.email(req.body.email, 'email')
    const purpose = v.oneOf(req.body.purpose ?? 'signup', ['signup', 'login', 'reset'], 'purpose')

    const existing = await User.findOne({ email }).select('_id')

    // Only dispatch a signup code when the address is actually free, but always
    // return the same body so registration status is not leaked.
    if (purpose === 'signup' && existing) {
        logger.info('otp.send.skipped_existing', { purpose })
        return res.json(GENERIC_OTP_REPLY)
    }
    if (purpose !== 'signup' && !existing) {
        logger.info('otp.send.skipped_unknown', { purpose })
        return res.json(GENERIC_OTP_REPLY)
    }

    const code = await issueOtp(email, purpose)
    const mail = otpEmail({ otp: code, purpose })
    await sendMail({ to: email, subject: mail.subject, html: mail.html })

    logger.info('otp.sent', { purpose })
    res.json(GENERIC_OTP_REPLY)
}))

// ─── 2. Login request — verify password, then dispatch OTP ──────────────────
router.post('/login-request', authLimiter, asyncHandler(async (req, res) => {
    const email = v.email(req.body.email, 'email')
    const password = v.str(req.body.password, 'password', { max: 200, allowEmpty: true })

    const user = await User.findOne({ email }).select('+passwordHash')

    // Always run one bcrypt comparison so timing does not distinguish an
    // unknown email from a wrong password.
    const hash = user?.passwordHash || DUMMY_HASH
    const passwordMatches = await bcrypt.compare(password || '', hash)

    // A password is mandatory whenever the account has one. Previously the
    // check was skipped when passwordHash was empty, which let any caller
    // trigger a login code for a password-less account.
    if (!user || !user.passwordHash || !passwordMatches) {
        logger.warn('auth.login_request.failed', { reason: !user ? 'unknown_email' : 'bad_password' })
        throw new UnauthorizedError('Incorrect email or password.', 'invalid_credentials')
    }
    if (user.banned) throw new ForbiddenError('This account has been suspended.', 'account_banned')

    const code = await issueOtp(email, 'login')
    const mail = otpEmail({ otp: code, purpose: 'login' })
    await sendMail({ to: email, subject: mail.subject, html: mail.html })

    logger.info('auth.login_request.ok', { userId: user.userId })
    res.json({ success: true, requireOtp: true, message: 'Verification code sent.' })
}))

// ─── 3. Verify OTP → create/sign in ────────────────────────────────────────
router.post('/verify-otp', otpVerifyLimiter, asyncHandler(async (req, res) => {
    const email = v.email(req.body.email, 'email')
    const code = v.otp(req.body.otp, 'otp')
    const purpose = v.oneOf(req.body.purpose ?? 'signup', ['signup', 'login'], 'purpose')
    const name = v.str(req.body.name, 'name', { max: 100, allowEmpty: true })
    const password = v.str(req.body.password, 'password', { max: 200, allowEmpty: true })

    await consumeOtp(email, purpose, code)

    let user = await User.findOne({ email }).select('+passwordHash')

    if (purpose === 'signup') {
        if (user) throw new BadRequestError('An account already exists for this email.', 'already_registered')
        if (password) v.password(password, 'password', { min: MIN_PASSWORD_LENGTH })

        user = new User({
            userId: 'usr_' + crypto.randomBytes(12).toString('hex'),
            email,
            name: name || email.split('@')[0],
            plan: 'free',
        })
        if (password) user.passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS)
        await user.save()
        logger.info('auth.signup', { userId: user.userId })
    } else {
        if (!user) throw new UnauthorizedError('Invalid or expired code.', 'invalid_otp')
        if (user.banned) throw new ForbiddenError('This account has been suspended.', 'account_banned')
    }

    // MFA gate. Previously tokens were issued regardless of mfaEnabled, which
    // made two-factor authentication purely decorative.
    if (user.mfaEnabled) {
        const mfaCode = v.str(req.body.mfaCode, 'mfaCode', { max: 20, allowEmpty: true })
        if (!mfaCode) {
            return res.status(401).json({
                success: false,
                requireMfa: true,
                message: 'Enter the code from your authenticator app.',
                error: { code: 'mfa_required' },
            })
        }
        const okMfa = await verifyTotp(user, mfaCode)
        if (!okMfa) {
            logger.warn('auth.mfa.failed', { userId: user.userId })
            throw new UnauthorizedError('Incorrect authentication code.', 'invalid_mfa_code')
        }
    }

    const tokens = await issueTokenPair(user, clientMeta(req))
    res.json({ success: true, ...tokens, user: publicUser(user) })
}))

// ─── 4. Forgot password ─────────────────────────────────────────────────────
router.post('/forgot-password', otpLimiter, asyncHandler(async (req, res) => {
    const email = v.email(req.body.email, 'email')
    const user = await User.findOne({ email }).select('_id')

    if (user) {
        const code = await issueOtp(email, 'reset')
        const mail = otpEmail({ otp: code, purpose: 'reset' })
        await sendMail({ to: email, subject: mail.subject, html: mail.html })
    }

    // Identical response either way — no enumeration.
    res.json(GENERIC_OTP_REPLY)
}))

// ─── 5. Reset password with OTP ─────────────────────────────────────────────
router.post('/reset-password', otpVerifyLimiter, asyncHandler(async (req, res) => {
    const email = v.email(req.body.email, 'email')
    const code = v.otp(req.body.otp, 'otp')
    const newPassword = v.password(req.body.newPassword, 'newPassword', { min: MIN_PASSWORD_LENGTH })

    await consumeOtp(email, 'reset', code)

    const user = await User.findOne({ email })
    if (!user) throw new BadRequestError('Invalid or expired code.', 'invalid_otp')
    if (user.banned) throw new ForbiddenError('This account has been suspended.', 'account_banned')

    user.passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS)
    // Invalidate every outstanding session: a password reset must log out any
    // attacker who already had a token.
    user.tokenVersion = (user.tokenVersion || 0) + 1
    user.sessions = []
    await user.save()

    logger.info('auth.password_reset', { userId: user.userId })

    const tokens = await issueTokenPair(user, clientMeta(req))
    res.json({ success: true, message: 'Password reset successfully.', ...tokens, user: publicUser(user) })
}))

// ─── 6. Refresh access token ────────────────────────────────────────────────
router.post('/refresh', authLimiter, asyncHandler(async (req, res) => {
    const refreshToken = v.str(req.body.refreshToken, 'refreshToken', { max: 500 })

    let result
    try {
        result = await rotateRefreshToken(refreshToken, clientMeta(req))
    } catch {
        // Malformed / expired / wrong-type token: same answer as a rejected one,
        // so a caller cannot distinguish the failure modes.
        throw new UnauthorizedError('Invalid or expired refresh token.', 'invalid_refresh_token')
    }

    // A null result meant the spread below produced `{ success: true }` with no
    // tokens — the client saw success and then had nothing to authenticate with.
    if (!result) {
        throw new UnauthorizedError('Invalid or expired refresh token.', 'invalid_refresh_token')
    }
    if (result.reuseDetected) {
        logger.warn('auth.refresh.reuse_detected')
        throw new UnauthorizedError(
            'This session was ended for security reasons. Please sign in again.',
            'refresh_token_reused',
        )
    }

    const { user, ...tokens } = result
    res.json({ success: true, ...tokens, user: publicUser(user) })
}))

// ─── 7. Logout ──────────────────────────────────────────────────────────────
router.post('/logout', auth, asyncHandler(async (req, res) => {
    const refreshToken = v.str(req.body.refreshToken, 'refreshToken', { max: 500, allowEmpty: true })

    // revokeSession matches on sessionId, so the session id has to be derived
    // rather than passing the token straight through: filtering sessions by a
    // JWT string never matches anything, and logout silently removed nothing.
    let sessionId = req.sessionId || null
    if (refreshToken) {
        try {
            sessionId = verifyToken(refreshToken, 'refresh').sid || sessionId
        } catch {
            // An expired or malformed token still means "end this session":
            // fall back to the session id carried by the access token.
        }
    }

    if (sessionId) await revokeSession(req.user, sessionId)
    else await revokeAllSessions(req.user)

    res.json({ success: true, message: 'Signed out.' })
}))

// ─── 8. Current account ─────────────────────────────────────────────────────
// Was GET /account/:userId with no auth, returning email, plan, MFA state and
// the full session list for any user id. Now strictly self-scoped.
async function accountHandler(req, res) {
    const user = req.user
    const chatCount = await Chat.countDocuments({ userId: user.userId })

    res.json({
        success: true,
        user: {
            ...publicUser(user),
            planExpiresAt: user.planExpiresAt,
            createdAt: user.createdAt,
            chatCount,
            dailyUsage: user.getDailyUsage(),
            mfaEnabled: !!user.mfaEnabled,
            sessions: (user.sessions || []).map(s => ({
                sessionId: s.sessionId,
                device: s.device,
                browser: s.browser,
                os: s.os,
                ip: s.ip,
                lastActive: s.lastActive,
                current: s.sessionId === req.sessionId,
            })),
        },
    })
}

router.get('/account', auth, asyncHandler(accountHandler))

// Compatibility alias. The frontend calls /auth/account/<uid>, so the path is
// kept, but the id in the URL is no longer trusted: it must match the verified
// token subject or the request is refused. Previously this route had no auth at
// all and returned another user's email, plan, MFA state and session list.
router.get('/account/:userId', auth, asyncHandler(async (req, res, next) => {
    const requested = v.id(req.params.userId, 'userId')
    if (requested !== req.user.userId) {
        throw new ForbiddenError('You may only read your own account', 'not_account_owner')
    }
    return accountHandler(req, res, next)
}))

// ─── 9. Update profile ──────────────────────────────────────────────────────
router.post('/update-profile', auth, asyncHandler(async (req, res) => {
    const user = req.user

    if (req.body.name !== undefined) {
        user.name = v.str(req.body.name, 'name', { max: 100, allowEmpty: true })
    }
    if (req.body.avatarUrl !== undefined) {
        user.avatarUrl = v.httpUrl(req.body.avatarUrl, 'avatarUrl', { allowEmpty: true, max: 2000 })
    }

    await user.save()
    res.json({ success: true, message: 'Profile updated.', user: publicUser(user) })
}))

// ─── 10. Change password ────────────────────────────────────────────────────
// The original handler had no auth, took the target from the body, and only
// checked currentPassword when the caller happened to supply it — omitting the
// field skipped verification entirely and overwrote the password.
router.post('/change-password', auth, authLimiter, asyncHandler(async (req, res) => {
    const newPassword = v.password(req.body.newPassword, 'newPassword', { min: MIN_PASSWORD_LENGTH })

    const user = await User.findOne({ userId: req.user.userId }).select('+passwordHash')
    if (!user) throw new NotFoundError('User not found.', 'user_not_found')

    // Mandatory whenever a password is already set — never conditional on the
    // client having sent it.
    if (user.passwordHash) {
        const currentPassword = v.str(req.body.currentPassword, 'currentPassword', { max: 200 })
        const ok = await bcrypt.compare(currentPassword, user.passwordHash)
        if (!ok) {
            logger.warn('auth.change_password.bad_current', { userId: user.userId })
            // 400, not 401: the session is valid, the submitted field is wrong.
            // A 401 here reads as "your session expired" and pushes clients to
            // sign the user out mid-flow.
            throw new BadRequestError('Current password is incorrect.', 'invalid_password')
        }
    }

    if (await bcrypt.compare(newPassword, user.passwordHash || DUMMY_HASH)) {
        throw new BadRequestError('New password must differ from the current one.', 'password_reused')
    }

    user.passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS)
    user.tokenVersion = (user.tokenVersion || 0) + 1
    user.sessions = []
    await user.save()

    logger.info('auth.password_changed', { userId: user.userId })
    const tokens = await issueTokenPair(user, clientMeta(req))
    res.json({ success: true, message: 'Password changed. Other sessions signed out.', ...tokens })
}))

// ─── 11. Revoke sessions ────────────────────────────────────────────────────
router.post('/revoke-sessions', auth, asyncHandler(async (req, res) => {
    const user = req.user
    const keepCurrent = v.bool(req.body.keepCurrent ?? true, 'keepCurrent')

    if (keepCurrent && req.sessionId) {
        user.sessions = (user.sessions || []).filter(s => s.sessionId === req.sessionId)
    } else {
        user.sessions = []
        user.tokenVersion = (user.tokenVersion || 0) + 1
    }
    await user.save()

    logger.info('auth.sessions_revoked', { userId: user.userId, keepCurrent })
    res.json({ success: true, message: 'Sessions revoked.' })
}))

module.exports = router
