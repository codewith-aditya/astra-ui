# Security

How AstraGPT defends itself, where the real boundaries are, and what is currently unresolved.

This document is written to be useful during an incident, so it states weaknesses as plainly as
strengths. Nothing here is a disclosure of an exploited vulnerability; it is the current state of a
system under active hardening.

---

## Reporting a vulnerability

Email **hello@tantraailabs.in**. Please do not open a public issue for a security report.

Include what you did, what you expected, and what happened. A request/response pair or a minimal
script is worth more than a description.

---

## The authentication model

Authentication is a first-party JWT system. Supabase is a secondary verifier, not the primary.

**Access tokens** are HS256 JWTs, 30 minutes by default, carrying
`{ sub, email, plan, tv, sid, mfa, typ }`. The `typ` claim is enforced on verification, so a refresh
token or an MFA challenge token cannot be presented as an access token.

**Refresh tokens** are opaque and stored **only as SHA-256 digests** in the user's session array.
A database leak does not yield usable refresh tokens.

**Rotation with reuse detection.** Every refresh issues a new pair and overwrites the stored digest.
If a token whose digest no longer matches is presented, that is a replay of an already-rotated
token — the system increments `tokenVersion` and **wipes every session for that user**, returning
`reuseDetected`. A stolen refresh token therefore has a single-use window and its use locks out
both the attacker and the legitimate holder, which is the correct trade.

**Revocation.** Every access token carries `tv`; every request compares it against the user's
current `tokenVersion`. Incrementing that field invalidates every outstanding token immediately.
Password change, password reset, and "sign out everywhere" all bump it.

**Session records** are capped at 10 per user, pruned least-recently-active first, and store parsed
device/browser/OS/IP for the session list UI.

### Where the model is weaker

Supabase-verified identities carry `tokenVersion: null`, and the revocation check is gated on
`source === 'jwt'`. **Supabase tokens are therefore not revocation-tracked.** They are also not
accepted on Socket.IO connections at all. If you rely on Supabase as a login path, revocation does
not fully apply to it — the first-party path is the one with complete coverage.

`ApiKey.key` is stored **in plaintext**, unlike OTPs, refresh tokens, and MFA recovery codes, which
are all hashed. A database read yields working API keys. This is the clearest schema-level
inconsistency in the codebase.

---

## Multi-factor authentication

TOTP via otplib v13. Enrolment is two-phase: `POST /api/mfa/setup` writes `mfaPendingSecret`, and
only a successful `POST /api/mfa/verify` promotes it to `mfaSecret`. A failed enrolment cannot lock
an account out.

`mfaLastTimeStep` prevents replay of a code within its own validity window. Recovery codes are
bcrypt-hashed at rest and single-use. Disabling MFA requires **both** a valid TOTP code and the
account password.

Token rotation carries `mfa: session.mfaSatisfied` forward rather than hardcoding `true` — a
refresh cannot silently upgrade a session to MFA-satisfied. There is a test for exactly this.

Note that `requireMfa` is exported from `middleware/auth.js` but **no route uses it**. MFA is
currently enrolment and verification only; it does not yet gate any specific operation.

---

## The security middleware stack

Five layers run before any router. Ordering is deliberate and load-bearing.

**Cloudflare guard.** Resolves the real client IP, and when `BEHIND_CLOUDFLARE` is on, rejects any
request without a `CF-Ray` header — that blocks direct-to-origin access that would bypass the CDN
entirely. Also blocks on threat score and country. Bogon IP filtering is production-only.

**WAF.** 17 regex rules across SQL injection, XSS, path traversal, command injection, SSRF metadata
endpoints, prototype pollution, and CRLF header injection. It inspects the decoded URL, headers
outside an 18-entry allow-list, and body fields.

The body inspection is a deliberate compromise worth understanding: it **whitelists** the fields it
inspects (`content`, `text`, `message`, `prompt`, `query`, and image fields), skips the `messages`
array entirely, and skips any string over 5000 characters. This exists so users can discuss SQL and
paste code without being blocked — an AI assistant that rejects the word `UNION` is useless. The
consequence is that chat content is largely uninspected by the WAF. **Chat content safety therefore
rests on the layers behind it**, not on the WAF.

**Behaviour engine.** Per-IP anomaly scoring over a 5-minute window across six signals: request
velocity, endpoint diversity (scanning), error rate (fuzzing), user-agent switching, raw volume, and
suspicious method mix. At 61+ it tarpits, delaying responses up to 3 seconds; at 80+ it blocks with
429. State is in-memory, so it is per-process and resets on restart.

**Bot detection.** ~45 automation and pentest-tool user-agent patterns, an allow-list for legitimate
crawlers and uptime monitors, and an 8-signal header fingerprint. **Blocking is off by default** —
it logs only until `BOT_BLOCK_BOTS=true`. Enable it after reviewing what it would have caught.

**Security logger.** 500-entry in-process ring buffer feeding the admin dashboard, plus persistent
`SecurityLog` documents with a 30-day TTL.

Response hardening is unconditional: `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
a `default-src 'none'` CSP appropriate for a JSON API, and HSTS in production. `nginx.conf` sets the
same headers deliberately — defence in depth, not redundancy to remove.

---

## Sandboxed code execution

**The security boundary is Docker container isolation, not an in-process VM.** A previous
implementation used Node's `vm` module; `Function('return process')()` escapes it and reads
`process.env`. That approach was removed rather than patched, because the escape is a property of
the module, not a bug in its use.

Every execution runs `docker run` with: `--network none`, `--read-only` rootfs, `--cap-drop ALL`,
`--security-opt no-new-privileges`, `--user 1000:1000`, memory and swap set equal (256 MB default),
`--cpus 0.5`, `--pids-limit 128`, a 64 MB `tmpfs` for `/tmp`, `fsize` and `nofile` ulimits, and the
source mounted **read-only**. Wall-clock timeouts force `docker rm -f`. Concurrency caps at 4.

`BLOCKED_PATTERNS` matches `rm -rf /`, fork bombs, `mkfs`, and similar. The code that defines it
documents it as defence-in-depth only and "trivially bypassable" — **it is not the boundary**, and
treating it as one would be a mistake.

Environment variables passed into a sandbox are validated by name against
`/^[A-Za-z_][A-Za-z0-9_]*$/`, rejected on NUL bytes or oversized values, and passed as separate
argv entries — never through a shell. There are unit tests asserting that shell metacharacters
survive as literals and that a name which could smuggle a second variable is rejected.

---

## SSRF protection

Any endpoint that fetches a user-supplied URL routes through `utils/safeFetch.js`, which resolves
DNS and rejects private, loopback, link-local, and CGNAT address space — **re-checking on every
redirect hop**, since a public URL can redirect to `169.254.169.254`.

It defeats decimal, hex, short-form, and IPv4-mapped-IPv6 encodings of localhost. There are unit
tests with a table of encoded-localhost and cloud-metadata URLs.

The terminal proxy is a different shape of the same problem, solved by not accepting user input at
all: targets come only from the `TERMINAL_SERVERS` environment variable. It also strips the
caller's `Authorization` and cookies rather than forwarding them, injecting the configured server's
own key instead.

---

## Upload handling

Filenames are always server-generated (`Date.now()_<8 hex><vetted ext>`), so a caller cannot
influence the path on disk. Extension allow-lists are enforced, and images additionally require a
matching MIME type.

**File type is decided by magic bytes**, not the declared `Content-Type` — `utils/fileType.js`
sniffs the first 4100 bytes. An image upload whose bytes are not a real image is deleted and
rejected after write.

`/uploads` is served **after** the security stack (it was previously mounted before the WAF, and
twice) with `Content-Disposition: attachment`, `nosniff`, and `default-src 'none'; sandbox`. A file
that passes upload validation still cannot execute in a victim's browser on our origin.

ZIP extraction is bounded: 1000 entries, 100 MB declared uncompressed, 5 MB per inlined entry, and
a compression ratio ceiling of 200 — that last one is the zip-bomb defence. A `SECRET_NAME` regex
excludes `.env*`, `.npmrc`, `.netrc`, SSH keys, `*.pem`, `credentials`, and similar from being
inlined; they are listed by name and count but their contents are never echoed back.

Archive paths are normalised by a segment stack that pops on `..` and clamps at root (zip-slip), and
`Content-Disposition` filenames are stripped of `\r\n"` to prevent header injection. Both have unit
tests.

---

## Input validation

`utils/validate.js` strips MongoDB operators and prototype-pollution keys before any value reaches a
query. There are integration tests that send `{$ne: null}` style objects into id and email fields
and assert rejection.

Error responses never echo internals. `normalize()` maps library errors to safe shapes — a duplicate
key error becomes `409 duplicate` **without the key name**, a Mongoose validation error exposes field
names only, and anything unrecognised becomes a generic `500 server_error` with `expose: false`.
Every response carries a `requestId` for correlation.

Mid-stream failures are handled specially: if headers are already sent on an SSE stream, the handler
writes an `event: error` frame with a generic message and then `[DONE]`, rather than appending JSON
to a committed event stream or leaking the upstream error text.

4xx responses log at debug level so scanners cannot flood the logs; 5xx logs at error with full
context.

---

## Timing-attack resistance

`adminGuard` SHA-256-hashes both sides before `crypto.timingSafeEqual`, which lets it compare
different-length inputs in constant time. It **fails closed**: an unset or blank `ADMIN_SECRET`
returns `admin_not_configured`, not open access.

Login verifies the supplied password against a `DUMMY_HASH` when the user does not exist, so
response timing does not reveal whether an email is registered.

---

## Rate limiting

Sliding window, Redis-backed when configured. Fifteen named limiters — the notable ones being 3
OTP sends per 15 minutes keyed by **hashed** email (so a mail-bombing attempt against one address
cannot be spread across IPs), 10 sandbox spawns per minute, 30 outbound fetches per minute, and 5
public form submissions per hour per IP.

On a Redis error, limiters **fall back to in-memory enforcement rather than allowing the request**.
Only the global 300/min limiter sets `failOpen: true` — a Redis outage degrades that one to
per-process counting instead of taking the site down.

Email addresses are hashed before they reach Redis or logs.

---

## Known issues

These are current and unresolved. They are listed here rather than in a private tracker because
anyone deploying this needs to know them.

### Client-side secrets

Three provider API keys are defined as literal constants in frontend source, so they are compiled
into the public bundle and readable in DevTools by any visitor:

- `astragpt/src/lib/api.js:12` — `AISUBSCRIPTION_API_KEY`
- `astragpt/src/lib/api.js:17` — `FALLBACK_API_KEY`
- `astragpt/src/lib/builderApi.js:3` — `BUILDER_KEY`

`VITE_TAVILY_KEY` has the same exposure through the normal Vite inlining path.

**Rotation alone is insufficient** while the constants remain in frontend source — the new key ships
too. The fix is to proxy these calls through the backend, which already has the pattern in place at
`POST /api/rag/web/search`.

`AISUBSCRIPTION_API_KEY` additionally appeared in git history and should be treated as compromised
independent of the bundle issue.

### Unauthenticated endpoints

Intentionally public and low-risk: `/health`, `/ready`, `GET /v1/models` (a static catalogue),
`GET /api/configs/default`, `GET /api/banners`, `POST /api/contact` (rate-limited), and `/uploads/*`
(hardened static).

Worth attention:

- **`GET /api/evaluations/leaderboard`** has no auth and no rate limit, and it loads every comparison
  document and recomputes Elo on **every request**. That is unbounded work available to an anonymous
  caller — a cheap denial-of-service. It needs a cache or a rate limit.
- **`POST /api/banners`** and **`DELETE /api/banners/:bannerId`** use neither `auth` nor
  `adminGuard`. They perform an inline `req.headers['x-admin-secret'] !== secret` comparison —
  the exact hand-rolled pattern `adminGuard` was written to replace. It fails closed on an unset
  secret, but the comparison is **not constant-time** and it bypasses `limiters.admin`. These
  should use `adminGuard`.

### Admin access is a shared secret

`adminGuard` checks a single `x-admin-secret` header against one environment variable. There is no
per-user role, no audit trail tied to an individual operator, and no way to revoke one person's
access without rotating for everyone. It is operator-style access, appropriate for a small team, and
it should not be extended to a larger one without moving to real RBAC.

### Chat persistence path skips ownership checks

In `openaiCompletions`, the save path reads `userId` from the **request body**, not `req.userId`, and
performs no ownership check on the supplied `chatId`. Compare `sendMessage`, which explicitly ignores
a body-supplied `userId` and calls `assertChatOwner`. The completions path should do the same.

### Markdown rendering has no sanitizer

`ChatMessages.jsx` implements a hand-written markdown renderer that emits HTML strings injected via
`dangerouslySetInnerHTML`. There is no DOMPurify or equivalent in the dependency tree, so **XSS
resistance rests entirely on the correctness of those regexes**. Artifact cards additionally embed
model-derived values into inline `onclick=` attribute strings with ad-hoc escaping.

Model output is not fully trusted input — it can be influenced by user input and by fetched web
content. This is the largest untested surface in the frontend.

Related: Mermaid is initialised with `securityLevel: 'loose'`.

### No error boundary

`ErrorBoundary.jsx` exists but is imported nowhere, so a render error in any component blanks the
entire application rather than degrading one panel.

### Untested security middleware

There are no dedicated tests for the WAF, behaviour engine, bot detection, Cloudflare guard, or the
Socket.IO room-authorization paths. Rate limiting is globally disabled during the suite via
`RATE_LIMIT_DISABLED=1`, so no test exercises a limiter end to end.

The 60 existing tests cover authentication, session lifecycle, MFA enrolment, NoSQL injection,
SSRF filtering, archive path traversal, sandbox argument passing, admin guard, ownership checks, and
route mounting. That is the high-value core; the perimeter is what lacks coverage.

### Legacy dead code

`middleware/redisRateLimit.js` appears unused and **fails open in every branch**, unlike the
`rateLimit.js` that replaced it. It should be deleted so it cannot be wired back in by accident.

---

## Fixed vulnerabilities

Recorded because the code carries scars from them, and because the shapes recur. Header comments in
`server.js`, `planGuard.js`, and `adminGuard.js` document these in detail.

**Wildcard route at the application root.** `routes/groups.js` declared `/` and `/:id` while being
mounted at `/`, which put an authenticated wildcard `GET /:id` at the root — it swallowed any
unclaimed single-segment path. Groups are now mounted at `/api/groups`, and there is a test
asserting no catch-all exists at the root.

**`/uploads` served before the WAF**, and mounted twice. Stored user content was returned with no
inspection. It is now mounted after the full stack with hardened headers.

**Socket.IO accepted client-supplied identity.** Any client could emit `register` with an arbitrary
`userId` and join that user's private room. Identity now comes only from a verified token, and there
is no `register` event to spoof.

**`planGuard` failed open on database errors** and trusted `req.body.userId` and the `x-user-id`
header. It now fails closed with 503 and reads identity only from the authenticated request.

**Quota was a read-modify-write race.** Daily usage is now an atomic `findOneAndUpdate` with a
`$lt` filter, so concurrent requests cannot both pass a nearly-exhausted quota.

**`adminGuard` was bypassable when `ADMIN_SECRET` was unset**, and the JWT secret had a committed
default. Both now fail closed, and the leaked secret is on an explicit rejection list.

**Sessions survived credential changes.** A socket opened before a password change kept streaming.
The `tokenVersion` mechanism now covers both HTTP and WebSocket paths.

**Route shadowing in analytics.** `GET /api/analytics/:userId` captured `/api/analytics/users`,
treating `"users"` as a user id and 403-ing, which hid the admin endpoint entirely. Router
registration order now places literal paths before parameterised ones, with a test.
