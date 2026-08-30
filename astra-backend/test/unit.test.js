// ═══════════════════════════════════════════════════════════════════════════
//  Unit tests for the security primitives.
//
//  These cover the pure functions that the route-level tests depend on but
//  cannot exercise exhaustively: TOTP verification, SSRF address filtering,
//  archive path normalisation, header sanitisation and input validation.
//
//  Each block corresponds to a specific defect that shipped in the previous
//  implementation; the comments name it so a future change that reintroduces
//  the bug fails here with an explanation rather than a bare assertion.
// ═══════════════════════════════════════════════════════════════════════════

const assert = require('node:assert/strict')
const { test, describe } = require('node:test')

require('./setup').applyTestEnv()

const totp = require('../utils/totp')
const { assertPublicUrl } = require('../utils/safeFetch')
const v = require('../utils/validate')
const { sniff } = require('../utils/fileType')

// ─────────────────────────────────────────────────────────────────────────────
describe('TOTP verification', () => {
    // The original code called otplib v13's promise-returning verify() without
    // awaiting it and tested the result for truthiness. A pending Promise is
    // always truthy, so `if (!isValid)` never fired and ANY 6-digit code was
    // accepted — on /verify (enable 2FA) and on /disable (strip a victim's 2FA).
    test('accepts the current code and rejects everything else', async () => {
        const secret = totp.createSecret()
        const { generate, NobleCryptoPlugin, ScureBase32Plugin } = require('otplib')
        // generate() resolves to the code string itself, not a { token } object.
        const token = await generate({
            secret,
            crypto: new NobleCryptoPlugin(),
            base32: new ScureBase32Plugin(),
        })

        assert.equal(await totp.verifyTotpSecret(secret, token), true, 'correct code must verify')
        assert.equal(await totp.verifyTotpSecret(secret, '000000'), false, 'wrong code must fail')
        assert.equal(await totp.verifyTotpSecret(secret, 'abcdef'), false, 'non-numeric must fail')
        assert.equal(await totp.verifyTotpSecret(secret, ''), false, 'empty must fail')
        assert.equal(await totp.verifyTotpSecret('', token), false, 'missing secret must fail')
        assert.equal(await totp.verifyTotpSecret('!!not-base32!!', token), false,
            'a malformed stored secret must read as invalid, never as valid')
    })

    test('returns a real boolean, not an object', async () => {
        // Guards the second half of the same defect: even when awaited, v13
        // resolves to { valid, ... }. Every object is truthy, so returning the
        // result object would leave `if (!ok)` permanently false.
        const result = await totp.verifyTotpSecret(totp.createSecret(), '000000')
        assert.equal(typeof result, 'boolean')
        assert.equal(!result, true, 'negation must work on the return value')
    })

    test('enrolment URI carries the account label', () => {
        // v13 names the field `label`; the old code passed `account`, producing
        // "AstraGPT:undefined" in every QR code.
        const uri = totp.createEnrollmentUri({
            secret: totp.createSecret(),
            accountName: 'user@example.com',
        })
        assert.ok(!uri.includes('undefined'), `label missing from URI: ${uri}`)
        assert.ok(uri.includes('issuer=AstraGPT'))
    })

    test('recovery codes are hashed and single-use', () => {
        const { plaintext, records } = totp.generateRecoveryCodes()
        assert.equal(plaintext.length, records.length)

        const serialized = JSON.stringify(records)
        for (const code of plaintext) {
            assert.ok(!serialized.includes(code), 'plaintext recovery code must not be persisted')
        }

        assert.equal(totp.consumeRecoveryCode(records, plaintext[0]), true, 'first use succeeds')
        assert.equal(totp.consumeRecoveryCode(records, plaintext[0]), false, 'reuse is refused')
        assert.equal(totp.consumeRecoveryCode(records, 'NOPE1-NOPE2'), false, 'unknown code is refused')
        assert.equal(
            totp.consumeRecoveryCode(records, plaintext[1].toLowerCase()), true,
            'matching is case-insensitive so a user typing lowercase is not locked out',
        )
    })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('SSRF address filtering', () => {
    // The previous guard compared hostname string prefixes against a short
    // blocklist. That missed every alternate encoding of a loopback address,
    // over-blocked all of 172.* (including public space), and never re-checked
    // redirect hops.
    const blocked = [
        ['http://localhost/admin', 'hostname'],
        ['http://127.0.0.1:4000/', 'dotted quad'],
        ['http://127.1/', 'short form'],
        ['http://2130706433/', 'decimal'],
        ['http://0x7f000001/', 'hex'],
        ['http://[::1]/', 'IPv6 loopback'],
        ['http://[::ffff:127.0.0.1]/', 'IPv4-mapped IPv6'],
        ['http://169.254.169.254/latest/meta-data/', 'cloud metadata'],
        ['http://10.0.0.5/', 'RFC1918 /8'],
        ['http://192.168.1.1/', 'RFC1918 /16'],
        ['http://172.16.0.1/', 'RFC1918 /12 low'],
        ['http://172.31.255.254/', 'RFC1918 /12 high'],
        ['http://100.64.0.1/', 'CGNAT'],
        ['http://0.0.0.0/', 'unspecified'],
        ['file:///etc/passwd', 'file scheme'],
        ['gopher://x/', 'non-http scheme'],
    ]

    for (const [url, label] of blocked) {
        test(`blocks ${label}: ${url}`, async () => {
            await assert.rejects(
                () => assertPublicUrl(url),
                (err) => err.status === 400,
                `${url} must be refused`,
            )
        })
    }

    const allowed = [
        ['http://172.32.0.1/', 'public address just outside the RFC1918 /12'],
        ['http://8.8.8.8/', 'public resolver'],
    ]

    for (const [url, label] of allowed) {
        test(`allows ${label}`, async () => {
            await assert.doesNotReject(() => assertPublicUrl(url), `${url} must be permitted`)
        })
    }
})

// ─────────────────────────────────────────────────────────────────────────────
describe('archive path normalisation', () => {
    // Regex-based "../" stripping is order-dependent: "....//" collapses to
    // "../" after one pass and escapes. Resolution here uses a segment stack.
    const { __test } = require('../controllers/generateController')

    const cases = [
        ['src/index.js', 'src/index.js', 'ordinary nested path is preserved'],
        ['../../etc/passwd', 'etc/passwd', 'leading traversal is clamped at the root'],
        ['a/../b', 'b', 'mid-path traversal resolves'],
        ['/etc/passwd', 'etc/passwd', 'absolute path is made relative'],
        ['..\\..\\windows\\sys', 'windows/sys', 'Windows separators are normalised'],
        ['C:\\Windows\\System32', 'Windows/System32', 'drive letter is stripped'],
        // "...." is not traversal — it is a dot-only segment, which the
        // normaliser drops rather than treating as "..". The entry stays inside
        // the archive root, which is the property that matters.
        ['....//etc/passwd', 'etc/passwd', 'dot-only segments are dropped, not treated as traversal'],
        ['../..', null, 'pure traversal yields nothing'],
        ['', null, 'empty input is refused'],
        [null, null, 'non-string input is refused'],
    ]

    for (const [input, expected, label] of cases) {
        test(label, () => {
            assert.equal(__test.sanitizeArchivePath(input), expected)
        })
    }

    test('filename cannot inject response headers', () => {
        // Content-Disposition previously interpolated the raw filename, so a
        // newline let the caller append arbitrary headers.
        const out = __test.safeFilename('a\r\nX-Evil: 1')
        assert.ok(!out.includes('\r') && !out.includes('\n'), 'CR/LF must be removed')
        assert.ok(!out.includes('"'), 'quotes must be removed')
        assert.equal(__test.safeFilename(''), 'document', 'falls back when empty')
    })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('input validation', () => {
    // express.json() parses {"userId":{"$ne":null}} into an object. Passing that
    // to findOne() turns an identity lookup into an operator query matching an
    // arbitrary document — which, combined with the unauthenticated password
    // reset, was full account takeover without knowing any email.
    test('rejects Mongo operator objects where a scalar is expected', () => {
        assert.throws(() => v.id({ $ne: null }, 'userId'), /must be a string/)
        assert.throws(() => v.email({ $gt: '' }, 'email'), /must be a string/)
        assert.throws(() => v.str(['a'], 'name'), /must be a string/)
        assert.throws(() => v.id(123, 'userId'), /must be a string/)
    })

    test('rejects operator and prototype keys in free-form objects', () => {
        assert.throws(() => v.safeObject({ $where: '1' }, 'valves'), /forbidden key/)
        // A `__proto__` key in an object *literal* sets the prototype instead of
        // creating an own property, so it is invisible to Object.keys. The real
        // attack arrives over the wire and is parsed, which does create an own
        // key — that is the shape worth asserting on.
        const parsed = JSON.parse('{"__proto__":{"admin":true}}')
        assert.throws(() => v.safeObject(parsed, 'valves'), /forbidden key/)
        assert.throws(() => v.safeObject(JSON.parse('{"constructor":{}}'), 'valves'), /forbidden key/)
        assert.deepEqual(v.safeObject({ a: { b: 1 } }, 'valves'), { a: { b: 1 } })
    })

    test('enforces the password policy', () => {
        assert.throws(() => v.password('short', 'password'), /at least 8/)
        assert.throws(() => v.password('x'.repeat(80), 'password'), /at most 72 bytes/)
        assert.throws(() => v.password(null, 'password'), /required/)
        assert.equal(v.password('correct horse battery', 'password'), 'correct horse battery')
    })

    test('validates ObjectIds before they reach Mongo', () => {
        // findById() on a malformed id throws an uncaught CastError, which
        // surfaced as a 500 with internals attached.
        assert.throws(() => v.objectId('not-an-id', 'memoryId'))
        assert.equal(v.objectId('507f1f77bcf86cd799439011', 'memoryId'), '507f1f77bcf86cd799439011')
    })

    test('rejects non-http URL schemes', () => {
        assert.throws(() => v.httpUrl('file:///etc/passwd', 'url'), /http or https/)
        assert.throws(() => v.httpUrl('javascript:alert(1)', 'url'), /http or https/)
        assert.equal(v.httpUrl('https://example.com/a', 'url'), 'https://example.com/a')
    })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('file type detection', () => {
    // The uploader trusted the client-declared Content-Type, so any file could
    // be routed to any parser by relabelling it.
    test('identifies formats by signature, not by label', () => {
        assert.equal(sniff(Buffer.from('%PDF-1.7')), 'pdf')
        assert.equal(sniff(Buffer.from([0x50, 0x4b, 0x03, 0x04])), 'zip')
        assert.equal(sniff(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'png')
        assert.equal(sniff(Buffer.from([0xff, 0xd8, 0xff])), 'jpeg')
        assert.equal(sniff(Buffer.from('plain text')), 'text')
    })

    test('classifies NUL-containing data as binary', () => {
        // Blocks a binary renamed to .txt from being read as text.
        assert.equal(sniff(Buffer.from([0x41, 0x00, 0x42])), 'binary')
    })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('sandbox environment passing', () => {
    // routes/tools.js passes tool input via env rather than interpolating it
    // into the generated source. runInSandbox originally did not destructure
    // `env`, so the value never reached the container and every tool saw
    // TOOL_INPUT = null.
    const { __test: sbx } = require('../utils/sandbox')

    test('a valid name/value pair becomes docker -e args', () => {
        assert.deepEqual(
            sbx.envArgs({ TOOL_INPUT_JSON: '{"a":1}' }),
            ['-e', 'TOOL_INPUT_JSON={"a":1}'],
        )
    })

    test('a value containing shell metacharacters is passed literally', () => {
        // spawn() without a shell means no re-parsing; the value must survive
        // untouched rather than being quoted or escaped.
        const args = sbx.envArgs({ X: '"; rm -rf /; echo "' })
        assert.deepEqual(args, ['-e', 'X="; rm -rf /; echo "'])
    })

    test('a name that could smuggle a second variable is rejected', () => {
        // `-e` splits on the first '=', so a name containing '=' would inject
        // an extra variable.
        assert.deepEqual(sbx.envArgs({ 'A=B': 'c' }), [])
        assert.deepEqual(sbx.envArgs({ '1BAD': 'c' }), [])
        assert.deepEqual(sbx.envArgs({ 'has space': 'c' }), [])
    })

    test('a NUL byte in the value is rejected', () => {
        assert.deepEqual(sbx.envArgs({ X: 'a\u0000b' }), [])
    })

    test('non-object input yields no args', () => {
        assert.deepEqual(sbx.envArgs(undefined), [])
        assert.deepEqual(sbx.envArgs(null), [])
        assert.deepEqual(sbx.envArgs('nope'), [])
    })
})
