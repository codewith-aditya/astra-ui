const mongoose = require('mongoose')

// ═══════════════════════════════════════════════════════════════════════════
//  One-time passcodes.
//
//  Two properties matter for security and both were previously absent:
//
//  1. The code is stored as a SHA-256 hash, not plaintext. A read-only leak of
//     this collection (backup, log, aggregation pipeline) previously handed over
//     live login codes for every pending account.
//  2. `attempts` is tracked so a 6-digit code cannot be brute-forced. The whole
//     keyspace is 10^6; without a counter an unthrottled endpoint falls in
//     seconds. Verification is capped at MAX_OTP_ATTEMPTS and the record is
//     destroyed on exhaustion.
// ═══════════════════════════════════════════════════════════════════════════

const MAX_OTP_ATTEMPTS = 5
const OTP_TTL_SECONDS = 300

const OtpSchema = new mongoose.Schema({
    email: {
        type: String,
        required: true,
        lowercase: true,
        trim: true,
    },
    // SHA-256 of the 6-digit code. Never the code itself.
    codeHash: {
        type: String,
        required: true,
    },
    purpose: {
        type: String,
        enum: ['signup', 'reset', 'login'],
        default: 'signup',
    },
    attempts: {
        type: Number,
        default: 0,
    },
    createdAt: {
        type: Date,
        default: Date.now,
        // Mongo removes the document ~60s after this elapses. Belt-and-braces:
        // consumeOtp() also checks age explicitly, because the TTL monitor runs
        // on an interval and is not precise.
        expires: OTP_TTL_SECONDS,
    },
})

OtpSchema.index({ email: 1, purpose: 1 })

OtpSchema.statics.MAX_ATTEMPTS = MAX_OTP_ATTEMPTS
OtpSchema.statics.TTL_SECONDS = OTP_TTL_SECONDS

module.exports = mongoose.model('Otp', OtpSchema)
