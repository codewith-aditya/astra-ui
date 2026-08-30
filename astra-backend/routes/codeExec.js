// ═══════════════════════════════════════════════════════════════════════════
//  Code Interpreter — /api/code
//
//  SECURITY NOTE (why this file no longer uses node:vm)
//  ────────────────────────────────────────────────────
//  The previous implementation executed user code with `vm.runInContext()`
//  against a hand-built context that nulled `require`, `process` and `global`.
//  That is not a security boundary, and the nulling accomplishes nothing: any
//  host object reachable from inside the context is a bridge back out, because
//    Object.constructor === Function
//  and `Function('return process')()` evaluates in the *host* realm. A verified
//  escape read `process.env` (Mongo URI, admin secret, SMTP and provider keys)
//  and reached `require('child_process')`.
//
//  Two further problems: the `timeout` option only bounds *synchronous*
//  execution, so an async microtask loop ran unbounded and could exhaust the
//  heap and kill the API process; and V8 does not enforce a per-context memory
//  cap, so `memoryLimit` was advisory only.
//
//  All execution is therefore delegated to utils/sandbox.js, which runs code in
//  a throwaway Docker container: no network, non-root, read-only root
//  filesystem, dropped capabilities, and hard memory/CPU/pids/time limits.
//
//  The route surface and response shape are unchanged so existing clients keep
//  working. Python now genuinely executes instead of returning 501.
// ═══════════════════════════════════════════════════════════════════════════

const express = require('express')
const router = express.Router()

const auth = require('../middleware/auth')
const { adminGuard } = require('../middleware/adminGuard')
const { limiters } = require('../middleware/rateLimit')
const { asyncHandler } = require('../utils/asyncHandler')
const v = require('../utils/validate')
const logger = require('../utils/logger')
const Config = require('../models/Config')
const { runInSandbox } = require('../utils/sandbox')
const { BadRequestError, ForbiddenError } = require('../utils/errors')

const DEFAULT_TIMEOUT = 10_000
const MAX_TIMEOUT = 30_000
const DEFAULT_MEMORY_LIMIT = 256      // enforced by the container, not advisory
const MAX_STDOUT_LENGTH = 50_000
const MAX_CODE_LENGTH = 100_000
const SUPPORTED_LANGUAGES = ['javascript', 'python']
const CONFIG_KEY = 'codeExecConfig'

// Map the public language names onto sandbox runtimes.
const RUNTIME = { javascript: 'javascript', python: 'python' }

async function getUserConfig(userId) {
    const defaults = {
        timeout: DEFAULT_TIMEOUT,
        memoryLimit: DEFAULT_MEMORY_LIMIT,
        maxStdoutLength: MAX_STDOUT_LENGTH,
        allowedLanguages: ['javascript', 'python'],
        enabled: true,
    }
    try {
        const doc = await Config.findOne({ userId, key: CONFIG_KEY }).lean()
        if (!doc?.value || typeof doc.value !== 'object') return defaults
        return { ...defaults, ...doc.value }
    } catch (err) {
        logger.warn('codeExec.config.read_failed', { err: err.message })
        return defaults
    }
}

// ─── POST /api/code/execute ─────────────────────────────────────────────────
router.post('/api/code/execute', auth, limiters.sandbox, asyncHandler(async (req, res) => {
    const code = v.str(req.body.code, 'code', { max: MAX_CODE_LENGTH })
    const language = v.oneOf(req.body.language, SUPPORTED_LANGUAGES, 'language')

    const config = await getUserConfig(req.userId)
    if (config.enabled === false) {
        throw new ForbiddenError('Code execution is disabled', 'execution_disabled')
    }
    if (!config.allowedLanguages.includes(language)) {
        throw new ForbiddenError(
            `Language "${language}" is not allowed by your configuration`,
            'language_disabled'
        )
    }

    const requested = v.int(req.body.timeout, 'timeout', { min: 100, max: MAX_TIMEOUT })
    const timeoutMs = Math.min(requested || config.timeout || DEFAULT_TIMEOUT, MAX_TIMEOUT)

    const result = await runInSandbox({
        language: RUNTIME[language],
        code,
        timeoutMs,
        memoryMb: config.memoryLimit,
    })

    const cap = Math.min(config.maxStdoutLength || MAX_STDOUT_LENGTH, MAX_STDOUT_LENGTH)
    let stdout = result.stdout || ''
    if (stdout.length > cap) stdout = stdout.slice(0, cap) + '\n... [output truncated]'

    res.json({
        success: !result.error && !result.timedOut && result.exitCode === 0,
        result: {
            stdout,
            stderr: (result.stderr || '').slice(0, cap),
            result: null,               // container execution has no return value
            exitCode: result.exitCode ?? null,
            timedOut: Boolean(result.timedOut),
            error: result.error || null,
            executionTime: result.executionTime ?? null,
        },
    })
}))

// ─── GET /api/code/config ───────────────────────────────────────────────────
router.get('/api/code/config', auth, asyncHandler(async (req, res) => {
    const config = await getUserConfig(req.userId)
    res.json({
        success: true,
        config: {
            timeout: config.timeout,
            memoryLimit: config.memoryLimit,
            maxStdoutLength: config.maxStdoutLength,
            allowedLanguages: config.allowedLanguages,
            enabled: config.enabled,
        },
    })
}))

// ─── POST /api/code/config — admin only ─────────────────────────────────────
// adminGuard fails closed when ADMIN_SECRET is unset and compares in constant
// time; the previous inline check did neither consistently.
router.post('/api/code/config', auth, adminGuard, asyncHandler(async (req, res) => {
    const targetUserId = req.body.targetUserId
        ? v.id(req.body.targetUserId, 'targetUserId')
        : req.userId

    const updates = {}
    if (req.body.timeout !== undefined) {
        updates.timeout = v.int(req.body.timeout, 'timeout', { required: true, min: 100, max: MAX_TIMEOUT })
    }
    if (req.body.memoryLimit !== undefined) {
        updates.memoryLimit = v.int(req.body.memoryLimit, 'memoryLimit', { required: true, min: 16, max: 1024 })
    }
    if (req.body.maxStdoutLength !== undefined) {
        updates.maxStdoutLength = v.int(req.body.maxStdoutLength, 'maxStdoutLength', {
            required: true, min: 1000, max: 500_000,
        })
    }
    if (req.body.allowedLanguages !== undefined) {
        const langs = v.stringArray(req.body.allowedLanguages, 'allowedLanguages', { max: 8, maxLength: 20 })
        for (const l of langs) {
            if (!SUPPORTED_LANGUAGES.includes(l)) {
                throw new BadRequestError(
                    `allowedLanguages must contain only: ${SUPPORTED_LANGUAGES.join(', ')}`,
                    'invalid_input'
                )
            }
        }
        updates.allowedLanguages = langs
    }
    if (req.body.enabled !== undefined) {
        updates.enabled = v.bool(req.body.enabled, 'enabled')
    }

    if (Object.keys(updates).length === 0) {
        throw new BadRequestError('No valid config fields provided', 'invalid_input')
    }

    const existing = await getUserConfig(targetUserId)
    const merged = { ...existing, ...updates }

    await Config.findOneAndUpdate(
        { userId: targetUserId, key: CONFIG_KEY },
        { $set: { value: merged, updatedAt: new Date() } },
        { upsert: true, new: true }
    )

    logger.info('codeExec.config.updated', { targetUserId, fields: Object.keys(updates) })
    res.json({ success: true, message: 'Code execution config updated', config: merged })
}))

module.exports = router
