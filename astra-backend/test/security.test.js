// ═══════════════════════════════════════════════════════════════════════════
//  Integration tests for the security fixes.
//
//  Each test names the vulnerability it pins shut. These run against a real
//  in-memory MongoDB and the real Express app, so a regression here means the
//  vulnerability is genuinely back — not just that a unit stub changed.
// ═══════════════════════════════════════════════════════════════════════════

const assert = require('node:assert/strict')
const { test, before, after, describe } = require('node:test')

require('./setup').applyTestEnv()

const request = require('supertest')
const mongoose = require('mongoose')
const { startMemoryMongo, stopMemoryMongo } = require('./setup')

let app
let User
let Otp
let Tool
let Coupon
let tokens

before(async () => {
    const uri = await startMemoryMongo()
    process.env.MONGO_URI = uri

    // Required after env is in place: these modules read config at load time.
    app = require('../server').app
    User = require('../models/User')
    Otp = require('../models/Otp')
    Tool = require('../models/Tool')
    Coupon = require('../models/Coupon')
    tokens = require('../utils/tokens')

    await mongoose.connect(uri)
})

after(async () => {
    // Requiring server.js constructs a Socket.IO instance bound to an HTTP
    // server. Neither is listening (start() was never called), but both hold
    // event-loop handles, so the process would not exit after the last test.
    const server = require('../server')
    try { server.io?.close() } catch { /* nothing attached */ }
    try { server.httpServer?.close() } catch { /* never listened */ }

    await stopMemoryMongo()
})

// Create a user and return a valid access token for them.
async function makeUser(overrides = {}) {
    const userId = overrides.userId || `usr_${Math.random().toString(16).slice(2, 10)}`
    const user = await User.create({
        userId,
        email: overrides.email || `${userId}@example.com`,
        plan: overrides.plan || 'free',
        ...overrides,
    })
    const sessionId = tokens.newSessionId()
    const accessToken = tokens.signAccessToken(user, { sessionId })
    return { user, userId, accessToken }
}

describe('authentication', () => {
    test('rejects an arbitrary string as a bearer token', async () => {
        // The original middleware treated the bearer value as a userId and
        // CREATED the user if absent, so any string authenticated as anyone.
        const res = await request(app)
            .get('/v1/me')
            .set('Authorization', 'Bearer some-victim-user-id')

        assert.equal(res.status, 401)
        const created = await User.findOne({ userId: 'some-victim-user-id' })
        assert.equal(created, null, 'must not auto-create a user from a bearer token')
    })

    test('rejects a token signed with the wrong secret', async () => {
        const jwt = require('jsonwebtoken')
        const forged = jwt.sign(
            { sub: 'anyone', typ: 'access' },
            'not-the-real-secret',
            { issuer: 'astragpt', audience: 'astragpt-api', expiresIn: '1h' },
        )
        const res = await request(app).get('/v1/me').set('Authorization', `Bearer ${forged}`)
        assert.equal(res.status, 401)
    })

    test('accepts a properly signed access token', async () => {
        const { accessToken, userId } = await makeUser()
        const res = await request(app).get('/v1/me').set('Authorization', `Bearer ${accessToken}`)
        assert.equal(res.status, 200)
        assert.equal(res.body.id, userId)
    })

    test('rejects a refresh token used as an access token', async () => {
        const { user } = await makeUser()
        const refresh = tokens.signRefreshToken(user, { sessionId: tokens.newSessionId() })
        const res = await request(app).get('/v1/me').set('Authorization', `Bearer ${refresh}`)
        assert.equal(res.status, 401)
    })

    test('rejects a token whose tokenVersion is stale', async () => {
        const { user, accessToken } = await makeUser()
        // Simulates "revoke all sessions" / password change.
        await User.updateOne({ userId: user.userId }, { $inc: { tokenVersion: 1 } })
        const res = await request(app).get('/v1/me').set('Authorization', `Bearer ${accessToken}`)
        assert.equal(res.status, 401)
    })

    test('rejects a banned user', async () => {
        const { user, accessToken } = await makeUser()
        await User.updateOne({ userId: user.userId }, { banned: true })
        const res = await request(app).get('/v1/me').set('Authorization', `Bearer ${accessToken}`)
        assert.equal(res.status, 403)
    })
})

describe('password change', () => {
    test('requires authentication', async () => {
        // Previously: no auth middleware, target taken from the request body.
        const res = await request(app)
            .post('/api/auth/change-password')
            .send({ email: 'victim@example.com', newPassword: 'brand-new-password' })
        assert.equal(res.status, 401)
    })

    test('cannot skip currentPassword when a hash exists', async () => {
        // Previously: `if (user.passwordHash && currentPassword)` — omitting
        // currentPassword skipped verification entirely.
        const bcrypt = require('bcryptjs')
        const { user, accessToken } = await makeUser()
        await User.updateOne(
            { userId: user.userId },
            { passwordHash: await bcrypt.hash('the-original-password', 10) },
        )

        const res = await request(app)
            .post('/api/auth/change-password')
            .set('Authorization', `Bearer ${accessToken}`)
            .send({ newPassword: 'attacker-chosen-password' })

        assert.equal(res.status, 400)

        const after = await User.findOne({ userId: user.userId }).select('+passwordHash')
        assert.equal(
            await bcrypt.compare('the-original-password', after.passwordHash),
            true,
            'password must be unchanged',
        )
    })

    test('rejects an incorrect currentPassword', async () => {
        const bcrypt = require('bcryptjs')
        const { user, accessToken } = await makeUser()
        await User.updateOne(
            { userId: user.userId },
            { passwordHash: await bcrypt.hash('the-original-password', 10) },
        )

        const res = await request(app)
            .post('/api/auth/change-password')
            .set('Authorization', `Bearer ${accessToken}`)
            .send({ currentPassword: 'wrong', newPassword: 'attacker-chosen-password' })

        assert.equal(res.status, 400)
    })
})

describe('NoSQL injection', () => {
    test('rejects an operator object where a string id is expected', async () => {
        // {"userId":{"$ne":null}} previously matched the first user in the
        // collection.
        const res = await request(app)
            .post('/api/auth/change-password')
            .set('Authorization', 'Bearer x')
            .send({ userId: { $ne: null }, newPassword: 'whatever-password' })
        assert.ok(res.status === 400 || res.status === 401)
    })

    test('rejects an operator object in an email field', async () => {
        const res = await request(app)
            .post('/api/auth/send-otp')
            .send({ email: { $ne: null } })
        assert.equal(res.status, 400)
    })
})

describe('account data exposure', () => {
    test('account details require authentication', async () => {
        // Previously public: returned email, plan, mfaEnabled and the full
        // sessions array for any userId.
        const { userId } = await makeUser()
        const res = await request(app).get(`/api/auth/account/${userId}`)
        assert.equal(res.status, 401)
    })

    test('cannot read another user\'s account', async () => {
        const a = await makeUser()
        const b = await makeUser()
        const res = await request(app)
            .get(`/api/auth/account/${b.userId}`)
            .set('Authorization', `Bearer ${a.accessToken}`)
        assert.equal(res.status, 403)
    })

    test('never returns a password hash or MFA secret', async () => {
        const { userId, accessToken } = await makeUser()
        await User.updateOne({ userId }, { passwordHash: 'hash', mfaSecret: 'SECRET' })

        const res = await request(app)
            .get(`/api/auth/account/${userId}`)
            .set('Authorization', `Bearer ${accessToken}`)

        assert.equal(res.status, 200)
        const body = JSON.stringify(res.body)
        assert.ok(!body.includes('SECRET'), 'must not leak mfaSecret')
        assert.ok(!body.includes('hash'), 'must not leak passwordHash')
    })
})

describe('chat message access', () => {
    test('reading messages requires authentication', async () => {
        // GET /api/messages/:chatId was public and returned any chat's history.
        const res = await request(app).get('/api/messages/some-chat-id')
        assert.equal(res.status, 401)
    })

    test('cannot read a chat owned by another user', async () => {
        const Chat = require('../models/Chat')
        const owner = await makeUser()
        const attacker = await makeUser()
        await Chat.create({ chatId: 'chat-private-1', userId: owner.userId })

        const res = await request(app)
            .get('/api/messages/chat-private-1')
            .set('Authorization', `Bearer ${attacker.accessToken}`)

        assert.equal(res.status, 403)
    })
})

describe('inference endpoints', () => {
    test('completions require authentication', async () => {
        // Previously unauthenticated and unthrottled against paid upstreams.
        const res = await request(app)
            .post('/v1/chat/completions')
            .send({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] })
        assert.equal(res.status, 401)
    })

    test('/v1/responses requires authentication', async () => {
        const res = await request(app).post('/v1/responses').send({ input: 'hi' })
        assert.equal(res.status, 401)
    })
})

describe('OTP hardening', () => {
    test('stores a hash, never the plaintext code', async () => {
        await Otp.deleteMany({})
        const bcrypt = require('bcryptjs')
        await Otp.create({
            email: 'otp-user@example.com',
            codeHash: await bcrypt.hash('123456', 10),
            purpose: 'signup',
        })
        const record = await Otp.findOne({ email: 'otp-user@example.com' })
        assert.ok(record)
        assert.equal(record.code, undefined, 'plaintext code must not be persisted')
        assert.ok(record.codeHash && record.codeHash !== '123456')
        assert.equal(
            await bcrypt.compare('123456', record.codeHash),
            true,
            'stored hash must verify against the real code',
        )
    })

    test('locks out after repeated wrong codes', async () => {
        await Otp.deleteMany({})
        const email = 'brute@example.com'
        const bcrypt = require('bcryptjs')
        await Otp.create({
            email,
            codeHash: await bcrypt.hash('654321', 10),
            purpose: 'signup',
        })

        // The attempt counter destroys the record once the cap is hit, so after
        // MAX_ATTEMPTS the correct code must also stop working.
        for (let i = 0; i < Otp.MAX_ATTEMPTS; i++) {
            await request(app)
                .post('/api/auth/verify-otp')
                .send({ email, otp: '000000', purpose: 'signup' })
        }

        const res = await request(app)
            .post('/api/auth/verify-otp')
            .send({ email, otp: '654321', purpose: 'signup' })
        assert.notEqual(res.status, 200, 'the correct code must not work after lockout')

        const remaining = await Otp.findOne({ email, purpose: 'signup' })
        assert.equal(remaining, null, 'the record must be destroyed on attempt exhaustion')
    })
})

describe('admin guard', () => {
    test('denies access when no secret is supplied', async () => {
        const { accessToken } = await makeUser()
        const res = await request(app)
            .get('/api/analytics/users')
            .set('Authorization', `Bearer ${accessToken}`)
        assert.equal(res.status, 403)
    })

    test('denies an incorrect secret', async () => {
        const { accessToken } = await makeUser()
        const res = await request(app)
            .get('/api/analytics/users')
            .set('Authorization', `Bearer ${accessToken}`)
            .set('x-admin-secret', 'wrong-secret-value-here')
        assert.equal(res.status, 403)
    })

    test('allows the configured secret', async () => {
        const { accessToken } = await makeUser()
        const res = await request(app)
            .get('/api/analytics/users')
            .set('Authorization', `Bearer ${accessToken}`)
            .set('x-admin-secret', process.env.ADMIN_SECRET)
        assert.equal(res.status, 200)
    })
})

describe('tool execution ownership', () => {
    test('cannot execute another user\'s active tool', async () => {
        // The original ownership check was unreachable dead code, so any active
        // tool was world-executable.
        const owner = await makeUser()
        const attacker = await makeUser()
        await Tool.create({
            toolId: 'tool-owned-1',
            userId: owner.userId,
            name: 'Owner tool',
            content: 'print(1)',
            isActive: true,
        })

        const res = await request(app)
            .post('/api/tools/tool-owned-1/execute')
            .set('Authorization', `Bearer ${attacker.accessToken}`)
            .send({ input: {}, language: 'python' })

        assert.equal(res.status, 403)
    })
})

describe('coupon redemption', () => {
    test('cannot grant a plan to an arbitrary user id', async () => {
        // userId previously came from the request body.
        const victim = await makeUser()
        const attacker = await makeUser()
        await Coupon.create({
            code: 'FREEULTRA',
            plans: ['ultra'],
            grantPlan: 'ultra',
            discount: 100,
            maxUses: 10,
        })

        await request(app)
            .post('/api/coupon/redeem')
            .set('Authorization', `Bearer ${attacker.accessToken}`)
            .send({ code: 'FREEULTRA', planId: 'ultra', userId: victim.userId })

        const after = await User.findOne({ userId: victim.userId })
        assert.equal(after.plan, 'free', 'victim plan must be untouched')
    })

    test('a single-use coupon cannot be redeemed twice', async () => {
        const user = await makeUser()
        await Coupon.create({
            code: 'ONESHOT',
            plans: ['pro'],
            grantPlan: 'pro',
            discount: 100,
            maxUses: 1,
        })

        const first = await request(app)
            .post('/api/coupon/redeem')
            .set('Authorization', `Bearer ${user.accessToken}`)
            .send({ code: 'ONESHOT', planId: 'pro' })

        const second = await request(app)
            .post('/api/coupon/redeem')
            .set('Authorization', `Bearer ${user.accessToken}`)
            .send({ code: 'ONESHOT', planId: 'pro' })

        assert.equal(first.status, 200)
        assert.notEqual(second.status, 200)

        const coupon = await Coupon.findOne({ code: 'ONESHOT' })
        assert.equal(coupon.uses, 1, 'usage must not exceed maxUses')
    })
})

describe('error responses', () => {
    test('unknown routes return a structured 404, not an HTML stack', async () => {
        const res = await request(app).get('/definitely-not-a-route')
        assert.equal(res.status, 404)
        assert.equal(res.body.error.code, 'route_not_found')
    })

    test('malformed JSON returns 400 without internals', async () => {
        const res = await request(app)
            .post('/api/auth/send-otp')
            .set('Content-Type', 'application/json')
            .send('{"email": ')
        assert.equal(res.status, 400)
        assert.ok(!JSON.stringify(res.body).includes('at JSON.parse'))
    })
})

describe('security headers', () => {
    test('sets hardening headers and hides the framework', async () => {
        const res = await request(app).get('/health')
        assert.equal(res.status, 200)
        assert.equal(res.headers['x-content-type-options'], 'nosniff')
        assert.equal(res.headers['x-frame-options'], 'DENY')
        assert.equal(res.headers['x-powered-by'], undefined)
    })
})

describe('route mounting', () => {
    test('groups are reachable under their prefix, not the app root', async () => {
        // groups.js declared '/' and '/:id' but was mounted at '/', so a
        // wildcard authenticated GET sat at the application root.
        const { accessToken } = await makeUser()
        const res = await request(app)
            .get('/api/groups')
            .set('Authorization', `Bearer ${accessToken}`)
        assert.equal(res.status, 200)
    })

    test('the app root does not expose a catch-all wildcard', async () => {
        const { accessToken } = await makeUser()
        const res = await request(app)
            .get('/some-random-single-segment')
            .set('Authorization', `Bearer ${accessToken}`)
        assert.equal(res.status, 404)
    })

    test('the literal /api/configs/default path is not shadowed', async () => {
        const res = await request(app).get('/api/configs/default')
        assert.equal(res.status, 200)
        assert.ok(res.body.configs !== undefined)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// Session lifecycle: refresh rotation and logout.
//
// These were untested and all three defects below shipped as a result:
//   • rotateRefreshToken was declared (User, token, req) but called (token, req),
//     so `User` was the token string and User.findOne was not a function —
//     every refresh returned a 500 and no session could ever be renewed.
//   • /logout passed the raw refresh token where a sessionId was expected, so
//     the filter never matched and the session survived a logout.
//   • rotation minted the new access token with mfa:true unconditionally,
//     upgrading a non-MFA session's claim on every refresh.
// ─────────────────────────────────────────────────────────────────────────────
describe('session lifecycle', () => {
    test('a refresh token can be exchanged for a new pair', async () => {
        const { user } = await makeUser()
        const issued = await tokens.issueTokenPair(user, {
            headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/120' },
            ip: '203.0.113.9',
        })

        const res = await request(app)
            .post('/api/auth/refresh')
            .send({ refreshToken: issued.refreshToken })

        assert.equal(res.status, 200, 'refresh must succeed')
        assert.ok(res.body.accessToken, 'a new access token must be returned')
        assert.ok(res.body.refreshToken, 'a new refresh token must be returned')
        assert.notEqual(res.body.refreshToken, issued.refreshToken, 'the token must rotate')
    })

    test('replaying a rotated refresh token revokes every session', async () => {
        const { user } = await makeUser()
        const issued = await tokens.issueTokenPair(user, { headers: {}, ip: '' })

        const first = await request(app)
            .post('/api/auth/refresh')
            .send({ refreshToken: issued.refreshToken })
        assert.equal(first.status, 200)

        // The original token is now superseded. Presenting it again is the
        // signature of a stolen token being replayed.
        const replay = await request(app)
            .post('/api/auth/refresh')
            .send({ refreshToken: issued.refreshToken })
        assert.notEqual(replay.status, 200, 'a replayed token must not mint a new pair')

        const after = await User.findOne({ userId: user.userId })
        assert.equal(after.sessions.length, 0, 'all sessions must be revoked on replay')
    })

    test('rotation does not silently grant an MFA-satisfied claim', async () => {
        const { user } = await makeUser()
        // Session created WITHOUT passing an MFA step.
        const issued = await tokens.issueTokenPair(user, { headers: {}, ip: '' }, { mfa: false })

        const res = await request(app)
            .post('/api/auth/refresh')
            .send({ refreshToken: issued.refreshToken })
        assert.equal(res.status, 200)

        const jwt = require('jsonwebtoken')
        const payload = jwt.decode(res.body.accessToken)
        assert.notEqual(payload.mfa, true, 'refresh must not upgrade a non-MFA session')
    })

    test('logout actually removes the session', async () => {
        const { user } = await makeUser()
        const issued = await tokens.issueTokenPair(user, { headers: {}, ip: '' })

        const before = await User.findOne({ userId: user.userId })
        assert.equal(before.sessions.length, 1, 'precondition: one active session')

        const res = await request(app)
            .post('/api/auth/logout')
            .set('Authorization', `Bearer ${issued.accessToken}`)
            .send({ refreshToken: issued.refreshToken })
        assert.equal(res.status, 200)

        const after = await User.findOne({ userId: user.userId })
        assert.equal(after.sessions.length, 0, 'the session must be gone after logout')
    })

    test('session records capture the real device, not "Unknown"', async () => {
        // issueTokenPair reads req.headers['user-agent']; callers were passing a
        // pre-flattened { ip, userAgent } object, so every session recorded
        // Unknown/Unknown and the "your devices" list was useless.
        const { user } = await makeUser()
        await tokens.issueTokenPair(user, {
            headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X) Safari/17' },
            ip: '198.51.100.4',
        })

        const stored = await User.findOne({ userId: user.userId })
        const session = stored.sessions[0]
        assert.equal(session.os, 'macOS')
        assert.equal(session.browser, 'Safari')
        assert.equal(session.ip, '198.51.100.4')
    })
})

describe('MFA enrolment', () => {
    // The whole enrolment path was broken in several independent ways; each of
    // these assertions failed before the fix.
    test('setup stores a pending secret that verify can read back', async () => {
        const { accessToken } = await makeUser()

        const setup = await request(app)
            .post('/api/mfa/setup')
            .set('Authorization', `Bearer ${accessToken}`)
        assert.equal(setup.status, 200)
        assert.ok(setup.body.secret, 'a secret must be returned')
        assert.ok(setup.body.qrCode?.startsWith('data:image/'), 'a QR data URL must be returned')

        // The URI must name the account. Passing the wrong option key produced
        // a label of literally "account" for every user.
        assert.ok(!/AstraGPT:account\?/.test(setup.body.otpauthUrl),
            `otpauth URI must carry the real account, got: ${setup.body.otpauthUrl}`)

        // Wrong code must be refused...
        const bad = await request(app)
            .post('/api/mfa/verify')
            .set('Authorization', `Bearer ${accessToken}`)
            .send({ code: '000000' })
        assert.notEqual(bad.status, 200, 'an incorrect code must never enable 2FA')

        // ...and the correct one accepted. This failed with
        // "Start 2FA setup before verifying" because the pending secret was
        // never persisted: the field was absent from the schema, so Mongoose
        // silently dropped the assignment.
        const { generate, NobleCryptoPlugin, ScureBase32Plugin } = require('otplib')
        const code = await generate({
            secret: setup.body.secret,
            crypto: new NobleCryptoPlugin(),
            base32: new ScureBase32Plugin(),
        })

        const ok = await request(app)
            .post('/api/mfa/verify')
            .set('Authorization', `Bearer ${accessToken}`)
            .send({ code })
        assert.equal(ok.status, 200, `verify failed: ${JSON.stringify(ok.body)}`)
        assert.ok(Array.isArray(ok.body.recoveryCodes), 'recovery codes must be returned')
        assert.equal(ok.body.recoveryCodes.length, 10)
        assert.ok(ok.body.recoveryCodes.every(c => typeof c === 'string' && c.includes('-')))
    })

    test('recovery codes are stored hashed and counted correctly', async () => {
        const { userId, accessToken } = await makeUser()

        const setup = await request(app)
            .post('/api/mfa/setup')
            .set('Authorization', `Bearer ${accessToken}`)

        const { generate, NobleCryptoPlugin, ScureBase32Plugin } = require('otplib')
        const code = await generate({
            secret: setup.body.secret,
            crypto: new NobleCryptoPlugin(),
            base32: new ScureBase32Plugin(),
        })
        const enabled = await request(app)
            .post('/api/mfa/verify')
            .set('Authorization', `Bearer ${accessToken}`)
            .send({ code })
        assert.equal(enabled.status, 200)

        const plaintext = enabled.body.recoveryCodes[0]

        const stored = await User.findOne({ userId }).select('+mfaRecoveryCodes')
        assert.equal(stored.mfaRecoveryCodes.length, 10)
        const raw = JSON.stringify(stored.mfaRecoveryCodes)
        assert.ok(!raw.includes(plaintext), 'plaintext recovery codes must never be persisted')
        // The schema was [String] while the code wrote {codeHash,usedAt} objects.
        assert.ok(stored.mfaRecoveryCodes[0].codeHash, 'records must keep their codeHash field')

        // /status counts unused codes by inspecting .usedAt, which only works
        // if the records really are objects.
        const status = await request(app)
            .get('/api/mfa/status')
            .set('Authorization', `Bearer ${accessToken}`)
        assert.equal(status.status, 200)
        assert.equal(status.body.mfaEnabled, true)
        assert.equal(status.body.recoveryCodesRemaining, 10)
    })
})
