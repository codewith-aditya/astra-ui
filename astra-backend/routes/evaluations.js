const express = require('express')
const router = express.Router()
const auth = require('../middleware/auth')
const Feedback = require('../models/Feedback')

// ─────────────────────────────────────────────────────────────────────────────
// MODEL EVALUATIONS & LEADERBOARD — /api/evaluations
// Handles user feedback, model comparisons, and Elo-based leaderboard
// ─────────────────────────────────────────────────────────────────────────────

// ── GET /api/evaluations — List feedback entries (filter by userId) ──────────
router.get('/api/evaluations', auth, async (req, res) => {
    try {
        const feedback = await Feedback.find({ userId: req.userId })
            .sort({ createdAt: -1 })

        res.json({ feedback })
    } catch (err) {
        console.error('[evaluations GET]', err.message)
        res.status(500).json({ error: 'Failed to fetch evaluations' })
    }
})

// ── POST /api/evaluations — Submit feedback ─────────────────────────────────
router.post('/api/evaluations', auth, async (req, res) => {
    try {
        const { type, data, chatId, messageId } = req.body

        if (!type) {
            return res.status(400).json({ error: 'Feedback type is required' })
        }
        if (!['rating', 'comparison', 'comment'].includes(type)) {
            return res.status(400).json({ error: 'Invalid type. Must be rating, comparison, or comment' })
        }
        if (!data || typeof data !== 'object') {
            return res.status(400).json({ error: 'Feedback data object is required' })
        }

        // Validate type-specific fields
        if (type === 'rating') {
            if (data.rating === undefined || data.rating === null) {
                return res.status(400).json({ error: 'rating is required for type "rating"' })
            }
            if (typeof data.rating !== 'number' || data.rating < -1 || data.rating > 1) {
                return res.status(400).json({ error: 'rating must be -1, 0, or 1' })
            }
        }

        if (type === 'comparison') {
            if (!data.modelA?.trim() || !data.modelB?.trim()) {
                return res.status(400).json({ error: 'modelA and modelB are required for comparisons' })
            }
            if (!data.winner?.trim()) {
                return res.status(400).json({ error: 'winner is required for comparisons (modelA, modelB, or tie)' })
            }
            if (![data.modelA, data.modelB, 'tie'].includes(data.winner)) {
                return res.status(400).json({ error: 'winner must be modelA, modelB, or "tie"' })
            }
        }

        if (type === 'comment') {
            if (!data.comment?.trim()) {
                return res.status(400).json({ error: 'comment is required for type "comment"' })
            }
        }

        // Sanitize data
        const sanitizedData = {
            rating: typeof data.rating === 'number' ? data.rating : 0,
            comment: (data.comment || '').trim().slice(0, 2000),
            modelA: (data.modelA || '').trim(),
            modelB: (data.modelB || '').trim(),
            winner: (data.winner || '').trim(),
            tags: Array.isArray(data.tags) ? data.tags.slice(0, 10).map(t => String(t).trim().slice(0, 50)).filter(Boolean) : [],
        }

        const feedback = await Feedback.create({
            userId: req.userId,
            type,
            data: sanitizedData,
            chatId: chatId || '',
            messageId: messageId || '',
        })

        res.json({ feedback })
    } catch (err) {
        console.error('[evaluations POST]', err.message)
        res.status(500).json({ error: 'Failed to submit feedback' })
    }
})

// ── GET /api/evaluations/leaderboard — Elo-based model leaderboard ──────────
router.get('/api/evaluations/leaderboard', async (req, res) => {
    try {
        // Fetch all comparison-type feedback
        const comparisons = await Feedback.find({ type: 'comparison' })

        if (comparisons.length === 0) {
            return res.json({ leaderboard: [], totalComparisons: 0 })
        }

        // Track Elo ratings and stats for each model
        const models = {}

        const ensureModel = (name) => {
            if (!models[name]) {
                models[name] = { elo: 1500, wins: 0, losses: 0, ties: 0 }
            }
        }

        const K = 32

        for (const fb of comparisons) {
            const { modelA, modelB, winner } = fb.data || {}
            if (!modelA || !modelB) continue

            ensureModel(modelA)
            ensureModel(modelB)

            const rA = models[modelA].elo
            const rB = models[modelB].elo

            // Expected scores
            const eA = 1 / (1 + Math.pow(10, (rB - rA) / 400))
            const eB = 1 / (1 + Math.pow(10, (rA - rB) / 400))

            // Actual scores based on winner
            let sA, sB
            if (winner === modelA) {
                sA = 1
                sB = 0
                models[modelA].wins++
                models[modelB].losses++
            } else if (winner === modelB) {
                sA = 0
                sB = 1
                models[modelB].wins++
                models[modelA].losses++
            } else {
                // tie
                sA = 0.5
                sB = 0.5
                models[modelA].ties++
                models[modelB].ties++
            }

            // Update Elo ratings
            models[modelA].elo = Math.round(rA + K * (sA - eA))
            models[modelB].elo = Math.round(rB + K * (sB - eB))
        }

        // Build sorted leaderboard array
        const leaderboard = Object.entries(models)
            .map(([model, stats]) => ({
                model,
                elo: stats.elo,
                wins: stats.wins,
                losses: stats.losses,
                ties: stats.ties,
            }))
            .sort((a, b) => b.elo - a.elo)

        res.json({ leaderboard, totalComparisons: comparisons.length })
    } catch (err) {
        console.error('[evaluations leaderboard]', err.message)
        res.status(500).json({ error: 'Failed to calculate leaderboard' })
    }
})

// ── GET /api/evaluations/history — Model comparison history ─────────────────
router.get('/api/evaluations/history', auth, async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1)
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50))
        const skip = (page - 1) * limit

        // Build query filter
        const filter = { type: 'comparison' }

        // Optional: filter by specific user's comparisons only
        if (req.query.mine === 'true') {
            filter.userId = req.userId
        }

        // Optional: filter by model name
        if (req.query.model) {
            const model = req.query.model.trim()
            filter.$or = [
                { 'data.modelA': model },
                { 'data.modelB': model },
            ]
        }

        const [history, total] = await Promise.all([
            Feedback.find(filter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .select('feedbackId userId data chatId createdAt'),
            Feedback.countDocuments(filter),
        ])

        res.json({
            history,
            pagination: {
                page,
                limit,
                total,
                pages: Math.ceil(total / limit),
            },
        })
    } catch (err) {
        console.error('[evaluations history]', err.message)
        res.status(500).json({ error: 'Failed to fetch comparison history' })
    }
})

// ── DELETE /api/evaluations/:id — Delete feedback (owner only) ──────────────
router.delete('/api/evaluations/:id', auth, async (req, res) => {
    try {
        const feedback = await Feedback.findOne({ feedbackId: req.params.id })
        if (!feedback) return res.status(404).json({ error: 'Feedback not found' })
        if (feedback.userId !== req.userId) return res.status(403).json({ error: 'Forbidden — only the owner can delete this feedback' })

        await Feedback.deleteOne({ feedbackId: req.params.id })

        res.json({ success: true, deleted: req.params.id })
    } catch (err) {
        console.error('[evaluations DELETE]', err.message)
        res.status(500).json({ error: 'Failed to delete feedback' })
    }
})

module.exports = router
