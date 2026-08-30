// ═══════════════════════════════════════════════════════════════════════════
//  Docker Sandbox Executor — runs untrusted code in a throwaway container.
//
//  Container isolation is the security boundary: no network, non-root,
//  read-only root filesystem, all capabilities dropped, and hard limits on
//  memory, CPU, process count, file size and wall-clock time.
//
//  The pattern blocklist below is defence-in-depth only. It is trivially
//  bypassable (`$(echo rm) -rf /`, base64 → eval) and must never be relied on;
//  it exists to fail obvious mistakes fast, not to contain an attacker.
// ═══════════════════════════════════════════════════════════════════════════

const { spawn } = require('child_process')
const fsp = require('fs/promises')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const logger = require('./logger')

const LANGS = {
    python:     { image: process.env.SANDBOX_IMG_PY   || 'python:3.12-slim', file: 'main.py', run: f => ['python', f] },
    py:         { image: process.env.SANDBOX_IMG_PY   || 'python:3.12-slim', file: 'main.py', run: f => ['python', f] },
    javascript: { image: process.env.SANDBOX_IMG_NODE || 'node:20-alpine',   file: 'main.js', run: f => ['node', f] },
    node:       { image: process.env.SANDBOX_IMG_NODE || 'node:20-alpine',   file: 'main.js', run: f => ['node', f] },
    js:         { image: process.env.SANDBOX_IMG_NODE || 'node:20-alpine',   file: 'main.js', run: f => ['node', f] },
    bash:       { image: process.env.SANDBOX_IMG_SH   || 'alpine:3.20',      file: 'main.sh', run: f => ['sh', f] },
    sh:         { image: process.env.SANDBOX_IMG_SH   || 'alpine:3.20',      file: 'main.sh', run: f => ['sh', f] },
}

const MAX_OUTPUT = 50_000
const MAX_CODE_BYTES = 100_000
const DEFAULT_TIMEOUT = 10_000
const MAX_TIMEOUT = 30_000
const DEFAULT_MEMORY_MB = 256
const MAX_MEMORY_MB = 1024
const KILL_GRACE_MS = 5_000
// Argument lists have a kernel-level size ceiling (ARG_MAX); a caller-supplied
// value must not be able to push the docker invocation past it.
const MAX_ENV_VALUE_BYTES = 32_000

// Concurrency cap: each container reserves real memory and CPU, so an
// unbounded spawn rate is a denial-of-service vector against the host.
const MAX_CONCURRENT = parseInt(process.env.SANDBOX_MAX_CONCURRENT || '4', 10)
let running = 0

const BLOCKED_PATTERNS = [
    { re: /rm\s+-rf?\s+(\/|\$HOME|~)/i,           name: 'recursive root delete' },
    { re: /:\s*\(\s*\)\s*\{[^}]*\}\s*;?\s*:/,     name: 'fork bomb' },
    { re: /\bdd\s+if=/i,                          name: 'raw disk write' },
    { re: /\bmkfs\b/i,                            name: 'filesystem format' },
    { re: /\b(shutdown|reboot|halt|poweroff)\b/i,  name: 'system power command' },
    { re: /\/etc\/(shadow|sudoers)/i,             name: 'sensitive file access' },
    { re: /\bchmod\s+-R\s+777\s+\//i,             name: 'recursive world-writable root' },
]

function precheck(code) {
    for (const p of BLOCKED_PATTERNS) if (p.re.test(code)) return p.name
    return null
}

async function cleanup(dir) {
    try { await fsp.rm(dir, { recursive: true, force: true }) }
    catch (err) { logger.warn('sandbox.cleanup_failed', { dir, err: err.message }) }
}

/** Force-remove a container, logging failures instead of ignoring them. */
function forceRemove(name) {
    return new Promise(resolve => {
        const p = spawn('docker', ['rm', '-f', name], { stdio: 'ignore' })
        const t = setTimeout(() => { try { p.kill('SIGKILL') } catch { /* gone */ } resolve(false) }, KILL_GRACE_MS)
        p.on('error', () => { clearTimeout(t); resolve(false) })
        p.on('close', code => {
            clearTimeout(t)
            if (code !== 0) logger.warn('sandbox.container_remove_failed', { name, code })
            resolve(code === 0)
        })
    })
}

/**
 * Run code inside an isolated Docker container.
 * Never throws; failures are reported in the resolved object.
 */
/**
 * Build `-e KEY=value` arguments for the container.
 *
 * Values are passed as separate argv entries (never through a shell), so a
 * value cannot break out into another flag. Names are restricted to a
 * conservative identifier shape because `-e` splits on the first `=`: a name
 * containing `=` would otherwise smuggle in a second variable.
 */
function envArgs(env) {
    if (!env || typeof env !== 'object') return []
    const out = []
    for (const [key, raw] of Object.entries(env)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
            logger.warn('sandbox.env_name_rejected', { key: String(key).slice(0, 64) })
            continue
        }
        const value = String(raw ?? '')
        // A NUL byte truncates the value at the execve boundary.
        if (value.includes('\u0000')) {
            logger.warn('sandbox.env_value_rejected', { key })
            continue
        }
        if (Buffer.byteLength(value, 'utf8') > MAX_ENV_VALUE_BYTES) {
            logger.warn('sandbox.env_value_too_large', { key })
            continue
        }
        out.push('-e', `${key}=${value}`)
    }
    return out
}

async function runInSandbox({ language = 'python', code = '', timeoutMs, memoryMb, env } = {}) {
    const lang = LANGS[String(language).toLowerCase()]
    if (!lang) return { error: `Unsupported language: ${language}` }
    if (typeof code !== 'string' || !code.trim()) return { error: 'No code provided' }
    if (Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) {
        return { error: `Code too large (max ${MAX_CODE_BYTES} bytes)` }
    }

    const blocked = precheck(code)
    if (blocked) return { error: `Blocked: ${blocked}`, blocked }

    if (running >= MAX_CONCURRENT) {
        return { error: 'Sandbox is busy — too many concurrent executions. Try again shortly.', busy: true }
    }

    const timeout = Math.min(Math.max(parseInt(timeoutMs, 10) || DEFAULT_TIMEOUT, 1000), MAX_TIMEOUT)
    const memory = Math.min(Math.max(parseInt(memoryMb, 10) || DEFAULT_MEMORY_MB, 16), MAX_MEMORY_MB)

    running += 1
    const startedAt = Date.now()
    let dir
    try {
        dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'astra-sbx-'))
        await fsp.writeFile(path.join(dir, lang.file), code, { encoding: 'utf8', mode: 0o644 })

        const name = 'sbx_' + crypto.randomBytes(8).toString('hex')
        const args = [
            'run', '--rm', '--name', name,
            ...envArgs(env),
            '--network', 'none',
            '--memory', `${memory}m`, '--memory-swap', `${memory}m`,
            '--cpus', '0.5',
            '--pids-limit', '128',
            '--cap-drop', 'ALL',
            '--security-opt', 'no-new-privileges',
            '--read-only',
            '--tmpfs', '/tmp:rw,size=64m,mode=1777',
            '--ulimit', 'fsize=10000000:10000000',
            '--ulimit', 'nofile=256:256',
            '--user', '1000:1000',
            '-v', `${dir}:/sandbox:ro`,
            '-w', '/sandbox',
            lang.image,
            ...lang.run('/sandbox/' + lang.file),
        ]

        const result = await new Promise(resolve => {
            let stdout = '', stderr = '', timedOut = false, settled = false
            const child = spawn('docker', args)

            const finish = payload => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                resolve(payload)
            }

            const timer = setTimeout(async () => {
                timedOut = true
                await forceRemove(name)
                try { child.kill('SIGKILL') } catch { /* already gone */ }
            }, timeout)

            // Truncate on the way in so a single large chunk cannot blow past
            // the cap: the old check ran before appending, so one big write
            // could land in full.
            child.stdout.on('data', d => {
                if (stdout.length < MAX_OUTPUT) stdout = (stdout + d.toString()).slice(0, MAX_OUTPUT)
            })
            child.stderr.on('data', d => {
                if (stderr.length < MAX_OUTPUT) stderr = (stderr + d.toString()).slice(0, MAX_OUTPUT)
            })

            child.on('error', err => {
                const missing = err.code === 'ENOENT'
                finish({
                    error: missing
                        ? 'Sandbox unavailable: Docker is not installed or not on PATH.'
                        : `Sandbox unavailable: ${err.message}`,
                    dockerMissing: missing,
                })
            })

            child.on('close', exitCode => {
                finish({
                    stdout,
                    stderr: timedOut
                        ? (stderr ? stderr + '\n' : '') + `[timed out after ${timeout}ms]`
                        : stderr,
                    exitCode: timedOut ? null : exitCode,
                    timedOut,
                })
            })
        })

        return { ...result, executionTime: Date.now() - startedAt }
    } catch (err) {
        logger.error('sandbox.setup_failed', { err: err.message })
        return { error: 'Failed to prepare sandbox workspace', executionTime: Date.now() - startedAt }
    } finally {
        running -= 1
        if (dir) await cleanup(dir)
    }
}

/** Is the Docker daemon reachable? */
function checkDocker() {
    return new Promise(resolve => {
        const p = spawn('docker', ['version', '--format', '{{.Server.Version}}'])
        let out = ''
        const timer = setTimeout(() => { try { p.kill('SIGKILL') } catch { /* gone */ } resolve({ ok: false, error: 'timeout' }) }, 5000)
        p.stdout.on('data', d => { out += d.toString() })
        p.on('error', () => { clearTimeout(timer); resolve({ ok: false, error: 'docker not found' }) })
        p.on('close', code => {
            clearTimeout(timer)
            resolve(code === 0 ? { ok: true, version: out.trim() } : { ok: false })
        })
    })
}

/**
 * Pre-pull the runtime images. Without this the first execution of each
 * language pays the image download inside its own short timeout and fails.
 * Called once at boot; failures are non-fatal.
 */
async function warmImages() {
    const images = [...new Set(Object.values(LANGS).map(l => l.image))]
    const docker = await checkDocker()
    if (!docker.ok) {
        logger.warn('sandbox.docker_unavailable — code execution will be disabled')
        return { ok: false, images: [] }
    }
    const pulled = []
    for (const image of images) {
        const ok = await new Promise(resolve => {
            const p = spawn('docker', ['image', 'inspect', image], { stdio: 'ignore' })
            p.on('error', () => resolve(false))
            p.on('close', code => resolve(code === 0))
        })
        if (ok) { pulled.push(image); continue }
        logger.info('sandbox.pulling_image', { image })
        const done = await new Promise(resolve => {
            const p = spawn('docker', ['pull', image], { stdio: 'ignore' })
            p.on('error', () => resolve(false))
            p.on('close', code => resolve(code === 0))
        })
        if (done) pulled.push(image)
        else logger.warn('sandbox.image_pull_failed', { image })
    }
    return { ok: true, images: pulled }
}

module.exports = {
    runInSandbox,
    checkDocker,
    warmImages,
    LANGS: Object.keys(LANGS),
    MAX_CONCURRENT,
    MAX_CODE_BYTES,
    MAX_CODE_LENGTH: MAX_CODE_BYTES,
    MAX_TIMEOUT,

    // Exposed for unit tests only.
    __test: { envArgs, precheck },
}
