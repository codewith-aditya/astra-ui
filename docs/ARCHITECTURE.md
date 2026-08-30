# Architecture

How AstraGPT is put together: what happens to a request, how the pieces fit, and why several
non-obvious decisions were made the way they were.

Line references point at the code that implements each behaviour, so this document can be checked
against reality rather than trusted.

---

## System shape

One Express application and one React single-page app. That is the whole system.

```
Browser (React 19 SPA, Vite 7)
    │
    │  HTTPS + Server-Sent Events + WebSocket
    ▼
nginx  ── TLS termination, static assets, reverse proxy
    │
    ▼
astra-backend  ── single Express 4 process, pm2-managed
    │
    ├──▶ MongoDB          conversations, users, sessions, knowledge, audit log
    ├──▶ Docker           one ephemeral container per code execution
    ├──▶ Upstash Redis    shared rate-limit counters (optional)
    └──▶ Inference upstreams  AI Subscription (primary), Nexusify (secondary)
```

An earlier design split this across four processes on four ports — a main backend, a separate ZIP
generator, a separate JWT authentication service, and a model proxy. All four collapsed into the
single application. ZIP generation became `POST /generate-project`, and authentication became core
rather than a service. If you find documentation describing ports 4500 or 8317, it predates that
consolidation.

---

## Request lifecycle

Middleware order in `astra-backend/server.js` is load-bearing. Each layer assumes the ones before
it have already run.

| # | Layer | Line | Responsibility |
|---|---|---|---|
| — | `trust proxy`, disable `x-powered-by` | 47–48 | Make `req.ip` reflect the real client behind nginx |
| 0 | `securityHeaders` | 51 | CSP, `nosniff`, `DENY` framing, HSTS in production |
| 1 | `cors` | 74 | Origin allow-list |
| 2 | `requestContext` | 78 | Assign request id, time the request, emit one access log line |
| — | `GET /health`, `GET /ready` | 83, 90 | Registered here deliberately — see below |
| 3 | Body parsing | 99–100 | JSON and urlencoded, capped at `JSON_BODY_LIMIT` |
| 4 | `limiters.global` | 103 | 300 requests/min per IP |
| 5 | `cloudflareGuard` | 112 | Resolve real client IP, reject origin-direct traffic, threat score, geo |
| 6 | `securityLogger` | 113 | Ring-buffer audit feed for the operator dashboard |
| 7 | `waf` | 114 | 17 injection-pattern rules |
| 8 | `behaviorEngine` | 115 | Per-IP anomaly scoring, tarpit, block |
| 9 | `aiDetection` | 116 | Bot user-agent and browser-fingerprint scoring |
| 10 | `/uploads` static | 122–131 | User files, forced to download, sandboxed CSP |
| 11 | Routers | 145–175 | 24 route modules |
| 12 | 404, then error handler | 193–194 | Structured JSON, never an HTML stack trace |

Two placements matter more than the rest.

**Health checks sit above everything.** `/health` and `/ready` are registered before body parsing,
rate limiting, and the entire security stack. A database outage must not make liveness fail, or
the supervisor restarts a process whose only problem is a dependency — a restart loop that makes
the outage worse. `/ready` reports database state separately so the load balancer can drain
traffic without the supervisor killing the process.

**Static uploads sit below the security stack.** They were once mounted above the WAF — and mounted
twice — so stored user content was served with no inspection at all. Now a file that passed upload
validation is still served with `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`,
and `Content-Security-Policy: default-src 'none'; sandbox`, so it cannot execute in a victim's
browser on our origin.

### Router mounting

Two mounting styles coexist, which is the single most confusing thing about the codebase.

Nineteen routers are mounted at `/` and declare their own full `/api/...` paths internally
(`server.js:145-166`). Five are mounted under an explicit prefix (`server.js:169-175`):
`/api/auth`, `/api/mfa`, `/api/ax-ctrl`, `/api/groups`, and `routes/coupon` at `/`.

**Registration order is a correctness constraint, not a style preference.** Express matches in
registration order, so a router holding a parameterised path must be mounted after routers
declaring literal paths under the same prefix. `routes/analytics.js` owns the literal
`/api/analytics/{dashboard,models,users,tokens}` and `routes/features.js` owns the parameterised
`/api/analytics/:userId`. Reverse them and `/api/analytics/users` gets captured by the parameterised
route, treated as a user id, and fails its ownership check with a `403` — while the admin endpoint
becomes unreachable entirely.

A related bug is already fixed and worth knowing about: `routes/groups.js` used to be mounted at
`/` while declaring `/` and `/:id`, which put an authenticated wildcard `GET /:id` at the
application root where it swallowed every unclaimed single-segment path. It is now mounted at
`/api/groups`. There is a regression test for this.

### CORS

A request with **no** `Origin` header is allowed (`server.js:58-62`). This is intentional and
narrower than it looks: it covers same-origin requests, `curl`, and server-to-server callers.
Authentication is enforced per route and cookies are not used, so a missing origin grants no
authority. Previously this exemption applied while credentials were on, which effectively
exempted every non-browser client from the origin check.

---

## Authentication

First-party JWT is the primary scheme. Supabase is an optional secondary verifier, not the
system of record.

### Token model — `utils/tokens.js`

| Token | Lifetime | Payload | Storage |
|---|---|---|---|
| Access | `ACCESS_TOKEN_TTL`, default 30m | `{sub, email, plan, tv, sid, mfa, typ:'access'}` | Client only |
| Refresh | `REFRESH_TOKEN_TTL_DAYS`, default 30d | `{sub, tv, sid, typ:'refresh', jti}` | **SHA-256 digest only** |
| MFA challenge | 10 minutes | `{sub, tv, typ:'mfa_challenge'}` | Client only |

All are HS256 with a fixed issuer and audience. `verifyToken(token, expectedTyp)` enforces the
`typ` claim (`tokens.js:70-75`), so a refresh token cannot be presented as an access token. There
is a test for exactly that.

The refresh token carries a random `jti` because `iat` has only one-second resolution. Without it,
two refreshes inside the same second produce byte-identical tokens, which defeats reuse detection
entirely.

**Refresh rotation with replay detection** (`tokens.js:161-196`) is the most important mechanism
here. Each session stores only the SHA-256 digest of its current refresh token. On refresh, the
presented token's digest is compared against the stored one:

- **Match** → rotate. Issue a new pair, update the stored digest.
- **Mismatch** → this token was already rotated, so someone is replaying a stolen one. Increment
  `tokenVersion` and **wipe every session on the account**, returning `{reuseDetected: true}`.

The new access token carries `mfa: session.mfaSatisfied === true`, deliberately carrying the
session's real state forward rather than hardcoding `true` — otherwise a refresh would silently
upgrade an unverified session to MFA-satisfied. Tested.

Sessions cap at 10 per user, pruning least-recently-active first. Each records device, browser,
OS, IP, and user agent so a user can recognise and revoke a session they don't own.

### Verification — `middleware/auth.js`

`Authorization: Bearer <token>` is required; a bare user id is never accepted. Local JWT is tried
first, then Supabase — but **only if the failure was not `TokenExpiredError`** (`auth.js:37`), since
an expired local token should surface as expired rather than falling through to a different
verifier.

Then, on every request: the user must exist (never auto-created here), must not be banned, and for
local JWTs `payload.tv` must equal `user.tokenVersion`. That last check is what makes password
changes and "sign out everywhere" take effect immediately — a token minted before the bump is
rejected even though its signature is valid.

Supabase identities carry `tokenVersion: null` and the check is gated on `source === 'jwt'`, so
**Supabase tokens are not revocation-tracked**. Noted in [SECURITY.md](SECURITY.md).

### Admin access

Admin is a shared secret in the `x-admin-secret` header, compared against `ADMIN_SECRET`. Not
per-user RBAC — there is no role field on `User`.

`middleware/adminGuard.js` hashes both sides with SHA-256 before `crypto.timingSafeEqual`, which
both makes the comparison constant-time and lets it accept differing input lengths. It **fails
closed**: an unset or blank server-side secret returns `403 admin_not_configured` rather than
allowing the request. That was once a real bypass.

---

## Data model

24 Mongoose schemas in `astra-backend/models/`. Two structural facts shape everything:

**There are no `ref:` declarations anywhere.** Every relationship is a soft join on a string id —
`userId`, `chatId`, `channelId`, `knowledgeId`. `userId` is an opaque external identifier, not an
ObjectId. Nothing populates; joins are explicit queries.

**Twelve models generate their own `uuidv4()` primary id** alongside Mongo's `_id`, so ids are
stable across environments and safe to expose in URLs.

### Core entities

```
User ─┬─ sessions[]        embedded, refresh-token digests
      ├─ mfaRecoveryCodes[]  embedded, bcrypt-hashed
      │
      ├─ Chat ── Message
      │    └─ folderId ──▶ Folder (self-referential tree via parentId)
      │    └─ knowledgeId ──▶ Knowledge
      │
      ├─ Memory            facts injected into every conversation
      ├─ Note, Prompt      productivity
      ├─ ApiKey            external access
      │
      ├─ Knowledge ◀── KnowledgeFile ──▶ File     many-to-many
      ├─ Channel ── ChannelMessage                threaded, parentId
      ├─ Group ── AccessGrant                     resource ACL
      └─ Tool, Function, Skill                    user-defined extensions
```

`KnowledgeFile` carries a compound unique index on `{knowledgeId, fileId}`, so the same file cannot
be attached to a knowledge base twice. `Config` carries `{userId, key}` unique, making it a
per-user key-value store.

### Credential storage

| Credential | At rest |
|---|---|
| Password | bcrypt, 12 rounds, `select: false` |
| One-time passcode | SHA-256, 5-attempt cap, **TTL index at 300s** |
| Refresh token | SHA-256 digest only |
| MFA secret | `select: false`, two-phase (`mfaPendingSecret` → `mfaSecret`) |
| MFA recovery codes | bcrypt, single-use via `usedAt` |
| **API key** | **plaintext** — the one exception, flagged in [SECURITY.md](SECURITY.md) |

Only two collections expire automatically: `Otp` after 5 minutes and `SecurityLog` after 30 days.
OTP consumption re-checks age explicitly in code because Mongo's TTL monitor runs on an interval
and is not precise.

`User.getActivePlan()` downgrades to `free` past `planExpiresAt`, so an expired plan needs no
scheduled job to take effect.

### Quota accounting

Daily usage resets by comparing a stored `YYYY-MM-DD` UTC key rather than by a cron job. All date
keys come from `utils/dateKeys.js`, which exists because divergent implementations once produced
`2026-8-30` and `2026-08-30` for the same day — the mismatch silently reset quotas.

The increment itself is a single atomic `findOneAndUpdate` with filter `dailyUsage: {$lt: limit}`
(`planGuard.js:148-178`). No match means the quota is exhausted. This replaced a
read-modify-write that concurrent requests could race past.

---

## Chat and streaming

`controllers/chatController.js` — the largest and most intricate part of the system.

### Two upstreams

| | AI Subscription | Nexusify |
|---|---|---|
| Env | `AISUBSCRIPTION_API_URL` | `NEXUSIFY_API_URL` |
| Shape | OpenAI chat-completions | `/v1/responses` |
| Timeout | 30s | 60s |
| Streaming | True token relay | Not supported upstream |

Both are called with plain `fetch`. The `openai` SDK appears only in `routes/audio.js`.

### Three streaming paths

**True SSE relay** (AI Subscription, `chatController.js:859`) reads `upstream.body`, splits on
newlines, and forwards `delta.content` and `delta.reasoning_content` as `chat.completion.chunk`
events, closing with `finish_reason: 'stop'` then `data: [DONE]`.

**Replayed streaming** (Nexusify, `:757`) fetches the complete answer first, then emits it in
256-character chunks while respecting `drain` backpressure. This is not token streaming — it looks
like it to the client, but latency to first token is full generation time. Headers include
`X-Accel-Buffering: no` so nginx does not buffer the response into uselessness.

**Tool-calling loop** (`streamWithTools`, `:423`), only when `ENABLE_TOOLS=1`. Up to 4 rounds:
send `TOOL_SCHEMAS`, accumulate `tool_calls` deltas, emit `{tool:{name,status:'running'}}` so the
UI can show progress, execute, append `role:'tool'` messages truncated to 8000 characters, repeat.
Stops early on `end_conversation`. Retries once without `tools` if the provider rejects the schema.

Available tools (`utils/tools.js`): `run_code`, `web_search`, `get_weather`, `search_past_chats`,
`recent_chats`, `create_diagram`, `end_conversation`.

When `chatId` is present the first SSE frame is `data: {"chatId": "..."}`. On mid-stream failure the
error handler writes `event: error` with a generic message and a request id, then `data: [DONE]` —
never the upstream error text, and never JSON appended to a committed event stream
(`errorHandler.js:90-100`).

### Memory

Injection: up to 50 recent `Memory` documents appended to the system prompt in a
`── USER MEMORY ──` block.

Extraction (`:546`): fires via `setImmediate` after every response, so it never delays the stream.
Skips messages under 30 characters and pure questions, caps at 100 auto-memories per user, asks
Nexusify for a JSON array of facts, saves at most 3 per turn with exact and prefix-regex
deduplication. Failures are silent by design.

### A note on the persistence path

`exports.openaiCompletions` reads `userId` from the **request body** and performs no ownership check
on the incoming `chatId` (`chatController.js:673`). `sendMessage` (`:1024`) does the opposite —
it ignores body `userId` entirely and enforces `assertChatOwner`. The inconsistency is documented
in [SECURITY.md](SECURITY.md).

---

## Retrieval

`controllers/ragController.js`. Two things about it are counter-intuitive enough to state plainly.

**There are no embeddings.** Despite `POST /api/rag/embed`, retrieval is lexical: `tokenize()`
lowercases and strips non-alphanumerics, `termFrequency()` builds a normalised term-frequency map,
and `cosineSimilarity()` compares those maps directly. There is no IDF term, despite comments
mentioning TF-IDF. No embedding model is called anywhere.

**Chunks live in process memory.** `const vectorStore = new Map()` (`ragController.js:17`), keyed by
`knowledgeId`. Chunks are lost on restart and are not shared between processes — so with more than
one worker, retrieval results depend on which worker serves the request. Only metadata and the
first 5000 characters of extracted text persist to MongoDB.

Defaults: chunk size 1000 with 200 overlap, `topK` 5, score threshold 0.05, max 50,000 characters
per file, max 200 chunks per file. Stored per user in `Config` under key `rag`.

Web search proxies Tavily, Brave, Serper, or Google CSE by user config. Web loading goes through
`utils/safeFetch.js` for SSRF protection with a 15-second timeout and 5 MB cap.

### Document parsing

`controllers/fileController.js`. Type is decided by **magic bytes**, not the declared MIME type —
`utils/fileType.js` reads the first 4100 bytes. `.docx` is disambiguated from a generic ZIP by
extension, since both are ZIP containers.

ZIP handling is hardened against archive bombs: max 1000 entries, 100 MB declared uncompressed,
5 MB per inlined entry, compression ratio ≤ 200. Only whitelisted source extensions are inlined,
and a `SECRET_NAME` regex excludes `.env*`, `.npmrc`, `.netrc`, `.pgpass`, `.htpasswd`, SSH keys,
`*.pem/.key/.pfx/.p12`, `credentials`, and `secrets.*` — those are counted by name but never read
into output. Temp files are unlinked in a `finally`.

---

## Code execution

The security boundary is **Docker container isolation**. Nothing else.

This is the second design. The first used `node:vm`, and `Function('return process')()` escaped it
and read `process.env` — every secret in the process. The route files carry that history in their
comments so nobody reintroduces an in-process executor.

`utils/sandbox.js:141-159` spawns `docker run` with:

```
--rm  --network none  --read-only  --user 1000:1000
--memory 256m  --memory-swap 256m       equal, so swap cannot be used to exceed it
--cpus 0.5  --pids-limit 128
--cap-drop ALL  --security-opt no-new-privileges
--tmpfs /tmp:rw,size=64m
--ulimit fsize=10000000  --ulimit nofile=256
-v <src>:/sandbox:ro                     source mounted read-only
```

Images: `python:3.12-slim`, `node:20-alpine`, `alpine:3.20`. Concurrency caps at 4, rejecting with
`busy: true` rather than queueing. Wall-clock timeout force-removes the container. Output truncates
at 50,000 bytes.

`envArgs()` (`:92`) validates variable names against `/^[A-Za-z_][A-Za-z0-9_]*$/`, rejects NUL
bytes and oversized values, and passes each as a separate argv entry — never through a shell. Five
unit tests cover this, including a name crafted to smuggle a second variable.

`BLOCKED_PATTERNS` matches `rm -rf /`, fork bombs, `mkfs`, and similar. The file states outright
that this is defence-in-depth and trivially bypassable. It is not the boundary. The container is.

User-defined tools follow the same rule: `buildToolProgram()` (`routes/tools.js:34`) never
interpolates input into source. It emits a prologue that reads `TOOL_INPUT_JSON` from the
environment.

---

## Real-time

Socket.IO on the same HTTP server. 1 MB buffer cap, 30-second ping timeout, CORS limited to
`ALLOWED_ORIGINS`.

**Handshake authentication is mandatory** (`middleware/socketAuth.js:24`). The token comes from
`handshake.auth.token` or the `Authorization` header, is verified as an access JWT, then checked
against `tokenVersion` and `banned`. Identity is taken **only** from the verified token.

This replaced an inline implementation where any client could emit `register` with an arbitrary
`userId` and join that user's private room, or join any chat by id. Three checks were missing: no
`tokenVersion` comparison, so a socket opened before a password change kept streaming; no ban
check; and presence tracked one socket per user, so closing one tab marked the user offline while
other tabs were still connected. Presence is now `Map<userId, Set<socketId>>`.

Room joins are authorised against MongoDB — `canAccessChat` requires ownership, `canAccessChannel`
allows creator or member. `typing` events broadcast only into rooms the socket has already joined,
so **room membership is itself the authorisation record**.

Note that Supabase tokens are not accepted on sockets; only local JWTs are.

---

## Rate limiting

`middleware/rateLimit.js`. Sliding window, Redis-preferred with an in-memory fallback.

Redis uses a sorted set per key: trim the window, count, compute `retryAfter` from the oldest
member, add with member `${now}-${8 hex}` so same-millisecond concurrent requests both count.
In-memory uses timestamp arrays swept every 60 seconds by an `unref`'d timer.

**Redis failure does not mean unlimited.** When Redis errors, `consume()` falls back to the
in-memory check rather than allowing the request — still enforced, just per-process. Only one
limiter opts into `failOpen: true`, and it is the global 300/min IP limiter, where a hard failure
would take the whole site down.

| Limiter | Limit | Window | Keyed by |
|---|---|---|---|
| `global` | 300 | 1 min | IP *(fail-open)* |
| `inference` | 60 | 1 min | user |
| `heavy` | 20 | 1 min | user |
| `sandbox` | 10 | 1 min | user |
| `outbound` | 30 | 1 min | user |
| `write` | 120 | 1 min | user |
| `admin` | 100 | 1 min | IP |
| `otpSend` | 3 | 15 min | hashed(email) |
| `otpSendPerIp` | 10 | 15 min | IP |
| `otpVerify` | 10 | 15 min | hashed(email) |
| `mfaVerify` | 10 | 15 min | user |
| `passwordChange` | 5 | 60 min | user |
| `coupon` | 10 | 60 min | user |
| `publicForm` | 5 | 60 min | IP |

Email keys are hashed (first 32 characters of a SHA-256) so addresses never reach Redis or logs in
clear. OTP send is limited per-address *and* per-IP: the first stops mail-bombing one address from
many IPs, the second stops enumeration from one IP across many addresses.

---

## Error handling

One shape for every client-facing error (`middleware/errorHandler.js`):

```json
{ "error": { "message": "...", "code": "...", "field": "...", "requestId": "..." } }
```

`message` is the real text only when the error is explicitly marked `expose: true` — which
`AppError` defaults to for status < 500. Anything else becomes `"Internal server error"`. Library
errors are normalised: Mongo `CastError` → `400 invalid_id`, duplicate key → `409 duplicate` with
the offending key **never echoed**, `AbortError` → `504 upstream_timeout`.

`requestId` is always present, is set by `requestContext` from a validated inbound `X-Request-Id`
or 8 fresh random bytes, and is exposed via CORS — so a user can quote it in a bug report and an
operator can find the exact log line.

Logging splits at status: ≥500 at error level with a stack in non-production, 4xx at debug so
scanners cannot flood the logs.

One inconsistency: the security-stack middlewares respond directly with a flatter
`{error: "...", code: "..."}` rather than going through this handler.

---

## Frontend

React 19, Vite 7, plain CSS Modules. No state library, no UI framework, no CSS framework.

**Routing is hand-rolled.** `react-router` is installed but nothing in `src/` imports it. Routing
is `history.pushState` plus a `popstate` listener over a five-entry table at `App.jsx:176-177`:
`/` landing, `/signin` auth, `/workspace` chat, `/plans` upgrade, `/ax-ctrl` admin, plus a
`/c/:chatId` regex for deep links. Unknown paths fall back to landing; there is no 404 route.
Both `vercel.json` and `netlify.toml` rewrite all paths to `index.html`, which is what makes this
work on refresh.

**The Markdown renderer is hand-written.** `marked` and `marked-highlight` are in `package.json`
but imported nowhere. `ChatMessages.jsx` implements its own renderer — a state machine splitting
fenced code from text that tolerates an unterminated fence mid-stream, then regex passes for
display and inline math, inline code, links, bare URLs, bullet and ordered lists, pipe tables, and
box-drawing diagrams. Output is injected via `dangerouslySetInnerHTML` with no sanitizer in the
dependency tree. Assessed in [SECURITY.md](SECURITY.md#client-side-rendering).

Actually used: `highlight.js`, `katex`, `mermaid` (initialised `securityLevel: 'loose'`).

Sixteen components exist but are imported nowhere, including `ErrorBoundary` and `Toast` — so there
is no error boundary mounted and no toast provider, despite both being written.

---

## Startup and shutdown

MongoDB is a hard dependency: `start()` awaits `connectDatabase()` before listening. Starting
without it produced a server that accepted traffic and returned `500` on every request.

Graceful shutdown on SIGTERM and SIGINT (`server.js:254`): close Socket.IO, stop accepting HTTP,
drain in-flight requests, disconnect MongoDB. A forced-exit timer at `SHUTDOWN_TIMEOUT_MS`
(default 15s) is `unref`'d so it cannot itself hold the process open. Without this, a deploy
severed in-flight SSE streams and could interrupt a Mongo write mid-operation.

`unhandledRejection` and `uncaughtException` both trigger the same shutdown. A process in an
undefined state must not keep serving traffic — log it and let the supervisor restart cleanly.
