const express = require('express')
const router = express.Router()
const auth = require('../middleware/auth')
const Skill = require('../models/Skill')
const { asyncHandler } = require('../utils/asyncHandler')
const { limiters } = require('../middleware/rateLimit')
const v = require('../utils/validate')
const { NotFoundError, BadRequestError } = require('../utils/errors')

const MAX_SKILLS_PER_USER = 200

// ─── List skills ──────────────────────────────────────────────────────────────
router.get('/api/skills', auth, asyncHandler(async (req, res) => {
    const skills = await Skill.find({ userId: req.userId }).sort({ createdAt: -1 }).lean()
    res.json({ success: true, skills })
}))

// ─── Create skill ─────────────────────────────────────────────────────────────
router.post('/api/skills', auth, limiters.write, asyncHandler(async (req, res) => {
    const name = v.str(req.body.name, 'name', { max: 120 })
    const description = v.str(req.body.description, 'description', { max: 2000, allowEmpty: true }) || ''
    const content = v.str(req.body.content, 'content', { max: 50_000, allowEmpty: true }) || ''
    const meta = v.safeObject(req.body.meta, 'meta') || {}

    const count = await Skill.countDocuments({ userId: req.userId })
    if (count >= MAX_SKILLS_PER_USER) {
        throw new v.BadRequest(`Maximum ${MAX_SKILLS_PER_USER} skills allowed per user`)
    }

    const skill = await Skill.create({ userId: req.userId, name, description, content, meta })
    res.status(201).json({ success: true, skill })
}))

// ─── Get skill ────────────────────────────────────────────────────────────────
router.get('/api/skills/:id', auth, asyncHandler(async (req, res) => {
    const skillId = v.id(req.params.id, 'skillId')
    const skill = await Skill.findOne({ skillId, userId: req.userId }).lean()
    if (!skill) throw new NotFoundError('Skill not found', 'skill_not_found')
    res.json({ success: true, skill })
}))

// ─── Update skill ─────────────────────────────────────────────────────────────
router.put('/api/skills/:id', auth, limiters.write, asyncHandler(async (req, res) => {
    const skillId = v.id(req.params.id, 'skillId')

    // Only assign fields that were actually supplied, and coerce each one so a
    // nested object cannot reach the update document.
    const update = {}
    if (req.body.name !== undefined) update.name = v.str(req.body.name, 'name', { max: 120 })
    if (req.body.description !== undefined) {
        update.description = v.str(req.body.description, 'description', { max: 2000, allowEmpty: true }) || ''
    }
    if (req.body.content !== undefined) {
        update.content = v.str(req.body.content, 'content', { max: 50_000, allowEmpty: true }) || ''
    }
    if (req.body.meta !== undefined) update.meta = v.safeObject(req.body.meta, 'meta') || {}
    if (req.body.isActive !== undefined) update.isActive = v.bool(req.body.isActive, 'isActive')

    const skill = await Skill.findOneAndUpdate(
        { skillId, userId: req.userId },
        { $set: update },
        { new: true }
    )
    if (!skill) throw new NotFoundError('Skill not found', 'skill_not_found')
    res.json({ success: true, skill })
}))

// ─── Delete skill ─────────────────────────────────────────────────────────────
router.delete('/api/skills/:id', auth, asyncHandler(async (req, res) => {
    const skillId = v.id(req.params.id, 'skillId')
    const skill = await Skill.findOneAndDelete({ skillId, userId: req.userId })
    if (!skill) throw new NotFoundError('Skill not found', 'skill_not_found')
    res.json({ success: true, message: 'Skill deleted' })
}))

module.exports = router
