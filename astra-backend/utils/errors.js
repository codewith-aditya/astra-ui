// ═══════════════════════════════════════════════════════════════════════════
//  Typed application errors.
//
//  Routes throw these instead of hand-rolling res.status(...).json({ error:
//  err.message }). Only `expose: true` errors have their message shown to the
//  client; everything else surfaces as a generic message, so internal details
//  (Mongo schema paths, upstream URLs, stack traces) cannot leak.
// ═══════════════════════════════════════════════════════════════════════════

class AppError extends Error {
    constructor(message, { status = 500, code = 'server_error', expose = status < 500, meta } = {}) {
        super(message)
        this.name = this.constructor.name
        this.status = status
        this.code = code
        this.expose = expose
        this.meta = meta
        Error.captureStackTrace?.(this, this.constructor)
    }
}

class BadRequestError extends AppError {
    constructor(message = 'Invalid request', code = 'bad_request', meta) {
        super(message, { status: 400, code, expose: true, meta })
    }
}

class UnauthorizedError extends AppError {
    constructor(message = 'Authentication required', code = 'unauthorized') {
        super(message, { status: 401, code, expose: true })
    }
}

class ForbiddenError extends AppError {
    constructor(message = 'Forbidden', code = 'forbidden') {
        super(message, { status: 403, code, expose: true })
    }
}

class NotFoundError extends AppError {
    constructor(message = 'Not found', code = 'not_found') {
        super(message, { status: 404, code, expose: true })
    }
}

class ConflictError extends AppError {
    constructor(message = 'Conflict', code = 'conflict') {
        super(message, { status: 409, code, expose: true })
    }
}

class PayloadTooLargeError extends AppError {
    constructor(message = 'Payload too large', code = 'payload_too_large') {
        super(message, { status: 413, code, expose: true })
    }
}

class RateLimitError extends AppError {
    constructor(message = 'Too many requests', { retryAfter, code = 'rate_limit' } = {}) {
        super(message, { status: 429, code, expose: true })
        this.retryAfter = retryAfter
    }
}

class UpstreamError extends AppError {
    // Upstream failures carry provider URLs and raw bodies — never exposed.
    constructor(message = 'Upstream provider error', { status = 502, code = 'upstream_error', meta } = {}) {
        super(message, { status, code, expose: false, meta })
    }
}

class ServiceUnavailableError extends AppError {
    constructor(message = 'Service temporarily unavailable', code = 'unavailable') {
        super(message, { status: 503, code, expose: true })
    }
}

module.exports = {
    AppError,
    BadRequestError,
    UnauthorizedError,
    ForbiddenError,
    NotFoundError,
    ConflictError,
    PayloadTooLargeError,
    RateLimitError,
    UpstreamError,
    ServiceUnavailableError,
    // Alias: the HTTP name for the same 429 condition.
    TooManyRequestsError: RateLimitError,
}
