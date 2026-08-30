// ═══════════════════════════════════════════════════════════════════════════
//  Module load check.
//
//  Requires every module in the backend and reports anything that fails to
//  parse or resolve. This is the cheapest possible guard against the failure
//  mode that previously crash-looped the deployment: a require-time
//  MODULE_NOT_FOUND that only surfaces when the process boots.
//
//  Run with: npm run check:modules
// ═══════════════════════════════════════════════════════════════════════════

process.env.NODE_ENV = process.env.NODE_ENV || 'test'
process.env.JWT_SECRET = process.env.JWT_SECRET || 'verify-only-secret-at-least-32-characters'
process.env.ADMIN_SECRET = process.env.ADMIN_SECRET || 'verify-only-admin-secret'
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/verify'
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:5173'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const SKIP_DIRS = new Set(['node_modules', '.git', 'uploads', 'public', 'scripts', 'test'])

function collect(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue
            collect(full, out)
        } else if (entry.name.endsWith('.js')) {
            out.push(full)
        }
    }
    return out
}

const files = collect(ROOT).sort()
const failures = []

for (const file of files) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/')
    try {
        require(file)
    } catch (err) {
        failures.push({ rel, message: err.message })
    }
}

console.log(`\nLoaded ${files.length - failures.length}/${files.length} modules`)

if (failures.length) {
    console.log(`\n${failures.length} FAILED:\n`)
    for (const f of failures) console.log(`  x ${f.rel}\n      ${f.message}`)
} else {
    console.log('All modules loaded cleanly.')
}

// Requiring server.js registers a Socket.IO instance and timers that keep the
// event loop alive even though no listener was started, so exit explicitly.
process.exit(failures.length ? 1 : 0)
