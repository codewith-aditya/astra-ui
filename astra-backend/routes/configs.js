// ═══════════════════════════════════════════════════════════════════════════
//  Server-side user configuration.
//
//  Route order matters here: the literal '/default' routes MUST be registered
//  before the '/:key' parameterised routes. Previously '/:key' was declared
//  first, so GET /api/configs/default matched it with key === 'default' and the
//  dedicated global-defaults handler below was unreachable.
// ═══════════════════════════════════════════════════════════════════════════

const express = require('express')
const router = express.Router()

const Config = require('../models/Config')
const auth = require('../middleware/auth')
const { adminGuard } = require('../middleware/adminGuard')
const { asyncHandler } = require('../utils/asyncHandler')
const v = require('../utils/validate')

const DEFAULT_SCOPE = '__default__'
const MAX_KEYS_PER_REQUEST = 100

// A user cannot address the global defaults scope through the per-user routes.
function ownKey(req) {
    const key = v.id(req.params.key, 'key')
    if (key === DEFAULT_SCOPE) {
        // Not an error worth distinguishing — treat as an ordinary miss.
        return null
    }
    return key
}

function toMap(docs) {
    const map = {}
    for (const doc of docs) map[doc.key] = doc.value
    return map
}

// Build bulk upsert operations from a validated config object.
function buildOps(scope, configs) {
    return Object.entries(configs).map(([key, value]) => ({
        updateOne: {
            filter: { userId: scope, key: v.id(key, `configs.${key}`) },
            update: { $set: { value, updatedAt: new Date() } },
            upsert: true,
        },
    }))
}

// ─── Global defaults (literal paths first) ──────────────────────────────────

// Public read: the frontend needs defaults before a user signs in.
router.get('/api/configs/default', asyncHandler(async (_req, res) => {
    const configs = await Config.find({ userId: DEFAULT_SCOPE }).lean()
    res.json({ success: true, configs: toMap(configs) })
}))

// Admin write. Previously guarded by `if (adminSecret && ...)`, which skipped
// the check entirely whenever ADMIN_SECRET was unset or empty — leaving global
// defaults writable by any authenticated caller.
router.post('/api/configs/default', auth, adminGuard, asyncHandler(async (req, res) => {
    const configs = v.safeObject(req.body?.configs, 'configs', { maxKeys: MAX_KEYS_PER_REQUEST })
    if (!configs) {
        res.json({ success: true, message: 'No changes' })
        return
    }

    const ops = buildOps(DEFAULT_SCOPE, configs)
    if (ops.length) await Config.bulkWrite(ops)

    res.json({ success: true, message: 'Default configs saved' })
}))

// ─── Per-user configuration ─────────────────────────────────────────────────

router.get('/api/configs', auth, asyncHandler(async (req, res) => {
    const configs = await Config.find({ userId: req.userId }).lean()
    res.json({ success: true, configs: toMap(configs) })
}))

router.post('/api/configs', auth, asyncHandler(async (req, res) => {
    const configs = v.safeObject(req.body?.configs, 'configs', { maxKeys: MAX_KEYS_PER_REQUEST })
    if (!configs) {
        res.json({ success: true, message: 'No changes' })
        return
    }

    const ops = buildOps(req.userId, configs)
    if (ops.length) await Config.bulkWrite(ops)

    res.json({ success: true, message: 'Configs saved' })
}))

router.get('/api/configs/:key', auth, asyncHandler(async (req, res) => {
    const key = ownKey(req)
    if (!key) {
        res.json({ success: true, value: null })
        return
    }
    const config = await Config.findOne({ userId: req.userId, key }).lean()
    res.json({ success: true, value: config ? config.value : null })
}))

router.put('/api/configs/:key', auth, asyncHandler(async (req, res) => {
    const key = ownKey(req)
    if (!key) {
        res.status(403).json({ error: { message: 'Reserved key', code: 'reserved_key' } })
        return
    }
    // `value` is free-form by design, but must not smuggle Mongo operators or
    // prototype-pollution keys into a persisted document.
    const raw = req.body?.value
    const value = raw && typeof raw === 'object' && !Array.isArray(raw)
        ? v.safeObject(raw, 'value', { maxKeys: MAX_KEYS_PER_REQUEST })
        : raw

    await Config.findOneAndUpdate(
        { userId: req.userId, key },
        { $set: { value, updatedAt: new Date() } },
        { upsert: true, new: true }
    )
    res.json({ success: true, message: 'Config saved' })
}))

router.delete('/api/configs/:key', auth, asyncHandler(async (req, res) => {
    const key = ownKey(req)
    if (!key) {
        res.status(403).json({ error: { message: 'Reserved key', code: 'reserved_key' } })
        return
    }
    await Config.findOneAndDelete({ userId: req.userId, key })
    res.json({ success: true, message: 'Config deleted' })
}))

module.exports = router
