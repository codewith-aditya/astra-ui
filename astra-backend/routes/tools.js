// ═══════════════════════════════════════════════════════════════════════════
//  Tools — user-defined code snippets, executed in the Docker sandbox.
//
//  Two security fixes relative to the previous version:
//
//  1. Ownership. `/execute` looked the tool up with no userId filter, then
//     guarded with `tool.userId !== req.userId && !tool.isActive`. That branch
//     was unreachable because the preceding `!tool.isActive` check had already
//     returned, so ANY authenticated caller could execute ANY active tool
//     belonging to anyone else — running the owner's stored code with
//     attacker-chosen input. Execution is now owner-only.
//
//  2. Input injection. Input was interpolated into generated source with
//     JSON.stringify, which escapes for JSON — not for Python triple-quoted
//     strings or POSIX shell. An input containing ''' or a single quote closed
//     the literal early and the remainder ran as code. Input now travels in an
//     environment variable and is parsed by the program at runtime.
// ═══════════════════════════════════════════════════════════════════════════

const express = require('express')
const router = express.Router()

const Tool = require('../models/Tool')
const auth = require('../middleware/auth')
const { asyncHandler } = require('../utils/asyncHandler')
const { sandboxLimiter, writeLimiter } = require('../middleware/rateLimit')
const { runInSandbox, LANGS } = require('../utils/sandbox')
const v = require('../utils/validate')
const { BadRequestError, ForbiddenError, NotFoundError } = require('../utils/errors')

const MAX_TOOLS_PER_USER = 100

// Prologue that reads input from the environment instead of the source text.
function buildToolProgram(language, body) {
    switch (language) {
        case 'python':
        case 'py':
            return [
                'import json, os',
                'TOOL_INPUT = json.loads(os.environ.get("TOOL_INPUT_JSON") or "null")',
                '',
                body,
            ].join('\n')

        case 'javascript':
        case 'node':
        case 'js':
            return [
                'const TOOL_INPUT = JSON.parse(process.env.TOOL_INPUT_JSON || "null");',
                '',
                body,
            ].join('\n')

        case 'bash':
        case 'sh':
            // Quoted parameter expansion: the value is never re-parsed as code.
            return [
                'TOOL_INPUT="${TOOL_INPUT_JSON:-null}"',
                '',
                body,
            ].join('\n')

        default:
            return body
    }
}

// ─── GET /api/tools ──────────────────────────────────────────────────────────
router.get('/api/tools', auth, asyncHandler(async (req, res) => {
    const filter = {}

    if (req.query.userId !== undefined) {
        const requested = v.id(req.query.userId, 'userId')
        if (requested !== req.userId) {
            throw new ForbiddenError('You may only list your own tools', 'not_owner')
        }
        filter.userId = requested
    } else {
        filter.$or = [{ userId: req.userId }, { isActive: true }]
    }

    const tools = await Tool.find(filter).sort({ createdAt: -1 }).limit(500)
    res.json({ success: true, data: tools })
}))

// ─── POST /api/tools ─────────────────────────────────────────────────────────
router.post('/api/tools', auth, writeLimiter, asyncHandler(async (req, res) => {
    const name = v.str(req.body.name, 'name', { max: 100 })
    const description = v.str(req.body.description, 'description', { max: 2000, allowEmpty: true }) || ''
    const content = v.str(req.body.content, 'content', { max: 50_000, allowEmpty: true }) || ''
    const specs = Array.isArray(req.body.specs) ? req.body.specs.slice(0, 20) : []
    const meta = v.safeObject(req.body.meta, 'meta') || {}

    const count = await Tool.countDocuments({ userId: req.userId })
    if (count >= MAX_TOOLS_PER_USER) {
        throw new BadRequestError(`Maximum ${MAX_TOOLS_PER_USER} tools allowed per user`, 'tool_limit_reached')
    }

    const tool = await Tool.create({
        userId: req.userId, name, description, content, specs, meta,
    })
    res.status(201).json({ success: true, data: tool })
}))

// ─── GET /api/tools/:id ──────────────────────────────────────────────────────
router.get('/api/tools/:id', auth, asyncHandler(async (req, res) => {
    const toolId = v.id(req.params.id, 'toolId')
    const tool = await Tool.findOne({ toolId })
    if (!tool) throw new NotFoundError('Tool not found', 'tool_not_found')

    if (tool.userId !== req.userId && !tool.isActive) {
        throw new ForbiddenError('Tool is not accessible', 'tool_not_accessible')
    }
    res.json({ success: true, data: tool })
}))

// ─── PUT /api/tools/:id ──────────────────────────────────────────────────────
router.put('/api/tools/:id', auth, writeLimiter, asyncHandler(async (req, res) => {
    const toolId = v.id(req.params.id, 'toolId')
    const update = { updatedAt: new Date() }

    if (req.body.name !== undefined) update.name = v.str(req.body.name, 'name', { max: 100 })
    if (req.body.description !== undefined) {
        update.description = v.str(req.body.description, 'description', { max: 2000, allowEmpty: true }) || ''
    }
    if (req.body.content !== undefined) {
        update.content = v.str(req.body.content, 'content', { max: 50_000, allowEmpty: true }) || ''
    }
    if (req.body.specs !== undefined) {
        update.specs = Array.isArray(req.body.specs) ? req.body.specs.slice(0, 20) : []
    }
    if (req.body.meta !== undefined) update.meta = v.safeObject(req.body.meta, 'meta') || {}
    if (req.body.isActive !== undefined) update.isActive = Boolean(req.body.isActive)

    const updated = await Tool.findOneAndUpdate(
        { toolId, userId: req.userId },
        update,
        { new: true }
    )
    if (!updated) throw new NotFoundError('Tool not found or not owned by you', 'tool_not_found')

    res.json({ success: true, data: updated })
}))

// ─── DELETE /api/tools/:id ───────────────────────────────────────────────────
router.delete('/api/tools/:id', auth, writeLimiter, asyncHandler(async (req, res) => {
    const toolId = v.id(req.params.id, 'toolId')
    const deleted = await Tool.findOneAndDelete({ toolId, userId: req.userId })
    if (!deleted) throw new NotFoundError('Tool not found or not owned by you', 'tool_not_found')
    res.json({ success: true })
}))

// ─── POST /api/tools/:id/execute ─────────────────────────────────────────────
router.post('/api/tools/:id/execute', auth, sandboxLimiter, asyncHandler(async (req, res) => {
    const toolId = v.id(req.params.id, 'toolId')
    const tool = await Tool.findOne({ toolId })
    if (!tool) throw new NotFoundError('Tool not found', 'tool_not_found')

    // Owner-only: running someone else's stored code is not a read operation.
    if (tool.userId !== req.userId) {
        throw new ForbiddenError('You may only execute your own tools', 'not_tool_owner')
    }
    if (!tool.isActive) {
        throw new BadRequestError('Tool is not active', 'tool_inactive')
    }
    if (!tool.content || !tool.content.trim()) {
        throw new BadRequestError('Tool has no executable content', 'empty_tool')
    }

    const language = v.oneOf(
        String(req.body?.language || tool.meta?.language || 'python').toLowerCase(),
        LANGS,
        'language'
    )
    const input = req.body?.input === undefined ? null : req.body.input

    const startedAt = Date.now()
    const result = await runInSandbox({
        language,
        code: buildToolProgram(language, tool.content),
        timeoutMs: tool.meta?.timeout,
        env: { TOOL_INPUT_JSON: JSON.stringify(input) },
    })
    const executionTime = Date.now() - startedAt

    res.json({
        success: true,
        data: {
            toolId: tool.toolId,
            toolName: tool.name,
            language,
            input,
            output: result.stdout || '',
            stderr: result.stderr || '',
            exitCode: result.exitCode ?? null,
            timedOut: Boolean(result.timedOut),
            error: result.error || null,
            executedAt: new Date().toISOString(),
            executionTime,
            status: result.error || result.timedOut
                ? 'error'
                : (result.exitCode === 0 ? 'success' : 'failed'),
        },
    })
}))

// ─── GET /api/tools/:id/valves ───────────────────────────────────────────────
router.get('/api/tools/:id/valves', auth, asyncHandler(async (req, res) => {
    const toolId = v.id(req.params.id, 'toolId')
    const tool = await Tool.findOne({ toolId, userId: req.userId })
    if (!tool) throw new NotFoundError('Tool not found or not owned by you', 'tool_not_found')
    res.json({ success: true, data: { toolId: tool.toolId, valves: tool.valves || {} } })
}))

// ─── POST /api/tools/:id/valves ──────────────────────────────────────────────
router.post('/api/tools/:id/valves', auth, writeLimiter, asyncHandler(async (req, res) => {
    const toolId = v.id(req.params.id, 'toolId')
    const valves = v.safeObject(req.body.valves, 'valves')
    if (valves === undefined) {
        throw new BadRequestError('valves must be a JSON object', 'invalid_valves')
    }

    const updated = await Tool.findOneAndUpdate(
        { toolId, userId: req.userId },
        { valves, updatedAt: new Date() },
        { new: true }
    )
    if (!updated) throw new NotFoundError('Tool not found or not owned by you', 'tool_not_found')

    res.json({ success: true, data: { toolId: updated.toolId, valves: updated.valves } })
}))

module.exports = router
