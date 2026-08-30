// ═══════════════════════════════════════════════════════════════════════════
//  Input coercion + validation.
//
//  Every value that reaches a Mongo query must pass through here first.
//  express.json() happily parses {"userId":{"$ne":null}}; handing that object
//  to findOne() turns an identifier lookup into an operator query that matches
//  an arbitrary document. Coercing to a primitive removes the entire class.
// ═══════════════════════════════════════════════════════════════════════════

const { BadRequestError } = require('./errors')

/**
 * Require a plain string. Rejects objects/arrays (the injection vector),
 * numbers and booleans (silent type confusion).
 */
function str(value, field, { required, allowEmpty = false, min = 1, max = 10_000, trim = true, pattern, lower = false } = {}) {
    if (required === undefined) required = !allowEmpty
    if (value === undefined || value === null || value === '') {
        if (required) throw new BadRequestError(`${field} is required`, 'missing_field', { field })
        return undefined
    }
    if (typeof value !== 'string') {
        throw new BadRequestError(`${field} must be a string`, 'invalid_type', { field })
    }
    let out = trim ? value.trim() : value
    if (lower) out = out.toLowerCase()
    if (required && out.length < min) {
        throw new BadRequestError(`${field} must be at least ${min} character(s)`, 'too_short', { field })
    }
    if (out.length > max) {
        throw new BadRequestError(`${field} must be at most ${max} characters`, 'too_long', { field })
    }
    if (pattern && !pattern.test(out)) {
        throw new BadRequestError(`${field} has an invalid format`, 'invalid_format', { field })
    }
    return out
}

/** Identifier-safe string: used for anything interpolated into a query. */
const ID_PATTERN = /^[A-Za-z0-9._:@-]{1,128}$/
function id(value, field, { required = true } = {}) {
    return str(value, field, { required, max: 128, pattern: ID_PATTERN })
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
function email(value, field = 'email', { required = true } = {}) {
    return str(value, field, { required, max: 254, lower: true, pattern: EMAIL_PATTERN })
}

const OTP_PATTERN = /^\d{6}$/
function otp(value, field = 'otp') {
    return str(value, field, { required: true, min: 6, max: 6, pattern: OTP_PATTERN })
}

/** Mongo ObjectId — validated before findById to avoid an uncaught CastError. */
const OBJECT_ID_PATTERN = /^[a-fA-F0-9]{24}$/
function objectId(value, field) {
    return str(value, field, { required: true, min: 24, max: 24, pattern: OBJECT_ID_PATTERN })
}

function int(value, field, { required = false, min, max, fallback } = {}) {
    if (value === undefined || value === null || value === '') {
        if (required) throw new BadRequestError(`${field} is required`, 'missing_field', { field })
        return fallback
    }
    const n = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(n)) {
        throw new BadRequestError(`${field} must be a number`, 'invalid_type', { field })
    }
    const rounded = Math.trunc(n)
    if (min !== undefined && rounded < min) {
        throw new BadRequestError(`${field} must be >= ${min}`, 'out_of_range', { field })
    }
    if (max !== undefined && rounded > max) {
        throw new BadRequestError(`${field} must be <= ${max}`, 'out_of_range', { field })
    }
    return rounded
}

/** Clamp instead of reject — for pagination where a silly value is harmless. */
function clampInt(value, { min, max, fallback }) {
    const n = typeof value === 'number' ? value : parseInt(value, 10)
    if (!Number.isFinite(n)) return fallback
    return Math.min(Math.max(Math.trunc(n), min), max)
}

function bool(value, field, { fallback = undefined } = {}) {
    if (value === undefined || value === null || value === '') return fallback
    if (typeof value === 'boolean') return value
    if (value === 'true' || value === '1' || value === 1) return true
    if (value === 'false' || value === '0' || value === 0) return false
    throw new BadRequestError(`${field} must be a boolean`, 'invalid_type', { field })
}

function oneOf(value, a, b, { required = true, fallback } = {}) {
    // Accept either (value, field, allowed[]) or (value, allowed[], field).
    const allowed = Array.isArray(a) ? a : b
    const field = Array.isArray(a) ? b : a
    if (value === undefined || value === null || value === '') {
        if (required) throw new BadRequestError(`${field} is required`, 'missing_field', { field })
        return fallback
    }
    if (typeof value !== 'string' || !allowed.includes(value)) {
        throw new BadRequestError(`${field} must be one of: ${allowed.join(', ')}`, 'invalid_value', { field })
    }
    return value
}

function stringArray(value, field, { max = 50, maxLength = 200, required = false } = {}) {
    if (value === undefined || value === null) {
        if (required) throw new BadRequestError(`${field} is required`, 'missing_field', { field })
        return []
    }
    if (!Array.isArray(value)) {
        throw new BadRequestError(`${field} must be an array`, 'invalid_type', { field })
    }
    if (value.length > max) {
        throw new BadRequestError(`${field} may contain at most ${max} items`, 'too_many', { field })
    }
    return value.map((v, i) => str(v, `${field}[${i}]`, { max: maxLength }))
}

/**
 * Reject Mongo operators and prototype-pollution keys anywhere in a payload
 * that will be persisted as a free-form object (e.g. tool valves, configs).
 */
const FORBIDDEN_KEY = /^(\$|__proto__$|constructor$|prototype$)/
function safeObject(value, field, { maxKeys = 100, depth = 0 } = {}) {
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new BadRequestError(`${field} must be a JSON object`, 'invalid_type', { field })
    }
    if (depth > 8) throw new BadRequestError(`${field} is nested too deeply`, 'too_deep', { field })

    const keys = Object.keys(value)
    if (keys.length > maxKeys) {
        throw new BadRequestError(`${field} has too many keys (max ${maxKeys})`, 'too_many_keys', { field })
    }

    const out = Object.create(null)
    for (const k of keys) {
        if (FORBIDDEN_KEY.test(k)) {
            throw new BadRequestError(`${field} contains a forbidden key`, 'forbidden_key', { field })
        }
        const v = value[k]
        out[k] = (v && typeof v === 'object' && !Array.isArray(v))
            ? safeObject(v, `${field}.${k}`, { maxKeys, depth: depth + 1 })
            : v
    }
    return { ...out }
}

/**
 * Strip Mongo operators from an already-built query object. Defence in depth
 * for the few places that must accept a caller-shaped filter.
 */
function sanitizeQuery(obj) {
    if (!obj || typeof obj !== 'object') return obj
    for (const k of Object.keys(obj)) {
        if (FORBIDDEN_KEY.test(k)) { delete obj[k]; continue }
        const v = obj[k]
        if (v && typeof v === 'object' && !Array.isArray(v)) sanitizeQuery(v)
    }
    return obj
}


/**
 * Password policy. Deliberately length-first (NIST 800-63B) rather than
 * composition rules: a long passphrase beats a short one with a symbol in it.
 * The upper bound exists because bcrypt silently truncates past 72 bytes.
 */
function password(value, field = 'password', { min = 8 } = {}) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new BadRequestError(`${field} is required`, 'missing_field', { field })
    }
    if (value.length < min) {
        throw new BadRequestError(`${field} must be at least ${min} characters`, 'weak_password', { field })
    }
    if (Buffer.byteLength(value, 'utf8') > 72) {
        throw new BadRequestError(`${field} must be at most 72 bytes`, 'too_long', { field })
    }
    if (value.trim().length === 0) {
        throw new BadRequestError(`${field} cannot be only whitespace`, 'weak_password', { field })
    }
    return value
}

/**
 * Validate an absolute http(s) URL. Returns the parsed URL string.
 * Note: this is a *syntactic* check only. Anything that will actually be
 * fetched server-side must additionally pass through utils/safeFetch.js,
 * which resolves DNS and rejects private address space.
 */
function httpUrl(value, field = 'url', { required = true, allowEmpty = false, max = 2048 } = {}) {
    if (value === undefined || value === null || value === '') {
        if (required && !allowEmpty) throw new BadRequestError(`${field} is required`, 'missing_field', { field })
        return ''
    }
    if (typeof value !== 'string') {
        throw new BadRequestError(`${field} must be a string`, 'invalid_type', { field })
    }
    const trimmed = value.trim()
    if (trimmed.length > max) {
        throw new BadRequestError(`${field} must be at most ${max} characters`, 'too_long', { field })
    }
    let parsed
    try { parsed = new URL(trimmed) } catch {
        throw new BadRequestError(`${field} is not a valid absolute URL`, 'invalid_url', { field })
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new BadRequestError(`${field} must use http or https`, 'invalid_url_scheme', { field })
    }
    return parsed.toString()
}

module.exports = {
    str, id, email, otp, objectId, password, httpUrl,
    int, clampInt, bool, oneOf, stringArray,
    safeObject, sanitizeQuery,
    patterns: { ID_PATTERN, EMAIL_PATTERN, OTP_PATTERN, OBJECT_ID_PATTERN },
}
