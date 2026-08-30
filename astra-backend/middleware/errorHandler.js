// ═══════════════════════════════════════════════════════════════════════════
//  Centralised error handling.
//
//  One place decides what the client sees. Anything that is not an explicitly
//  exposed AppError becomes a generic message plus a correlation id, so Mongo
//  schema paths, upstream URLs and stack traces stay server-side.
// ═══════════════════════════════════════════════════════════════════════════

const crypto = require('crypto')
const mongoose = require('mongoose')
const logger = require('../utils/logger')
const env = require('../config/env')
const { AppError, NotFoundError } = require('../utils/errors')

const log = logger.child('error')

/** Map well-known driver/library errors onto safe client-facing shapes. */
function normalize(err) {
    if (err instanceof AppError) return err

    // Mongoose: malformed ObjectId reaching findById
    if (err instanceof mongoose.Error.CastError) {
        return new AppError(`Invalid value for '${err.path}'`, { status: 400, code: 'invalid_id', expose: true })
    }
    if (err instanceof mongoose.Error.ValidationError) {
        const fields = Object.keys(err.errors || {}).join(', ')
        return new AppError(`Validation failed${fields ? `: ${fields}` : ''}`, { status: 400, code: 'validation_error', expose: true })
    }
    // Duplicate key — never echo the raw key, it can contain user data
    if (err.code === 11000) {
        return new AppError('Resource already exists', { status: 409, code: 'duplicate', expose: true })
    }
    // express.json() body parse failures
    if (err.type === 'entity.parse.failed') {
        return new AppError('Malformed JSON body', { status: 400, code: 'invalid_json', expose: true })
    }
    if (err.type === 'entity.too.large') {
        return new AppError('Request body too large', { status: 413, code: 'payload_too_large', expose: true })
    }
    // multer
    if (err.code === 'LIMIT_FILE_SIZE') {
        return new AppError('File too large', { status: 413, code: 'file_too_large', expose: true })
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT') {
        return new AppError('Unexpected file upload', { status: 400, code: 'invalid_upload', expose: true })
    }
    // CORS rejection raised by the origin callback
    if (err.code === 'cors_denied') {
        return new AppError('Origin not allowed', { status: 403, code: 'cors_denied', expose: true })
    }
    // Upstream fetch/abort
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
        return new AppError('Upstream request timed out', { status: 504, code: 'upstream_timeout', expose: true })
    }

    return new AppError(err.message || 'Internal server error', { status: err.status || 500, code: 'server_error', expose: false })
}

function notFound(req, _res, next) {
    next(new NotFoundError(`No route matches ${req.method} ${req.path}`, 'route_not_found'))
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
    const appErr = normalize(err)
    const status = appErr.status || 500
    const requestId = req.id || crypto.randomBytes(8).toString('hex')

    // 5xx is our fault and always logged with full context; 4xx is the
    // client's and logged at debug so scanners cannot flood the log.
    const payload = {
        requestId,
        method: req.method,
        path: req.path,
        status,
        code: appErr.code,
        ip: req.realIp || req.ip,
        userId: req.userId,
    }
    if (status >= 500) {
        log.error(appErr.message, { ...payload, stack: env.isProd ? undefined : appErr.stack })
    } else {
        log.debug(appErr.message, payload)
    }

    if (appErr.retryAfter) res.setHeader('Retry-After', String(appErr.retryAfter))

    // Headers already flushed (mid-SSE-stream): the connection is committed to
    // an event stream, so terminate it cleanly rather than appending JSON.
    if (res.headersSent) {
        try {
            if (res.writableEnded) return
            res.write(`event: error\ndata: ${JSON.stringify({ error: { code: appErr.code, requestId } })}\n\n`)
            res.write('data: [DONE]\n\n')
            res.end()
        } catch {
            try { res.destroy() } catch { /* socket already gone */ }
        }
        return
    }

    res.status(status).json({
        error: {
            message: appErr.expose ? appErr.message : 'Internal server error',
            code: appErr.code,
            ...(appErr.expose && appErr.meta?.field ? { field: appErr.meta.field } : {}),
            requestId,
        },
    })
}

module.exports = { errorHandler, notFound, notFoundHandler: notFound, normalize }
