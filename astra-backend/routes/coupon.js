// ═══════════════════════════════════════════════════════════════════════════
//  Coupon validation + redemption.
//
//  Redemption grants a paid plan, so it is authenticated and the target user
//  is taken from the verified token — never from the request body. Previously
//  `userId` came from the body, which let any caller upgrade any account (or
//  their own) by naming it.
// ═══════════════════════════════════════════════════════════════════════════

const express = require('express')
const router = express.Router()

const Coupon = require('../models/Coupon')
const User = require('../models/User')

const auth = require('../middleware/auth')
const { asyncHandler } = require('../utils/asyncHandler')
const { limiters } = require('../middleware/rateLimit')
const logger = require('../utils/logger')
const v = require('../utils/validate')
const { BadRequestError, NotFoundError } = require('../utils/errors')

const COUPON_PATTERN = /^[A-Za-z0-9_-]{3,64}$/

function normalizeCode(raw) {
    return v.str(raw, 'code', { max: 64, pattern: COUPON_PATTERN }).toUpperCase()
}

/**
 * Shared eligibility check. Throws a typed error describing the first failure,
 * or returns the coupon document.
 */
async function loadEligibleCoupon(code, { plan, userId }) {
    const coupon = await Coupon.findOne({ code })

    if (!coupon) throw new NotFoundError('Invalid or expired coupon code', 'coupon_invalid')
    if (!coupon.active) throw new BadRequestError('This coupon is no longer active', 'coupon_inactive')

    if (coupon.expiresAt && new Date() > coupon.expiresAt) {
        throw new BadRequestError('This coupon has expired', 'coupon_expired')
    }
    if (coupon.uses >= coupon.maxUses) {
        throw new BadRequestError('This coupon has reached its maximum uses', 'coupon_exhausted')
    }
    if (userId && Array.isArray(coupon.usedBy) && coupon.usedBy.includes(userId)) {
        throw new BadRequestError('You have already used this coupon', 'coupon_already_used')
    }
    if (plan && plan !== 'any' && Array.isArray(coupon.plans) && !coupon.plans.includes(plan)) {
        throw new BadRequestError(`This coupon is not valid for the ${plan} plan`, 'coupon_plan_mismatch')
    }

    return coupon
}

// ─── POST /validate-coupon — check without consuming ─────────────────────────
// Authenticated so the per-user "already used" check is meaningful and so the
// endpoint cannot be used to enumerate valid codes anonymously.
router.post('/validate-coupon', auth, limiters.coupon, asyncHandler(async (req, res) => {
    const code = normalizeCode(req.body.code)
    const plan = v.str(req.body.plan, 'plan', { max: 20, allowEmpty: true })

    const coupon = await loadEligibleCoupon(code, { plan, userId: req.userId })

    res.json({
        valid: true,
        code: coupon.code,
        label: coupon.label,
        discount: coupon.discount,
        plans: coupon.plans,
        grantPlan: coupon.grantPlan,
        validityDays: coupon.validityDays,
        dailyLimit: coupon.dailyLimit,
        credits: coupon.credits,
    })
}))

// ─── POST /redeem-coupon — consume and grant the plan ────────────────────────
router.post('/redeem-coupon', auth, limiters.coupon, asyncHandler(async (req, res) => {
    const code = normalizeCode(req.body.code)
    const plan = v.str(req.body.plan, 'plan', { max: 20, allowEmpty: true })
    const userId = req.userId

    const coupon = await loadEligibleCoupon(code, { plan, userId })

    const grantedPlan = coupon.grantPlan || plan
    if (!grantedPlan) {
        throw new BadRequestError('This coupon does not specify a plan to grant', 'coupon_no_plan')
    }

    let planExpiresAt = null
    if (coupon.validityDays) {
        planExpiresAt = new Date(Date.now() + coupon.validityDays * 86_400_000)
    }

    // Claim the coupon FIRST, conditioned on it still being unused by this user
    // and still under maxUses. An unconditional $inc plus a separate user update
    // allowed the same coupon to be redeemed twice under concurrent requests.
    const claimed = await Coupon.findOneAndUpdate(
        {
            code: coupon.code,
            active: true,
            usedBy: { $ne: userId },
            uses: { $lt: coupon.maxUses },
        },
        { $inc: { uses: 1 }, $push: { usedBy: userId } },
        { new: true }
    )

    if (!claimed) {
        throw new BadRequestError('This coupon is no longer available', 'coupon_unavailable')
    }

    // $set fields and $inc must live in separate operators. The previous code
    // built `{ plan, planExpiresAt, $inc: {...} }` and spread it into a single
    // update document, which MongoDB rejects for mixing an operator with plain
    // field paths — so any coupon carrying credits failed outright.
    const update = {
        $set: { plan: grantedPlan, planExpiresAt },
    }
    if (coupon.dailyLimit !== null && coupon.dailyLimit !== undefined) {
        update.$set.couponDailyLimit = coupon.dailyLimit
    }
    if (coupon.credits > 0) {
        update.$inc = { bonusCredits: coupon.credits }
    }

    await User.findOneAndUpdate({ userId }, update, { upsert: true })

    logger.info('coupon.redeemed', { userId, code: claimed.code, plan: grantedPlan })

    res.json({
        success: true,
        plan: grantedPlan,
        planExpiresAt,
        validityDays: coupon.validityDays,
        dailyLimit: coupon.dailyLimit,
        credits: coupon.credits,
    })
}))

module.exports = router
