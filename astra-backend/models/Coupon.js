const mongoose = require('mongoose')

// ─── Advanced Coupon Schema ────────────────────────────────────────────────────
const CouponSchema = new mongoose.Schema({
    code:        { type: String, required: true, unique: true, uppercase: true, trim: true },
    label:       { type: String, default: '' },           // display name e.g. "50% OFF"

    // ── Plan & Access ──────────────────────────────────────────────────────────
    plans:       { type: [String], default: ['pro'] },    // which plans this unlocks ['pro','pro+','ultra']
    grantPlan:   { type: String, default: null },         // force-set plan (e.g. 'ultra') — null = user picks

    // ── Discount ──────────────────────────────────────────────────────────────
    discount:    { type: Number, default: 100 },          // percentage off (0-100)

    // ── Validity ──────────────────────────────────────────────────────────────
    validityDays: { type: Number, default: null },        // null = never expires (permanent)
    expiresAt:    { type: Date, default: null },          // coupon itself expires on this date

    // ── Daily Request Limit Override ──────────────────────────────────────────
    dailyLimit:  { type: Number, default: null },         // null = use plan default

    // ── Credits ───────────────────────────────────────────────────────────────
    credits:     { type: Number, default: 0 },            // bonus message credits (0 = none)

    // ── Usage Control ─────────────────────────────────────────────────────────
    maxUses:     { type: Number, default: 100 },          // max total redemptions
    uses:        { type: Number, default: 0 },            // current redemption count
    usedBy:      { type: [String], default: [] },         // userId list (prevent double-use)
    maxUsesPerUser: { type: Number, default: 1 },         // per user limit

    active:      { type: Boolean, default: true },
    createdAt:   { type: Date, default: Date.now },
})

module.exports = mongoose.models.Coupon || mongoose.model('Coupon', CouponSchema)
