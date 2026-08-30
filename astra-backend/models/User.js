const mongoose = require('mongoose')

// ─── Session (refresh token) subdocument ─────────────────────────────────────
// Only a SHA-256 hash of the refresh token is stored, so a database leak does
// not hand out usable sessions.
const SessionSchema = new mongoose.Schema({
    sessionId:  { type: String, required: true },
    tokenHash:  { type: String, required: true },
    device:     { type: String, default: 'Unknown' },
    browser:    { type: String, default: 'Unknown' },
    os:         { type: String, default: 'Unknown' },
    ip:         { type: String, default: '' },
    userAgent:  { type: String, default: '' },
    // Whether a second factor was actually presented when this session was
    // created. Refresh rotation must carry this forward rather than assume it:
    // minting an mfa=true access token from a session that never passed TOTP
    // would let a refresh token launder its way past requireMfa.
    mfaSatisfied: { type: Boolean, default: false },
    createdAt:  { type: Date, default: Date.now },
    lastActive: { type: Date, default: Date.now },
    expiresAt:  { type: Date, required: true },
}, { _id: false })

const UserSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true, index: true },
    email: { type: String, default: '', index: true },
    name: { type: String, default: '' },
    avatarUrl: { type: String, default: '' },
    passwordHash: { type: String, default: '', select: false },
    plan: { type: String, enum: ['free', 'pro', 'pro+', 'ultra'], default: 'free' },
    planExpiresAt: { type: Date, default: null },  // null = never expires (free)
    banned: { type: Boolean, default: false },
    banReason: { type: String, default: '' },
    dailyUsage: { type: Number, default: 0 },
    dailyUsageDate: { type: String, default: '' },  // 'YYYY-MM-DD' (UTC)
    lastActive: { type: Date, default: Date.now },
    chatCount: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },

    // ── Credential invalidation ──────────────────────────────────────────────
    // Bumped on password change / global sign-out. Access tokens carry this
    // value and are rejected once it no longer matches.
    tokenVersion: { type: Number, default: 0 },
    passwordChangedAt: { type: Date, default: null },

    // ── 2FA / TOTP ───────────────────────────────────────────────────────────
    mfaEnabled: { type: Boolean, default: false },
    mfaSecret: { type: String, default: '', select: false },   // base32 TOTP secret
    // Enrolment is two-phase: /setup writes here and /verify promotes it to
    // mfaSecret. Without this path Mongoose silently dropped the assignment, so
    // /setup returned a QR code for a secret the server never kept and /verify
    // always answered "start setup first" — 2FA could not be enabled at all.
    mfaPendingSecret: { type: String, default: '', select: false },
    mfaVerified: { type: Boolean, default: false },
    // Single-use recovery codes, stored as SHA-256 digests with a consumption
    // timestamp. Typed as documents rather than [String] because the code reads
    // `.codeHash` / `.usedAt`; a string array coerced each record to
    // "[object Object]" and made every code unmatchable.
    mfaRecoveryCodes: {
        type: [new mongoose.Schema({
            codeHash: { type: String, required: true },
            usedAt: { type: Date, default: null },
        }, { _id: false })],
        default: [],
        select: false,
    },
    // Guards against TOTP replay: the last time step accepted for this user.
    mfaLastTimeStep: { type: Number, default: 0, select: false },

    // ── Active sessions (hashed refresh tokens) ──────────────────────────────
    sessions: { type: [SessionSchema], default: [] },
})

// Helper: today's date key in UTC. Zero-padded 'YYYY-MM-DD' so string equality
// is safe and lexicographic ordering matches chronological ordering.
UserSchema.methods.getTodayKey = function () {
    return new Date().toISOString().slice(0, 10)
}

// Helper: get daily usage (auto-resets if new day)
UserSchema.methods.getDailyUsage = function () {
    if (this.dailyUsageDate !== this.getTodayKey()) return 0
    return this.dailyUsage
}

// Helper: check if plan is active (not expired)
UserSchema.methods.getActivePlan = function () {
    if (this.plan === 'free') return 'free'
    if (!this.planExpiresAt) return this.plan
    if (new Date() > this.planExpiresAt) return 'free'  // expired
    return this.plan
}

// Drop expired sessions. Caller is responsible for saving.
UserSchema.methods.pruneSessions = function () {
    const now = new Date()
    const before = this.sessions.length
    this.sessions = this.sessions.filter(s => s.expiresAt > now)
    return before - this.sessions.length
}

// Safe projection for API responses — never leaks hashes or secrets.
UserSchema.methods.toPublicJSON = function () {
    return {
        userId: this.userId,
        email: this.email,
        name: this.name || (this.email ? this.email.split('@')[0] : ''),
        avatarUrl: this.avatarUrl || '',
        plan: this.getActivePlan(),
        planExpiresAt: this.planExpiresAt,
        createdAt: this.createdAt,
        chatCount: this.chatCount || 0,
        dailyUsage: this.getDailyUsage(),
        mfaEnabled: this.mfaEnabled || false,
    }
}

module.exports = mongoose.model('User', UserSchema)
