// ═══════════════════════════════════════════════════════════════════════════
//  TOTP (2FA) helper — correct otplib v13 usage.
//
//  otplib v13 is promise-based and returns a RESULT OBJECT, not a boolean:
//      declare function verify(options): Promise<VerifyResult>
//      VerifyResult = { valid: boolean, delta, epoch, timeStep }
//
//  Two independent mistakes in the previous implementation each made 2FA
//  accept ANY 6-digit code:
//    1. the promise was never awaited, so the check saw an always-truthy Promise
//    2. even awaited, the result is an object, and every object is truthy
//  The only correct test is `.valid` on the awaited result.
//
//  v13 also requires explicit plugins: `crypto` always, and `base32` whenever
//  the secret is a string (ours are, since they round-trip through MongoDB).
//
//  Every function here returns an explicit primitive or a documented shape.
//  Nothing returns a bare object that a caller might truthiness-test by
//  mistake — that is the trap this module exists to close.
// ═══════════════════════════════════════════════════════════════════════════

const crypto = require('crypto')
const {
    generateSecret,
    generateURI,
    verify,
    NobleCryptoPlugin,
    ScureBase32Plugin,
} = require('otplib')

const cryptoPlugin = new NobleCryptoPlugin()
const base32Plugin = new ScureBase32Plugin()

// Tolerate one adjacent time step of clock skew between the server and the
// user's authenticator (RFC 6238 transmission-delay allowance).
const EPOCH_TOLERANCE_SECONDS = 30

const TOTP_CODE_PATTERN = /^\d{6}$/
const RECOVERY_CODE_COUNT = 10

/** Generate a new base32 TOTP secret. */
function createSecret() {
    return generateSecret()
}

/**
 * Build the otpauth:// URI encoded into the enrolment QR code.
 *
 * NOTE: v13 names this field `label`, not `account`. The previous code passed
 * `account`, producing a URI reading "AstraGPT:undefined" — so every enrolled
 * authenticator showed no account name.
 */
function createEnrollmentUri({ secret, accountName }) {
    return generateURI({
        secret,
        label: accountName || 'account',
        issuer: 'AstraGPT',
        type: 'totp',
    })
}

/** True when `code` is structurally a 6-digit TOTP code. */
function isWellFormedCode(code) {
    return typeof code === 'string' && TOTP_CODE_PATTERN.test(code.trim())
}

/**
 * Low-level verification. Returns { valid, timeStep }.
 *
 * `timeStep` is the counter the code belongs to and is null when invalid; it
 * is used by the caller for replay protection. Never throws — a malformed
 * stored secret must read as "invalid", never as "valid".
 */
async function verifyCodeDetailed({ token, secret }) {
    if (!isWellFormedCode(token) || typeof secret !== 'string' || !secret) {
        return { valid: false, timeStep: null }
    }

    try {
        const result = await verify({
            token: token.trim(),
            secret,
            crypto: cryptoPlugin,
            base32: base32Plugin,
            epochTolerance: EPOCH_TOLERANCE_SECONDS,
        })
        if (result && result.valid === true) {
            return { valid: true, timeStep: result.timeStep ?? null }
        }
        return { valid: false, timeStep: null }
    } catch {
        return { valid: false, timeStep: null }
    }
}

/**
 * Verify a code against a raw secret. Returns a plain BOOLEAN.
 * Use during enrolment and disable, where there is no stored replay state yet.
 */
async function verifyTotpSecret(secret, code) {
    const { valid } = await verifyCodeDetailed({ token: code, secret })
    return valid === true
}

// ─── Recovery codes ─────────────────────────────────────────────────────────
// Stored only as SHA-256 hashes so a database leak cannot yield usable codes.
// Shown to the user exactly once, at generation time.

function hashRecoveryCode(code) {
    return crypto.createHash('sha256').update(code.trim().toUpperCase()).digest('hex')
}

/** Generate plaintext recovery codes plus the hashed records to persist. */
function generateRecoveryCodes(count = RECOVERY_CODE_COUNT) {
    const plaintext = []
    const records = []

    for (let i = 0; i < count; i++) {
        // Unambiguous alphabet: no I, L, O, U, 0, 1.
        const alphabet = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'
        let code = ''
        for (let j = 0; j < 10; j++) {
            code += alphabet[crypto.randomInt(0, alphabet.length)]
            if (j === 4) code += '-'
        }
        plaintext.push(code)
        records.push({ codeHash: hashRecoveryCode(code), usedAt: null })
    }

    return { plaintext, records }
}

/**
 * Consume a recovery code. Mutates `records` in place, marking the matched
 * entry used. Returns true when a previously unused code matched.
 */
function consumeRecoveryCode(records, candidate) {
    if (!Array.isArray(records) || typeof candidate !== 'string' || !candidate.trim()) return false

    const target = hashRecoveryCode(candidate)
    let matched = false

    for (const record of records) {
        if (record.usedAt) continue
        // Constant-time compare over equal-length hex digests.
        const a = Buffer.from(String(record.codeHash), 'utf8')
        const b = Buffer.from(target, 'utf8')
        if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
            record.usedAt = new Date()
            matched = true
            break
        }
    }

    return matched
}

/**
 * Verify a second factor for a user document, accepting either a TOTP code or
 * an unused recovery code.
 *
 * Returns a plain BOOLEAN. The method actually used is reported via the
 * optional `out` collector rather than the return value, so that a caller
 * writing `if (!await verifySecondFactor(...))` is always correct.
 *
 * Persists replay state, so `user` must be a real document (not `.lean()`)
 * selected with +mfaSecret +mfaRecoveryCodes +mfaLastTimeStep.
 */
async function verifySecondFactor(user, candidate, out = {}) {
    out.method = null
    if (!user || typeof candidate !== 'string' || !candidate.trim()) return false

    const input = candidate.trim()

    if (isWellFormedCode(input)) {
        const { valid, timeStep } = await verifyCodeDetailed({
            token: input,
            secret: user.mfaSecret,
        })
        if (!valid) return false

        // Reject reuse of an already-consumed time step (code replay).
        if (timeStep !== null && user.mfaLastTimeStep && timeStep <= user.mfaLastTimeStep) {
            return false
        }
        if (timeStep !== null) {
            user.mfaLastTimeStep = timeStep
            await user.save()
        }
        out.method = 'totp'
        return true
    }

    // Not 6 digits — try the recovery-code path.
    const records = user.mfaRecoveryCodes || []
    if (consumeRecoveryCode(records, input)) {
        user.mfaRecoveryCodes = records
        user.markModified('mfaRecoveryCodes')
        await user.save()
        out.method = 'recovery'
        return true
    }

    return false
}

module.exports = {
    createSecret,
    createEnrollmentUri,
    verifyCodeDetailed,
    verifyTotpSecret,
    verifySecondFactor,
    isWellFormedCode,
    generateRecoveryCodes,
    consumeRecoveryCode,
    hashRecoveryCode,

    // Aliases kept so callers can use the more descriptive names.
    generateTotpSecret: createSecret,
    buildTotpUri: createEnrollmentUri,
    // Boolean-returning second-factor check. Aliased deliberately to the
    // boolean function so `if (!await verifyTotp(...))` is never a truthy-object
    // test — that mistake is what made 2FA accept any code.
    verifyTotp: verifySecondFactor,
    RECOVERY_CODE_COUNT,
}
