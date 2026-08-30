// ═══════════════════════════════════════════════════════════════════════════
//  Sandbox routes — code execution via Docker isolation.
//
//  This is the ONLY supported code-execution path. The former in-process V8
//  `vm` executor was removed: `vm` is not a security boundary, and a trivial
//  `Object.constructor('return process')()` escaped it to read process.env.
// ═══════════════════════════════════════════════════════════════════════════

const express = require('express')
const router = express.Router()

const auth = require('../middleware/auth')
const { asyncHandler } = require('../utils/asyncHandler')
const v = require('../utils/validate')
const { sandboxLimiter } = require('../middleware/rateLimit')
const { runInSandbox, checkDocker, LANGS, MAX_CODE_LENGTH } = require('../utils/sandbox')

// Health / capability probe. Authenticated: the Docker server version is
// fingerprinting data with no value to an anonymous caller.
router.get('/api/sandbox/health', auth, asyncHandler(async (_req, res) => {
    const docker = await checkDocker()
    res.json({ service: 'sandbox', languages: LANGS, docker })
}))

router.post('/api/sandbox/run', auth, sandboxLimiter, asyncHandler(async (req, res) => {
    const code = v.str(req.body?.code, 'code', { max: MAX_CODE_LENGTH })
    const language = v.oneOf(req.body?.language ?? 'python', LANGS, 'language')
    const timeout = v.int(req.body?.timeout, 'timeout', { min: 1000, max: 30_000, required: false })

    const result = await runInSandbox({ language, code, timeoutMs: timeout })
    res.json({ success: !result.error, ...result })
}))

module.exports = router
