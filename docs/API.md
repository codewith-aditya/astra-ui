# API Reference

Base URL in production: `https://astragpt.in`. Locally: `http://localhost:4000`.

Most paths begin with `/api`. A few do not, for historical reasons — those are marked. Endpoint
paths here were read from the route files rather than from older documentation, which had drifted
substantially.

---

## Authentication

Send an access token as a bearer header:

```
Authorization: Bearer <access_token>
```

A bare user id is never accepted. Tokens come from `POST /api/auth/verify-otp` and are refreshed
through `POST /api/auth/refresh`.

Admin endpoints use a separate credential — an `x-admin-secret` header — and most of them do **not**
require a user token. This is operator access, not a user role.

### Error shape

```json
{
  "error": {
    "message": "Human-readable message",
    "code": "machine_readable_code",
    "field": "fieldName",
    "requestId": "a1b2c3d4"
  }
}
```

`message` is generic for 5xx responses. `field` appears only on validation errors. `requestId` is
always present and matches the `X-Request-Id` response header — quote it in bug reports.

Common codes: `missing_token`, `invalid_token`, `token_expired`, `token_revoked`, `unknown_user`,
`account_banned`, `not_owner`, `model_not_allowed`, `daily_limit_reached`, `rate_limited`,
`cors_denied`, `payload_too_large`, `file_too_large`, `upstream_timeout`.

### Rate limit headers

Every rate-limited response carries `X-RateLimit-Limit` and `X-RateLimit-Remaining`. A 429 adds
`Retry-After` in seconds.

---

## Health

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/health` | none | Liveness. Dependency-free by design, so a database outage cannot cause a restart loop. |
| GET | `/ready` | none | Readiness. Returns 503 when MongoDB is disconnected. |

Both are registered before the security stack and are not rate limited.

---

## Authentication endpoints

Mounted at `/api/auth`.

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/send-otp` | none | 3 per 15 min per email (hashed), 10 per 15 min per IP |
| POST | `/login-request` | none | Password login. Constant-time against a dummy hash when the user does not exist. |
| POST | `/verify-otp` | none | Returns a token pair. Gated on TOTP when MFA is enabled. |
| POST | `/forgot-password` | none | |
| POST | `/reset-password` | none | Bumps `tokenVersion`, clears all sessions |
| POST | `/refresh` | none | Rotating refresh with reuse detection — see below |
| POST | `/logout` | required | Removes the current session |
| GET | `/account` | required | |
| GET | `/account/:userId` | required | Self only |
| POST | `/update-profile` | required | |
| POST | `/change-password` | required | Current password mandatory when one is set. Bumps `tokenVersion`. |
| POST | `/revoke-sessions` | required | `?keepCurrent` to stay signed in here |

**Refresh semantics matter.** Each refresh returns a new pair and invalidates the old refresh token.
Presenting an already-rotated token is treated as a replay: every session for that user is revoked.
Store the new refresh token and never retry a refresh with an old one.

### MFA

Mounted at `/api/mfa`. All require auth.

| Method | Path | Notes |
|---|---|---|
| POST | `/setup` | Stores a *pending* secret. Returns the secret and a QR data URL. |
| POST | `/verify` | Promotes pending to active. Returns one-time recovery codes. |
| POST | `/disable` | Requires **both** a TOTP code and the account password |
| POST | `/recovery-codes/regenerate` | Also revokes all sessions |
| GET | `/status` | |

---

## Chat and inference

### Completions

| Method | Path | Auth | Limits |
|---|---|---|---|
| POST | `/v1/chat/completions` | required | plan guard + 60/min |
| POST | `/v1/responses` | required | same handler; accepts a plain `input` string |
| GET | `/v1/models` | none | Static catalogue |
| GET | `/v1/me` | required | Profile and chat count |

OpenAI-compatible request shape:

```json
{
  "model": "deepseek-v4-flash",
  "messages": [{ "role": "user", "content": "Hello" }],
  "stream": true,
  "chatId": "optional-for-persistence"
}
```

**Streaming.** With `stream: true` the response is Server-Sent Events. If `chatId` is present the
first frame is `data: {"chatId":"..."}`. Content arrives as `chat.completion.chunk` events carrying
`delta.content`, and reasoning models also emit `delta.reasoning_content`. The stream closes with
`finish_reason: "stop"` followed by `data: [DONE]`.

A mid-stream failure emits `event: error` with a generic message, then `[DONE]`. The upstream error
text is never forwarded.

Two upstream providers back this endpoint with different streaming characteristics. One relays SSE
genuinely token by token; the other has no streaming API, so the full response is fetched and then
replayed in 256-character chunks with backpressure handling. Both look identical to a client, but
time-to-first-token differs.

When `ENABLE_TOOLS=1`, a tool-calling loop runs up to 4 rounds and emits
`{"tool":{"name":"...","status":"running"}}` frames between content.

**Persistence is opt-in** via `chatId` plus `userId`. Note that this path currently reads `userId`
from the request body and does not verify chat ownership — see `docs/SECURITY.md`. Database errors
during persistence are swallowed so the stream still completes.

### Chats and messages

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/chat` | required | Persists a user message; no LLM call |
| POST | `/api/message` | required | Persists one message into an owned chat |
| GET | `/api/chats/:userId` | required | Self only. `?limit` 1–200, default 100 |
| GET | `/api/messages/:chatId` | required | Owner only. Max 2000. |
| DELETE | `/api/chats/all` | required | Deletes all chats and messages |
| DELETE | `/api/chats/:chatId` | required | Owner only |
| GET | `/api/chats/:chatId/export` | required | Markdown download |
| GET / POST | `/api/chats/:chatId/system-prompt` | required | Max 2000 chars |
| POST | `/api/chats/:chatId/pin` | required | |
| POST | `/api/chats/:chatId/archive` | required | |
| GET | `/api/chats/archived` | required | |
| POST | `/api/chats/:chatId/tags` | required | Max 10 tags |
| GET | `/api/tags` | required | |
| POST | `/api/chats/import` | required | Max 50 chats, 500 messages each |
| POST | `/api/messages/:messageId/reaction` | required | `like`, `dislike`, or `null` |

`DELETE /api/chats/all` is registered before `/:chatId` deliberately — reverse that order and
`"all"` would be parsed as a chat id.

### Memory

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/memory/:userId` | required | Self only. Max 200. |
| POST | `/api/memory/:userId` | required | Max 500 chars, deduplicated |
| DELETE | `/api/memory/:userId/all` | required | |
| DELETE | `/api/memory/item/:memoryId` | required | Owner only |

Up to 50 recent memories are injected into the system prompt. Extraction runs automatically after
each response, skipping short messages and pure questions, capped at 100 automatic memories per user
and 3 new facts per turn. Extraction failures are silent by design.

### Usage and plans

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/usage/:userId` | required | Self only |
| POST | `/api/plan` | **admin secret only** | `plan`, `durationDays` 1–3650 |

---

## Knowledge and retrieval

**Retrieval is lexical, not vector-based.** Despite the `/embed` path name there is no embedding
model: `ragController.js` tokenises, builds term-frequency maps, and compares them by cosine
similarity. There is no IDF term.

**Chunks live in a process-local `Map`.** They are lost on restart and are not shared across
processes. Only file and knowledge-base *metadata* persists to MongoDB, along with the first 5000
characters of extracted text. Anything relying on retrieval must re-embed after a restart. This is
the single most important operational caveat in the API.

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/rag/embed` | required | Chunk and store text |
| POST | `/api/rag/query` | required | Similarity search |
| GET / POST | `/api/rag/config` | required | `topK` 5, threshold 0.05, chunk 1000/overlap 200 |
| POST | `/api/rag/process` | required | Process one file |
| POST | `/api/rag/process/batch` | required | Max 50 files |
| POST | `/api/rag/web/search` | required | Tavily, Brave, Serper, or Google CSE |
| POST | `/api/rag/web/load` | required | SSRF-protected fetch, 15 s, 5 MB cap |

Web search returns 503 when no provider key is configured and 502 on a provider error.

Knowledge base CRUD:

| Method | Path | Auth |
|---|---|---|
| GET / POST | `/api/knowledge` | required |
| GET / PUT / DELETE | `/api/knowledge/:id` | required |
| POST / GET | `/api/knowledge/:id/files` | required |
| DELETE | `/api/knowledge/:id/files/:fileId` | required |
| POST | `/api/knowledge/:id/reset` | required |

---

## Files

| Method | Path | Auth | Limits |
|---|---|---|---|
| POST | `/api/upload` | required | 20 MB, 20/min. Field `file`. |
| POST | `/api/upload/image` | required | 10 MB, 20/min. Field `image`. |
| DELETE | `/api/upload/image/:filename` | required | Owner only |
| GET | `/api/upload/image/stats` | admin secret | |
| POST | `/api/generate` | required | Returns a document |
| POST | `/generate-project` | required | Streams a ZIP. Note: no `/api` prefix. |

Accepted documents: `.pdf`, `.docx`, `.zip`, `.txt`, `.md`, `.markdown`, `.csv`. Images: `.png`,
`.jpg`, `.jpeg`, `.gif`, `.webp`.

Type detection uses magic bytes, not the declared MIME type. Extracted text caps at 50,000
characters. ZIP inspection is bounded and files matching secret-like names (`.env*`, SSH keys,
`*.pem`, `credentials`) are listed by name but never inlined.

`POST /api/generate` accepts `format` of `pdf`, `docx`, `txt`, `md`, `csv`, or `zip`, and parses
headings, bullets, and bold markers from `content`.

---

## Code execution

Both endpoints run code in a Docker container with no network, a read-only root filesystem, dropped
capabilities, and hard memory, CPU, and process limits. See `docs/SECURITY.md` for the full profile.

| Method | Path | Auth | Limits |
|---|---|---|---|
| POST | `/api/code/execute` | required | 10/min. `code` ≤ 100k chars, `timeout` 100–30000 ms |
| GET / POST | `/api/code/config` | required (POST also admin) | |
| POST | `/api/sandbox/run` | required | 10/min. Languages: python, javascript, bash |
| GET | `/api/sandbox/health` | required | Languages and Docker version |

`POST /api/code/execute` accepts `javascript` and `python`. A 429 with `busy: true` means the
concurrency cap (default 4) is saturated — retry rather than treating it as a failure.

---

## Tools, functions, skills

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET / POST | `/api/tools` | required | Max 100 per user |
| GET / PUT / DELETE | `/api/tools/:id` | required | |
| POST | `/api/tools/:id/execute` | required | **Owner only.** Runs in the sandbox. |
| GET / POST | `/api/tools/:id/valves` | required | |
| GET / POST | `/api/functions` | required | Max 100. Types: filter, action, pipe. |
| GET / PUT / DELETE | `/api/functions/:id` | required | |
| POST | `/api/functions/:id/toggle` | required | |
| GET / POST | `/api/skills` | required | Max 200 |
| GET / PUT / DELETE | `/api/skills/:id` | required | |

Tool input is never interpolated into source. A per-language prologue reads `TOOL_INPUT_JSON` from
the environment instead, which removes code injection through arguments.

`GET /api/tools` without a `userId` query returns your own tools plus any marked active.

Functions are stored but **not executed anywhere** in the current code.

### MCP

This is an MCP *client*: it registers remote MCP servers and proxies calls to them. It does not
expose AstraGPT's own capabilities over MCP.

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/mcp/servers` | required | Max 25. Attempts tool discovery. |
| GET | `/api/mcp/servers` | required | API keys redacted to `hasApiKey` |
| DELETE | `/api/mcp/servers/:id` | required | |
| POST | `/api/mcp/execute` | required | 30/min |

Connection state is process-local, so after a restart a server shows `disconnected` and must be
re-discovered before `/execute` will accept it. All outbound calls go through the SSRF-protected
fetch wrapper.

---

## Audio

| Method | Path | Auth | Limits |
|---|---|---|---|
| POST | `/api/audio/transcribe` | required | 25 MB, 20/min. Field `file`. |
| POST | `/api/audio/synthesize` | required | Text ≤ 4096 chars. Returns `audio/mpeg`. |
| GET / POST | `/api/audio/config` | required | |

Requires `OPENAI_API_KEY`. Voices are the six OpenAI voices; `speed` accepts 0.25–4.

---

## Productivity

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET / POST | `/api/prompts` | required | Max 200 |
| PUT / DELETE | `/api/prompts/:promptId` | required | |
| POST | `/api/prompts/:promptId/use` | required | Increments usage |
| GET / POST | `/api/notes` | required | Max 500 |
| PUT / DELETE | `/api/notes/:noteId` | required | |
| GET / POST | `/api/folders` | required | Max 100 |
| PUT / DELETE | `/api/folders/:id` | required | Delete cascades to descendants |
| POST | `/api/folders/:id/chats` | required | Move a chat |
| GET / POST | `/api/keys` | required | Max 10. Full key returned once. |
| DELETE | `/api/keys/:keyId` | required | Soft deactivate |
| GET | `/api/config/export` | required | Prompts and notes as JSON |
| POST | `/api/config/import` | required | |

---

## Collaboration

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET / POST | `/api/channels` | required | |
| GET / PUT / DELETE | `/api/channels/:id` | required | Update and delete are creator only |
| GET / POST | `/api/channels/:id/messages` | required | Paginated, limit ≤ 100, content ≤ 5000 |
| DELETE | `/api/channels/:id/messages/:msgId` | required | Author only |
| GET / POST | `/api/groups` | required | |
| GET / PUT / DELETE | `/api/groups/:id` | required | Owner only for writes |
| POST | `/api/groups/:id/members` | required | Owner only |
| DELETE | `/api/groups/:id/members/:userId` | required | Owner or self |
| GET / PUT | `/api/groups/:id/permissions` | required | Owner only |

Posting a channel message emits a `channel:message` Socket.IO event into `channel:<id>`.

**Public channels are readable and postable by any authenticated user.** That is intended, but worth
knowing before treating one as private.

---

## Evaluations

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET / POST | `/api/evaluations` | required | Types: rating, comparison, comment |
| GET | `/api/evaluations/history` | required | `?mine`, `?model` |
| DELETE | `/api/evaluations/:id` | required | Owner only |
| GET | `/api/evaluations/leaderboard` | **none** | Elo, K=32, base 1500 |

The leaderboard has no auth and no rate limit, and recomputes Elo over every comparison document on
each request. Treat it as a known performance and abuse issue, not a model to copy.

---

## Analytics

| Method | Path | Auth |
|---|---|---|
| GET | `/api/analytics/dashboard` | required |
| GET | `/api/analytics/models` | required |
| GET | `/api/analytics/tokens` | required — `?days` 1–365 |
| GET | `/api/analytics/:userId` | required, self only |
| GET | `/api/analytics/users` | **admin secret only** |

Token counts are estimated as `ceil(contentLength / 4)`, not measured.

Router registration order is load-bearing here: literal paths like `/api/analytics/users` must be
registered before the parameterised `/api/analytics/:userId`, or the latter captures the former.

---

## Configuration

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/configs/default` | **none** | Public so the client can read defaults pre-login |
| POST | `/api/configs/default` | required + admin | |
| GET / POST | `/api/configs` | required | Bulk, ≤ 100 keys |
| GET / PUT / DELETE | `/api/configs/:key` | required | |

The `__default__` scope is unreachable through the per-user routes.

---

## Coupons

Two independent implementations exist with different validation rules. Prefer the `/api/coupon/*`
pair; the root-level pair predates it.

| Method | Path | Auth |
|---|---|---|
| POST | `/api/coupon/validate` | required |
| POST | `/api/coupon/redeem` | required |
| POST | `/validate-coupon` | required — no `/api` prefix |
| POST | `/redeem-coupon` | required — no `/api` prefix |

Both limit to 10 attempts per hour. Redemption claims the coupon with a conditional update before
granting a plan, so concurrent redemptions cannot double-spend.

---

## Public and miscellaneous

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/contact` | **none** | 5 per hour per IP |
| GET | `/api/banners` | **none** | |
| POST | `/api/banners` | inline secret check | See the security note below |
| DELETE | `/api/banners/:bannerId` | inline secret check | |
| GET | `/api/terminals` | required | Targets come only from configuration |
| ALL | `/api/terminals/:serverId/*` | required | Proxy, 30 s timeout, 30/min |
| POST | `/api/tasks/title` | required | Auto-title |
| POST | `/api/tasks/tags` | required | |
| POST | `/api/tasks/emoji` | required | |
| POST | `/api/tasks/followup` | required | |
| POST | `/api/tasks/autocomplete` | required | |
| POST | `/api/tasks/query` | required | |
| DELETE | `/api/user/account` | required | Hard-deletes the account and all data |

The banner write endpoints use neither `auth` nor `adminGuard` — they perform an inline non
constant-time secret comparison and bypass the admin rate limiter. Documented as a known issue.

The terminal proxy strips the caller's `Authorization` and cookies rather than forwarding them,
injecting the configured server's own key instead, and passes caller identity as `x-astra-user`.

---

## Admin

All of `/api/ax-ctrl/*` requires the `x-admin-secret` header and is limited to 100 requests per
minute per IP. None of it requires a user token.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/ax-ctrl/stats` | Totals, active users, 7-day chart, revenue |
| GET | `/api/ax-ctrl/users` | 100 most recently active |
| POST | `/api/ax-ctrl/users/:userId/plan` | |
| POST | `/api/ax-ctrl/users/:userId/ban` | Accepts a `banned` boolean, so it also unbans |
| DELETE | `/api/ax-ctrl/users/:userId` | Deletes the user and their chats |
| POST | `/api/ax-ctrl/send-notice` | Templated email |
| GET / POST | `/api/ax-ctrl/coupons` | |
| POST | `/api/ax-ctrl/coupons/:code/toggle` | |
| DELETE | `/api/ax-ctrl/coupons/:code` | |
| GET | `/api/ax-ctrl/logs` | Last 100 admin log entries |
| GET | `/api/ax-ctrl/security/logs` | `?level`, `?limit` 1–500, `?ip` |

Admin logs live in a 200-entry in-process array and are lost on restart. Persistent security events
go to MongoDB with a 30-day TTL.

---

## WebSocket

Socket.IO on the same HTTP server. Authentication is **mandatory at handshake** — pass the access
token as `auth.token` or an `Authorization` header. The token is verified, then checked against
`tokenVersion` and the ban flag. Supabase tokens are not accepted here.

Identity is never taken from an event payload. There is no `register` event.

**Client events:** `join-chat`, `leave-chat`, `typing`, `channel:join`, `channel:leave`,
`channel:typing`. Joins are authorised against ownership or membership in MongoDB. Typing events
only broadcast into rooms the socket has already joined, so room membership *is* the authorisation
record.

**Server events:** `channel:message`, `typing`, `channel:typing`.

Buffer cap is 1 MB and ping timeout is 30 seconds. Presence tracks a set of socket ids per user, so
closing one tab does not mark a user offline while others remain open.
