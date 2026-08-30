const mongoose = require('mongoose')

// ─── AstraGPT Memory System ────────────────────────────────────────────────────
// Stores persistent user memories that get injected into every AI conversation.
// Examples: "I prefer Python", "My name is Aditya", "I work at Tantra AI Labs"
// ─────────────────────────────────────────────────────────────────────────────

const MemorySchema = new mongoose.Schema({
    userId:    { type: String, required: true, index: true },   // Supabase UID
    content:   { type: String, required: true, maxlength: 500 },// The memory text
    source:    { type: String, enum: ['manual', 'auto'], default: 'manual' }, // manual = user added, auto = AI extracted
    tags:      { type: [String], default: [] },                 // e.g. ['preference', 'personal', 'work']
    createdAt: { type: Date, default: Date.now },
})

// Compound index for fast per-user queries
MemorySchema.index({ userId: 1, createdAt: -1 })

module.exports = mongoose.model('Memory', MemorySchema)
