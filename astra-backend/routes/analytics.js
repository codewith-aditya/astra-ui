const express = require('express')
const router = express.Router()
const auth = require('../middleware/auth')
const { adminGuard } = require('../middleware/adminGuard')
const { asyncHandler } = require('../utils/asyncHandler')
const v = require('../utils/validate')
const Chat = require('../models/Chat')
const Message = require('../models/Message')
const User = require('../models/User')

// ─── Dashboard analytics ─────────────────────────────────────────────────────
router.get('/api/analytics/dashboard', auth, asyncHandler(async (req, res) => {
    const userId = req.userId

    // chatIds is awaited first: an `await` inside a Promise.all element runs
    // before the array is built, so it was never actually parallel there.
    const chatIds = await Chat.find({ userId }).distinct('chatId')

    const [totalChats, totalMessages, recentChats, modelUsage, dailyActivity] = await Promise.all([
        Chat.countDocuments({ userId }),
        Message.countDocuments({ chatId: { $in: chatIds } }),
        Chat.find({ userId }).sort({ createdAt: -1 }).limit(10).lean(),
        Chat.aggregate([
            { $match: { userId } },
            { $group: { _id: '$model', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
        ]),
        Chat.aggregate([
            { $match: { userId } },
            {
                $group: {
                    _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
                    count: { $sum: 1 },
                },
            },
            { $sort: { _id: -1 } },
            { $limit: 30 },
        ]),
    ])

    res.json({
        success: true,
        dashboard: { totalChats, totalMessages, recentChats, modelUsage, dailyActivity },
    })
}))

// ─── Per-model usage stats ────────────────────────────────────────────────────
router.get('/api/analytics/models', auth, asyncHandler(async (req, res) => {
    const stats = await Chat.aggregate([
        { $match: { userId: req.userId } },
        {
            $group: {
                _id: '$model',
                chatCount: { $sum: 1 },
                firstUsed: { $min: '$createdAt' },
                lastUsed: { $max: '$createdAt' },
            },
        },
        { $sort: { chatCount: -1 } },
    ])

    res.json({ success: true, models: stats })
}))

// ─── User activity analytics (admin) ─────────────────────────────────────────
// Previously guarded by `if (adminSecret && ...)`, which skipped the check
// entirely whenever ADMIN_SECRET was unset or empty — leaving every user's
// email and plan readable by any authenticated caller. adminGuard fails closed.
router.get('/api/analytics/users', adminGuard, asyncHandler(async (_req, res) => {
    const [totalUsers, activeUsers, planDistribution, recentSignups] = await Promise.all([
        User.countDocuments(),
        User.countDocuments({ lastActive: { $gte: new Date(Date.now() - 7 * 86400_000) } }),
        User.aggregate([
            { $group: { _id: '$plan', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
        ]),
        User.find().sort({ createdAt: -1 }).limit(20)
            .select('userId email plan createdAt lastActive').lean(),
    ])

    res.json({
        success: true,
        users: {
            total: totalUsers,
            activeThisWeek: activeUsers,
            planDistribution,
            recentSignups,
        },
    })
}))

// ─── Token usage over time ────────────────────────────────────────────────────
router.get('/api/analytics/tokens', auth, asyncHandler(async (req, res) => {
    const days = v.clampInt(req.query.days, { min: 1, max: 365, fallback: 30 })
    const chatIds = await Chat.find({ userId: req.userId }).distinct('chatId')

    const tokenData = await Message.aggregate([
        { $match: { chatId: { $in: chatIds } } },
        {
            $group: {
                _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
                messageCount: { $sum: 1 },
                // Approximate token count from content length (rough: 1 token ≈ 4 chars)
                estimatedTokens: {
                    $sum: { $ceil: { $divide: [{ $strLenCP: { $ifNull: ['$content', ''] } }, 4] } },
                },
            },
        },
        { $sort: { _id: -1 } },
        { $limit: days },
    ])

    res.json({ success: true, tokens: tokenData })
}))

module.exports = router
