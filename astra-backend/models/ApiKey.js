const mongoose = require('mongoose')
const crypto = require('crypto')

// ─── AstraGPT API Key Model ────────────────────────────────────────────────────
// Users can generate named API keys to access AstraGPT from external apps.
// Each key is a 32-byte random hex string prefixed with "astra-"
// ─────────────────────────────────────────────────────────────────────────────

const ApiKeySchema = new mongoose.Schema({
    userId:     { type: String, required: true, index: true },  // Supabase UID
    name:       { type: String, required: true, maxlength: 64 }, // e.g. "My App", "Postman"
    key:        { type: String, required: true, unique: true },  // astra-xxxxxxxxxxxxxxxx
    keyPreview: { type: String, required: true },                // first 12 chars for display
    lastUsedAt: { type: Date, default: null },
    usageCount: { type: Number, default: 0 },
    isActive:   { type: Boolean, default: true },
    createdAt:  { type: Date, default: Date.now },
})

// Compound index for fast per-user queries
ApiKeySchema.index({ userId: 1, createdAt: -1 })

// Static: generate a new unique key
ApiKeySchema.statics.generateKey = function () {
    const raw = crypto.randomBytes(32).toString('hex')
    return `astra-${raw}`
}

module.exports = mongoose.model('ApiKey', ApiKeySchema)
