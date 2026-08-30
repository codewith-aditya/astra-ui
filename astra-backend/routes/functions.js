const express = require('express')
const router = express.Router()
const auth = require('../middleware/auth')
const Function = require('../models/Function')

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTIONS / PIPELINES — /api/functions
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/functions — List functions (user's own + global active)
router.get('/api/functions', auth, async (req, res) => {
    try {
        const filter = {}

        if (req.query.type && ['filter', 'action', 'pipe'].includes(req.query.type)) {
            filter.type = req.query.type
        }

        if (req.query.userId) {
            if (req.query.userId !== req.userId) {
                return res.status(403).json({ error: 'Forbidden: cannot list other users\' functions' })
            }
            filter.userId = req.query.userId
        } else {
            // Default: user's own functions + globally active ones
            filter.$or = [
                { userId: req.userId },
                { isGlobal: true, isActive: true }
            ]
        }

        const functions = await Function.find(filter).sort({ createdAt: -1 })
        res.json({ success: true, data: functions })
    } catch (err) {
        console.error('[functions:list]', err.message)
        res.status(500).json({ error: 'Failed to fetch functions' })
    }
})

// POST /api/functions — Create a new function
router.post('/api/functions', auth, async (req, res) => {
    try {
        const { name, type, content, meta } = req.body

        if (!name?.trim()) {
            return res.status(400).json({ error: 'Function name is required' })
        }
        if (name.length > 100) {
            return res.status(400).json({ error: 'Function name too long (max 100 chars)' })
        }
        if (type && !['filter', 'action', 'pipe'].includes(type)) {
            return res.status(400).json({ error: 'Invalid function type. Must be: filter, action, or pipe' })
        }

        // Limit functions per user
        const count = await Function.countDocuments({ userId: req.userId })
        if (count >= 100) {
            return res.status(400).json({ error: 'Maximum 100 functions allowed per user' })
        }

        const fn = await Function.create({
            userId: req.userId,
            name: name.trim(),
            type: type || 'filter',
            content: (content || '').slice(0, 50000),
            meta: meta || {},
        })

        res.status(201).json({ success: true, data: fn })
    } catch (err) {
        console.error('[functions:create]', err.message)
        res.status(500).json({ error: 'Failed to create function' })
    }
})

// GET /api/functions/:id — Get function by functionId
router.get('/api/functions/:id', auth, async (req, res) => {
    try {
        const fn = await Function.findOne({ functionId: req.params.id })
        if (!fn) {
            return res.status(404).json({ error: 'Function not found' })
        }

        // Allow access if owner or if function is globally active
        if (fn.userId !== req.userId && !(fn.isGlobal && fn.isActive)) {
            return res.status(403).json({ error: 'Forbidden: function is not accessible' })
        }

        res.json({ success: true, data: fn })
    } catch (err) {
        console.error('[functions:get]', err.message)
        res.status(500).json({ error: 'Failed to fetch function' })
    }
})

// PUT /api/functions/:id — Update function (only owner)
router.put('/api/functions/:id', auth, async (req, res) => {
    try {
        const fn = await Function.findOne({ functionId: req.params.id, userId: req.userId })
        if (!fn) {
            return res.status(404).json({ error: 'Function not found or not owned by you' })
        }

        const { name, type, content, meta, isActive, isGlobal } = req.body
        const update = { updatedAt: new Date() }

        if (name !== undefined) {
            if (!name.trim()) return res.status(400).json({ error: 'Function name cannot be empty' })
            if (name.length > 100) return res.status(400).json({ error: 'Function name too long (max 100 chars)' })
            update.name = name.trim()
        }
        if (type !== undefined) {
            if (!['filter', 'action', 'pipe'].includes(type)) {
                return res.status(400).json({ error: 'Invalid function type. Must be: filter, action, or pipe' })
            }
            update.type = type
        }
        if (content !== undefined) update.content = content.slice(0, 50000)
        if (meta !== undefined) update.meta = meta
        if (isActive !== undefined) update.isActive = !!isActive
        if (isGlobal !== undefined) update.isGlobal = !!isGlobal

        const updated = await Function.findOneAndUpdate(
            { functionId: req.params.id, userId: req.userId },
            update,
            { new: true }
        )

        res.json({ success: true, data: updated })
    } catch (err) {
        console.error('[functions:update]', err.message)
        res.status(500).json({ error: 'Failed to update function' })
    }
})

// DELETE /api/functions/:id — Delete function (only owner)
router.delete('/api/functions/:id', auth, async (req, res) => {
    try {
        const fn = await Function.findOne({ functionId: req.params.id, userId: req.userId })
        if (!fn) {
            return res.status(404).json({ error: 'Function not found or not owned by you' })
        }

        await Function.findOneAndDelete({ functionId: req.params.id, userId: req.userId })
        res.json({ success: true })
    } catch (err) {
        console.error('[functions:delete]', err.message)
        res.status(500).json({ error: 'Failed to delete function' })
    }
})

// POST /api/functions/:id/toggle — Toggle isActive
router.post('/api/functions/:id/toggle', auth, async (req, res) => {
    try {
        const fn = await Function.findOne({ functionId: req.params.id, userId: req.userId })
        if (!fn) {
            return res.status(404).json({ error: 'Function not found or not owned by you' })
        }

        const updated = await Function.findOneAndUpdate(
            { functionId: req.params.id, userId: req.userId },
            { isActive: !fn.isActive, updatedAt: new Date() },
            { new: true }
        )

        res.json({ success: true, data: { functionId: updated.functionId, isActive: updated.isActive } })
    } catch (err) {
        console.error('[functions:toggle]', err.message)
        res.status(500).json({ error: 'Failed to toggle function' })
    }
})

// GET /api/functions/:id/valves — Get function configuration (valves)
router.get('/api/functions/:id/valves', auth, async (req, res) => {
    try {
        const fn = await Function.findOne({ functionId: req.params.id })
        if (!fn) {
            return res.status(404).json({ error: 'Function not found' })
        }

        // Only owner can view valves
        if (fn.userId !== req.userId) {
            return res.status(403).json({ error: 'Forbidden: only the function owner can view valves' })
        }

        res.json({ success: true, data: { functionId: fn.functionId, valves: fn.valves || {} } })
    } catch (err) {
        console.error('[functions:getValves]', err.message)
        res.status(500).json({ error: 'Failed to fetch function valves' })
    }
})

// POST /api/functions/:id/valves — Update function configuration (valves)
router.post('/api/functions/:id/valves', auth, async (req, res) => {
    try {
        const fn = await Function.findOne({ functionId: req.params.id, userId: req.userId })
        if (!fn) {
            return res.status(404).json({ error: 'Function not found or not owned by you' })
        }

        const { valves } = req.body
        if (valves === undefined || valves === null || typeof valves !== 'object' || Array.isArray(valves)) {
            return res.status(400).json({ error: 'valves must be a JSON object' })
        }

        const updated = await Function.findOneAndUpdate(
            { functionId: req.params.id, userId: req.userId },
            { valves, updatedAt: new Date() },
            { new: true }
        )

        res.json({ success: true, data: { functionId: updated.functionId, valves: updated.valves } })
    } catch (err) {
        console.error('[functions:updateValves]', err.message)
        res.status(500).json({ error: 'Failed to update function valves' })
    }
})

module.exports = router
