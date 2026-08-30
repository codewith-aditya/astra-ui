// ═══════════════════════════════════════════════════════════════════════════
//  SSRF-resistant fetch.
//
//  The previous guard compared the hostname against a list of string prefixes
//  ('10.', '192.168.', '172.', 'localhost', ...). That is bypassable in at
//  least five ways, all of which reach the metadata service or an internal
//  admin port:
//
//    http://2130706433/          decimal-encoded 127.0.0.1
//    http://0x7f.0.0.1/          hex-encoded
//    http://127.1/              short form
//    http://[::ffff:127.0.0.1]/  IPv4-mapped IPv6
//    http://attacker.tld/        public name whose A record is 169.254.169.254
//
//  The last one defeats *any* purely textual check, so this module resolves DNS
//  and validates the resulting IP addresses instead of the string. It also
//  follows redirects manually, re-validating each hop, because a public URL is
//  free to 302 to an internal one.
//
//  The prefix list was additionally wrong in both directions: it blocked all of
//  172.x (only 172.16–172.31 is private) and missed 100.64/10 (CGNAT).
// ═══════════════════════════════════════════════════════════════════════════

const dns = require('dns').promises
const net = require('net')
const { BadRequestError, UpstreamError } = require('./errors')

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_REDIRECTS = 3
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024

/** Convert an IPv4 string to a 32-bit integer for range comparison. */
function ipv4ToInt(ip) {
    const parts = ip.split('.').map(Number)
    if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) return null
    return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]
}

// CIDR blocks that must never be reachable from user-supplied input.
const BLOCKED_V4 = [
    ['0.0.0.0', 8],          // this network / unspecified
    ['10.0.0.0', 8],         // RFC1918 private
    ['100.64.0.0', 10],      // RFC6598 CGNAT — was missing before
    ['127.0.0.0', 8],        // loopback
    ['169.254.0.0', 16],     // link-local, includes 169.254.169.254 metadata
    ['172.16.0.0', 12],      // RFC1918 private (correctly scoped: .16-.31 only)
    ['192.0.0.0', 24],       // IETF protocol assignments
    ['192.0.2.0', 24],       // TEST-NET-1
    ['192.168.0.0', 16],     // RFC1918 private
    ['198.18.0.0', 15],      // benchmarking
    ['198.51.100.0', 24],    // TEST-NET-2
    ['203.0.113.0', 24],     // TEST-NET-3
    ['224.0.0.0', 4],        // multicast
    ['240.0.0.0', 4],        // reserved
].map(([base, bits]) => {
    const baseInt = ipv4ToInt(base)
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
    return { baseInt, mask }
})

function isBlockedIPv4(ip) {
    const asInt = ipv4ToInt(ip)
    if (asInt === null) return true
    return BLOCKED_V4.some(({ baseInt, mask }) => (asInt & mask) === (baseInt & mask))
}

function isBlockedIPv6(ip) {
    const lower = ip.toLowerCase().replace(/^\[|\]$/g, '')

    if (lower === '::' || lower === '::1') return true          // unspecified, loopback
    if (lower.startsWith('fe80')) return true                   // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true // unique-local fc00::/7
    if (lower.startsWith('ff')) return true                     // multicast

    // IPv4-mapped (::ffff:127.0.0.1) and NAT64 (64:ff9b::) embed a v4 address;
    // validate the embedded address rather than trusting the v6 form.
    const embedded = lower.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
    if (embedded) return isBlockedIPv4(embedded[1])
    if (lower.startsWith('::ffff:') || lower.startsWith('64:ff9b:')) return true

    return false
}

function isBlockedAddress(ip) {
    const kind = net.isIP(ip)
    if (kind === 4) return isBlockedIPv4(ip)
    if (kind === 6) return isBlockedIPv6(ip)
    return true
}

/**
 * Parse and validate a single URL, resolving DNS and rejecting any hostname
 * that maps to a non-public address. Returns { url, addresses }.
 */
async function assertPublicUrl(rawUrl) {
    let parsed
    try {
        parsed = new URL(rawUrl)
    } catch {
        throw new BadRequestError('Invalid URL format', 'invalid_url')
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new BadRequestError('Only http and https URLs are supported', 'invalid_url_scheme')
    }

    // Credentials in a URL are a redirect-laundering trick and never needed here.
    if (parsed.username || parsed.password) {
        throw new BadRequestError('URLs with embedded credentials are not allowed', 'invalid_url')
    }

    const hostname = parsed.hostname.replace(/^\[|\]$/g, '')

    // A literal IP needs no resolution — check it directly. This also catches
    // the decimal/hex/short encodings, because WHATWG URL normalises
    // http://2130706433/ to hostname "127.0.0.1" before we see it.
    if (net.isIP(hostname)) {
        if (isBlockedAddress(hostname)) {
            throw new BadRequestError('Refusing to fetch a private or reserved address', 'blocked_address')
        }
        return { url: parsed, addresses: [hostname] }
    }

    let records
    try {
        records = await dns.lookup(hostname, { all: true, verbatim: true })
    } catch {
        throw new BadRequestError('Could not resolve hostname', 'dns_failure')
    }
    if (!records.length) {
        throw new BadRequestError('Could not resolve hostname', 'dns_failure')
    }

    // Every resolved address must be public. If any is internal we refuse the
    // whole request rather than trying to pin the "good" one — DNS can be
    // re-resolved by the fetch layer (rebinding), so a mixed answer is hostile.
    for (const record of records) {
        if (isBlockedAddress(record.address)) {
            throw new BadRequestError('Refusing to fetch a private or reserved address', 'blocked_address')
        }
    }

    return { url: parsed, addresses: records.map(r => r.address) }
}

/**
 * Fetch a user-supplied URL with SSRF protection, a byte cap and a timeout.
 * Redirects are followed manually so each hop is re-validated.
 */
async function safeFetch(rawUrl, {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    maxBytes = DEFAULT_MAX_BYTES,
    headers = {},
    method = 'GET',
    body,
} = {}) {
    let current = rawUrl
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
        for (let hop = 0; hop <= maxRedirects; hop++) {
            const { url } = await assertPublicUrl(current)

            const response = await fetch(url.toString(), {
                method,
                headers,
                body,
                signal: controller.signal,
                redirect: 'manual',
            })

            if ([301, 302, 303, 307, 308].includes(response.status)) {
                const location = response.headers.get('location')
                if (!location) {
                    throw new UpstreamError('Redirect without a Location header', 'bad_redirect')
                }
                if (hop === maxRedirects) {
                    throw new UpstreamError('Too many redirects', 'too_many_redirects')
                }
                current = new URL(location, url).toString()
                continue
            }

            // Enforce the byte cap while streaming so an enormous body cannot
            // exhaust memory before we get a chance to reject it.
            const declared = Number(response.headers.get('content-length') || 0)
            if (declared && declared > maxBytes) {
                throw new UpstreamError('Response too large', 'response_too_large')
            }

            const reader = response.body?.getReader()
            const chunks = []
            let total = 0
            if (reader) {
                for (;;) {
                    const { done, value } = await reader.read()
                    if (done) break
                    total += value.length
                    if (total > maxBytes) {
                        try { await reader.cancel() } catch { /* already closed */ }
                        throw new UpstreamError('Response too large', 'response_too_large')
                    }
                    chunks.push(value)
                }
            }

            // Shaped like a fetch Response on purpose: every caller was written
            // against the global fetch API and does `await response.text()` /
            // `await response.json()`. Returning the body as a plain `text`
            // string made those calls throw "response.text is not a function"
            // at runtime — the SSRF guard was correct but unusable.
            const bodyText = Buffer.concat(chunks).toString('utf8')

            return {
                ok: response.ok,
                status: response.status,
                headers: response.headers,
                contentType: response.headers.get('content-type') || '',
                finalUrl: url.toString(),
                text: async () => bodyText,
                json: async () => JSON.parse(bodyText),
                // The already-buffered body, for callers that want it directly
                // without the promise hop.
                bodyText,
            }
        }

        throw new UpstreamError('Too many redirects', 'too_many_redirects')
    } catch (err) {
        if (err.name === 'AbortError') {
            throw new UpstreamError(`Request timed out after ${timeoutMs}ms`, 'upstream_timeout', 504)
        }
        throw err
    } finally {
        clearTimeout(timer)
    }
}

module.exports = { safeFetch, assertPublicUrl, isBlockedAddress }
