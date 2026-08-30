// ═══════════════════════════════════════════════════════════════════════════
//  asyncHandler — forwards rejected promises to Express's error handler.
//
//  Express 4 does not catch rejections from async middleware; an unhandled
//  rejection leaves the request hanging until the client times out. Wrapping
//  every async route means one error handler formats every failure.
// ═══════════════════════════════════════════════════════════════════════════

function asyncHandler(fn) {
    return function wrapped(req, res, next) {
        Promise.resolve(fn(req, res, next)).catch(next)
    }
}

/**
 * Fire-and-forget background work. Rejections are logged rather than becoming
 * unhandled rejections that take the process down under Node's default policy.
 */
function background(label, fn) {
    setImmediate(() => {
        Promise.resolve()
            .then(fn)
            .catch(err => {
                // Required lazily: logger pulls config/env, which may not be
                // validated at module-load time in tests.
                require('./logger').error(`[background:${label}] failed`, err)
            })
    })
}

module.exports = { asyncHandler, background }
