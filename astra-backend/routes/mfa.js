// ═══════════════════════════════════════════════════════════════════════════
//  TOTP two-factor authentication.
//
//  This file previously registered every handler twice (two `module.exports`,
//  the second half calling an `authenticator` object that was never imported)
//  and called otplib's async `verify()` without awaiting it. Because a pending
//  Promise is truthy, `if (!isValid)` was never taken and ANY six-digit code
//  was accepted — including on /disable, which let an attacker strip a
//  victim's 2FA. All TOTP logic now lives in utils/totp.js, which awaits the
//  call and reads the `.valid` field off the result object.
//
//  Enrolment is two-phase: /setup stores a pending secret, and 2FA only
//  becomes active once /verify proves the user can generate a valid code.
//  That way a failed enrolment can never lock someone out of their account.
// ═══════════════════════════════════════════════════════════════════════════

const express = require('express')
const router = express.Router()
const QRCode = require('qrcode')

const User = require('../models/User')
const auth = require('../middleware/auth')
const { asyncHandler } = require('../utils/asyncHandler')
const logger = require('../utils/logger')
const v = require('../utils/validate')
const { mfaLimiter } = require('../middleware/rateLimit')
const { revokeAllSessions } = require('../utils/tokens')
const {
    generateTotpSecret,
    buildTotpUri,
    verifyTotpSecret,
    generateRecoveryCodes,
} = require('../utils/totp')
const { BadRequestError, ConflictError } = require('../utils/errors')

// ─── POST /setup — begin enrolment ───────────────────────────────────────────
// Stores a *pending* secret. 2FA stays disabled until /verify succeeds.
router.post('/setup', auth, mfaLimiter, asyncHandler(async (req, res) => {
    const user = await User.findOne({ userId: req.userId }).select('+mfaSecret +mfaPendingSecret')
    if (!user) throw new BadRequestError('User not found', 'user_not_found')

    if (user.mfaEnabled) {
        throw new ConflictError(
            'Two-factor authentication is already enabled. Disable it first to re-enrol.',
            'mfa_already_enabled',
        )
    }

    const secret = generateTotpSecret()

    // Held in mfaPendingSecret, never mfaSecret — an abandoned enrolment must
    // not leave a live secret that could later be treated as authoritative.
    user.mfaPendingSecret = secret
    user.mfaEnabled = false
    user.mfaVerified = false
    await user.save()

    const uri = buildTotpUri({ secret, accountName: user.email || user.userId })
    const qrCode = await QRCode.toDataURL(uri, {
        width: 240,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
    })

    logger.info('mfa.setup_started', { userId: user.userId })

    // The secret is returned once so the user can enter it manually if they
    // cannot scan the QR. It is not readable again after this response.
    res.json({ success: true, secret, qrCode, otpauthUrl: uri })
}))

// ─── POST /verify — activate 2FA ─────────────────────────────────────────────
router.post('/verify', auth, mfaLimiter, asyncHandler(async (req, res) => {
    const code = v.otp(req.body.code, 'code')

    const user = await User.findOne({ userId: req.userId }).select('+mfaPendingSecret')
    if (!user) throw new BadRequestError('User not found', 'user_not_found')
    if (!user.mfaPendingSecret) {
        throw new BadRequestError('Start 2FA setup before verifying', 'mfa_setup_not_started')
    }

    const ok = await verifyTotpSecret(user.mfaPendingSecret, code)
    if (!ok) {
        logger.warn('mfa.verify_failed', { userId: user.userId })
        throw new BadRequestError('Incorrect code — try again', 'mfa_invalid_code')
    }

    // Promote the pending secret and mint recovery codes. Plaintext is shown
    // exactly once here; only bcrypt hashes are stored.
    const { plaintext, records } = generateRecoveryCodes()
    user.mfaSecret = user.mfaPendingSecret
    user.mfaPendingSecret = ''
    user.mfaEnabled = true
    user.mfaVerified = true
    user.mfaRecoveryCodes = records
    await user.save()

    logger.info('mfa.enabled', { userId: user.userId })

    res.json({
        success: true,
        message: '2FA enabled successfully',
        recoveryCodes: plaintext,
        warning: 'Store these recovery codes now. They will not be shown again.',
    })
}))

// ─── POST /disable ───────────────────────────────────────────────────────────
// Requires BOTH a valid TOTP code and the account password. Previously a bare
// six digits sufficed, so the broken verify made 2FA removal trivial.
router.post('/disable', auth, mfaLimiter, asyncHandler(async (req, res) => {
    const code = v.otp(req.body.code, 'code')

    const user = await User.findOne({ userId: req.userId }).select('+mfaSecret +passwordHash')
    if (!user) throw new BadRequestError('User not found', 'user_not_found')
    if (!user.mfaEnabled || !user.mfaSecret) {
        throw new BadRequestError('2FA is not enabled', 'mfa_not_enabled')
    }

    // Only enforce the password factor for accounts that actually have one.
    if (user.passwordHash) {
        const bcrypt = require('bcryptjs')
        const password = v.str(req.body.password, 'password', { max: 200 })
        const passwordOk = await bcrypt.compare(password, user.passwordHash)
        if (!passwordOk) {
            logger.warn('mfa.disable_bad_password', { userId: user.userId })
            throw new BadRequestError('Incorrect password', 'invalid_credentials')
        }
    }

    const ok = await verifyTotpSecret(user.mfaSecret, code)
    if (!ok) {
        logger.warn('mfa.disable_bad_code', { userId: user.userId })
        throw new BadRequestError('Incorrect code — cannot disable 2FA', 'mfa_invalid_code')
    }

    user.mfaEnabled = false
    user.mfaVerified = false
    user.mfaSecret = ''
    user.mfaPendingSecret = ''
    user.mfaRecoveryCodes = []
    await user.save()

    logger.info('mfa.disabled', { userId: user.userId })
    res.json({ success: true, message: '2FA disabled' })
}))

// ─── POST /recovery-codes/regenerate ────────────────────────────────────────
router.post('/recovery-codes/regenerate', auth, mfaLimiter, asyncHandler(async (req, res) => {
    const code = v.otp(req.body.code, 'code')

    const user = await User.findOne({ userId: req.userId }).select('+mfaSecret')
    if (!user) throw new BadRequestError('User not found', 'user_not_found')
    if (!user.mfaEnabled || !user.mfaSecret) {
        throw new BadRequestError('2FA is not enabled', 'mfa_not_enabled')
    }

    const ok = await verifyTotpSecret(user.mfaSecret, code)
    if (!ok) throw new BadRequestError('Incorrect code', 'mfa_invalid_code')

    const { plaintext, records } = generateRecoveryCodes()
    user.mfaRecoveryCodes = records
    await user.save()

    // Regenerating implies the old set may be compromised, so force a
    // re-login everywhere.
    await revokeAllSessions(user)

    logger.info('mfa.recovery_regenerated', { userId: user.userId })
    res.json({
        success: true,
        recoveryCodes: plaintext,
        warning: 'Previous recovery codes are now invalid. All sessions were signed out.',
    })
}))

// ─── GET /status ─────────────────────────────────────────────────────────────
router.get('/status', auth, asyncHandler(async (req, res) => {
    const user = await User.findOne({ userId: req.userId })
        .select('mfaEnabled mfaVerified mfaRecoveryCodes')

    const remaining = (user?.mfaRecoveryCodes || []).filter(c => !c.usedAt).length

    res.json({
        mfaEnabled: user?.mfaEnabled || false,
        mfaVerified: user?.mfaVerified || false,
        recoveryCodesRemaining: remaining,
    })
}))

module.exports = router
