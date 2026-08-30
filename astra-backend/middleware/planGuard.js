// ═══════════════════════════════════════════════════════════════════════════
//  Plan enforcement: model gating, daily quota, per-minute rate limit.
//
//  Three defects are fixed relative to the previous version:
//
//   1. FAIL-OPEN. The catch block called next(), so any database hiccup
//      silently disabled quota and model gating for every request. It now
//      fails closed with 503 — a temporary outage must not become free
//      unlimited access to paid upstream inference.
//
//   2. TRUSTED CLIENT INPUT. The plan was resolved from req.body.userId, and
//      getUsageStats authorised on an `x-user-id` header. Both are attacker
//      controlled. Identity now comes only from req.userId, set by the
//      authentication middleware after signature verification.
//
//   3. WRONG FALLBACK LIMIT. getUsageStats returned a hardcoded `limit: 20`
//      for unknown users while the free plan is 50, so the UI displayed a
//      quota that did not match enforcement.
//
//  The daily counter is incremented with an atomic findOneAndUpdate rather
//  than read-modify-write, which previously allowed concurrent requests to
//  interleave and undercount.
// ═══════════════════════════════════════════════════════════════════════════

const User = require('../models/User')
const { consume } = require('./rateLimit')
const logger = require('../utils/logger')
const {
    BadRequestError,
    ForbiddenError,
    UnauthorizedError,
    RateLimitError,
    ServiceUnavailableError,
} = require('../utils/errors')
const { asyncHandler } = require('../utils/asyncHandler')
const v = require('../utils/validate')

const PLAN_LIMITS = {
    free: {
        daily: 50,
        perMin: 10,
        models: [
            'deepseek-v4-flash', 'openai/gpt-oss-120b', 'gpt-oss-120b',
            'claude-sonnet-4-6', 'gemini-2.5-flash',
        ],
    },
    pro: {
        daily: 500,
        perMin: 25,
        models: [
            'deepseek-v4-flash', 'openai/gpt-oss-120b', 'gpt-oss-120b',
            'deepseek-v4-pro', 'Qwen/Qwen3-Next-80B-A3B-Instruct-FP8',
            'qwen3.5-397B', 'claude-sonnet-4-6', 'gemini-2.5-flash',
        ],
    },
    'pro+': {
        daily: 2500,
        perMin: 40,
        models: [
            'deepseek-v4-flash', 'openai/gpt-oss-120b', 'gpt-oss-120b',
            'deepseek-v4-pro', 'Qwen/Qwen3-Next-80B-A3B-Instruct-FP8',
            'qwen3.5-397B', 'claude-sonnet-4-6', 'gemini-2.5-flash',
        ],
    },
    ultra: {
        daily: 9999,
        perMin: 60,
        models: [
            'deepseek-v4-flash', 'openai/gpt-oss-120b', 'gpt-oss-120b',
            'deepseek-v4-pro', 'Qwen/Qwen3-Next-80B-A3B-Instruct-FP8',
            'qwen3.5-397B', 'claude-sonnet-4-6', 'gemini-2.5-flash',
        ],
    },
}

const DEFAULT_PLAN = 'free'

function getLimits(plan) {
    return PLAN_LIMITS[plan] || PLAN_LIMITS[DEFAULT_PLAN]
}

function todayKey() {
    return new Date().toISOString().slice(0, 10)
}

/**
 * Enforce plan limits. Must run AFTER the authentication middleware so that
 * req.userId is a verified identity.
 */
async function planGuard(req, res, next) {
    const userId = req.userId
    if (!userId) {
        return next(new UnauthorizedError('Authentication required', 'unauthorized'))
    }

    let user
    try {
        user = await User.findOne({ userId })
        if (!user) user = await User.create({ userId })
    } catch (err) {
        // Fail CLOSED. Previously this path called next() and every limit was
        // bypassed whenever MongoDB was briefly unavailable.
        logger.error('planGuard: user lookup failed', err, { userId })
        return next(new ServiceUnavailableError(
            'Service temporarily unavailable, please retry',
            'plan_check_unavailable'
        ))
    }

    if (user.banned) {
        return next(new ForbiddenError(
            user.banReason || 'This account has been suspended.',
            'account_banned'
        ))
    }

    const activePlan = user.getActivePlan()
    const limits = getLimits(activePlan)

    // 1. Model gating.
    const model = typeof req.body?.model === 'string' ? req.body.model : ''
    if (model && !limits.models.includes(model)) {
        return next(new ForbiddenError(
            `Your ${activePlan} plan does not include access to ${model}. Please upgrade.`,
            'model_not_allowed'
        ))
    }

    // 2. Per-minute rate limit (shared Redis window when configured).
    let rate
    try {
        rate = await consume('plan:permin', userId, limits.perMin, 60_000)
    } catch (err) {
        logger.error('planGuard: rate backend failed', err, { userId })
        return next(new ServiceUnavailableError(
            'Service temporarily unavailable, please retry',
            'rate_check_unavailable'
        ))
    }
    if (!rate.allowed) {
        res.setHeader('Retry-After', String(rate.retryAfter || 60))
        return next(new RateLimitError(
            `Too many messages. Wait ${rate.retryAfter}s.`,
            { retryAfter: rate.retryAfter }
        ))
    }

    // 3. Daily quota — atomic increment so concurrent requests cannot interleave.
    const today = todayKey()
    let updated
    try {
        // Reset the window first if the stored day is stale.
        if (user.dailyUsageDate !== today) {
            await User.updateOne(
                { userId, dailyUsageDate: { $ne: today } },
                { $set: { dailyUsageDate: today, dailyUsage: 0 } }
            )
        }
        updated = await User.findOneAndUpdate(
            { userId, dailyUsageDate: today, dailyUsage: { $lt: limits.daily } },
            { $inc: { dailyUsage: 1 }, $set: { lastActive: new Date() } },
            { new: true }
        )
    } catch (err) {
        logger.error('planGuard: quota update failed', err, { userId })
        return next(new ServiceUnavailableError(
            'Service temporarily unavailable, please retry',
            'quota_check_unavailable'
        ))
    }

    if (!updated) {
        // The conditional update matched nothing: the quota is exhausted.
        return next(new RateLimitError(
            `Daily message limit reached (${limits.daily}). Upgrade for more.`,
            { code: 'daily_limit_reached' }
        ))
    }

    req.userPlan = activePlan
    req.userLimits = limits
    req.dailyUsage = updated.dailyUsage
    next()
}

/**
 * GET /api/usage/:userId — own stats only, authorised from the verified token.
 */
const getUsageStats = asyncHandler(async (req, res) => {
    const requested = v.id(req.params.userId, 'userId')
    if (requested !== req.userId) {
        throw new ForbiddenError('You can only view your own usage stats.', 'not_owner')
    }

    const user = await User.findOne({ userId: req.userId })
    if (!user) {
        const limits = getLimits(DEFAULT_PLAN)
        return res.json({
            plan: DEFAULT_PLAN,
            daily: 0,
            limit: limits.daily,
            remaining: limits.daily,
            perMin: limits.perMin,
            models: limits.models,
        })
    }

    const activePlan = user.getActivePlan()
    const limits = getLimits(activePlan)
    const dailyUsage = user.getDailyUsage()

    res.json({
        plan: activePlan,
        planExpiresAt: user.planExpiresAt,
        daily: dailyUsage,
        limit: limits.daily,
        remaining: Math.max(0, limits.daily - dailyUsage),
        perMin: limits.perMin,
        models: limits.models,
    })
})

/**
 * POST /api/plan — admin/billing only. The route mounts adminGuard ahead of it.
 */
const updatePlan = asyncHandler(async (req, res) => {
    const userId = v.id(req.body.userId, 'userId')
    const plan = v.oneOf(req.body.plan, Object.keys(PLAN_LIMITS), 'plan')
    const durationDays = v.int(req.body.durationDays, 'durationDays', {
        min: 1, max: 3650, fallback: 30,
    })

    if (plan !== 'free' && !Number.isFinite(durationDays)) {
        throw new BadRequestError('durationDays is required for paid plans', 'missing_field')
    }

    const expiresAt = plan === 'free'
        ? null
        : new Date(Date.now() + durationDays * 86_400_000)

    const user = await User.findOneAndUpdate(
        { userId },
        { $set: { plan, planExpiresAt: expiresAt } },
        { upsert: true, new: true }
    )

    logger.info('plan.updated', { userId, plan, expiresAt })
    res.json({ ok: true, plan: user.plan, planExpiresAt: user.planExpiresAt })
})

module.exports = { planGuard, getUsageStats, updatePlan, PLAN_LIMITS, getLimits }
