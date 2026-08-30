# Configuration

Every environment variable the backend reads, what it does, and what happens when it is missing.

`astra-backend/config/env.js` validates configuration at load time. Run `npm run check:env` to
validate without starting the server — it prints warnings, then prints errors and throws if any
required value is missing or too weak.

The frontend reads `VITE_*` variables at **build** time. Vite inlines them into the bundle, so
every `VITE_*` value is public. Never put a secret in one.

---

## Required

The server refuses to boot without these.

| Variable | Rule |
|---|---|
| `MONGO_URI` | Non-blank connection string |
| `JWT_SECRET` | **Minimum 32 characters.** Also rejected if it matches a known-leaked value |
| `ADMIN_SECRET` | **Minimum 16 characters** |
| `ALLOWED_ORIGINS` | Comma-separated origins. Required in production; defaults to `http://localhost:5173,http://localhost:4173` otherwise |

`JWT_SECRET` is checked against a `KNOWN_LEAKED` list (`env.js:181-187`) containing a previously
committed secret plus `changeme`, `secret`, and `password`. If you supply one of those, startup
fails with a specific error rather than a generic length complaint. Generate real ones:

```bash
openssl rand -base64 48   # JWT_SECRET
openssl rand -hex 32      # ADMIN_SECRET
```

There is no default for any of these three, deliberately. A committed fallback secret is worse than
a failed boot.

---

## Server

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | Enables production-only paths: HSTS, bogon IP filtering, JSON logs |
| `PORT` | `4000` | |
| `TRUST_PROXY` | `1` in production, `0` otherwise | `false`/`0` → false, `true` → 1, numeric → hop count, else a comma list of addresses |
| `JSON_BODY_LIMIT` | `20mb` | Passed to `express.json` and `express.urlencoded` |
| `SHUTDOWN_TIMEOUT_MS` | `15000` | Forced-exit deadline during graceful shutdown |
| `LOG_LEVEL` | `info` in production, `debug` otherwise | |

`TRUST_PROXY` must be correct or per-IP rate limiting silently breaks. nginx terminates the
connection, so without it every request appears to come from `127.0.0.1` and all per-IP limits
collapse into one global bucket. It is coerced rather than passed through because Express parses an
empty string as an invalid IP list and throws at startup.

`SHUTDOWN_TIMEOUT_MS` must have a real default: `setTimeout(fn, undefined)` fires immediately and
would defeat the drain entirely.

---

## Authentication

| Variable | Default | Notes |
|---|---|---|
| `ACCESS_TOKEN_TTL` | `30m` | Any `jsonwebtoken` duration string |
| `REFRESH_TOKEN_TTL_DAYS` | `30` | |
| `JWT_ISSUER` | `astragpt` | **Defined but unused** — `utils/tokens.js` hardcodes the issuer |

---

## Inference upstreams

| Variable | Default |
|---|---|
| `AISUBSCRIPTION_API_URL` | `http://127.0.0.1:8080/v1/chat/completions` |
| `AISUBSCRIPTION_API_KEY` | *(empty)* |
| `NEXUSIFY_API_URL` | `https://api.nexusify.co/v1/responses` |
| `NEXUSIFY_API_KEY` | *(empty)* |
| `OPENAI_API_KEY` | *(empty)* — speech-to-text and text-to-speech only |

A missing key disables that upstream and logs a warning at startup rather than failing the boot.
Features degrade; the server still runs.

Note that `routes/tasks.js` defaults `NEXUSIFY_API_URL` to a **different host**
(`api.nexusify.xyz`) than `chatController.js` (`api.nexusify.co`). Set the variable explicitly to
avoid depending on which default applies.

---

## Optional services

Each group is all-or-nothing. Partial configuration disables the feature and logs
`[env] <name> disabled — missing …`.

| Feature | Variables | Effect when absent |
|---|---|---|
| Email | `SMTP_USER`, `SMTP_PASS` | OTP and notice emails resolve `delivered:false` instead of throwing |
| Supabase | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Secondary token verification fails closed |
| Redis | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Rate limits fall back to per-process memory |

Additional SMTP settings: `SMTP_HOST` (default `smtp.gmail.com`), `SMTP_PORT` (default `587`),
`SMTP_FROM` (falls back to `SMTP_USER`).

**Without Redis, rate limits are per-process.** Counters are not shared, so running multiple
workers multiplies every effective limit by the worker count. Single-process deployments are
unaffected.

---

## Code execution sandbox

| Variable | Default |
|---|---|
| `ENABLE_SANDBOX` | **enabled** (`1`) |
| `SANDBOX_IMG_PY` | `python:3.12-slim` |
| `SANDBOX_IMG_NODE` | `node:20-alpine` |
| `SANDBOX_IMG_SH` | `alpine:3.20` |
| `SANDBOX_MAX_CONCURRENT` | `4` |
| `SANDBOX_WARM_IMAGES` | disabled | Pre-pull images at boot so the first request does not pay the pull cost |

The sandbox requires a working Docker daemon. Without one, execution endpoints fail at runtime —
`ENABLE_SANDBOX` does not check for Docker at startup.

---

## Feature flags and misc

| Variable | Default | Notes |
|---|---|---|
| `ENABLE_TOOLS` | disabled (`1` to enable) | Agentic tool-calling loop in chat |
| `PUBLIC_BASE_URL` | *(empty)* | Empty means emit same-origin relative upload URLs |
| `MAX_UPLOAD_BYTES` | `20971520` | **Unused** — `middleware/uploads.js` hardcodes 20 MiB |
| `MAX_IMAGE_BYTES` | `10485760` | **Unused** — hardcoded 10 MiB |
| `TERMINAL_SERVERS` | *(empty)* | JSON array of `{id,url,name?,apiKey?}` |
| `DISCORD_CONTACT_WEBHOOK` | *(empty)* | Contact-form relay |
| `BEHIND_CLOUDFLARE` | disabled | See the mismatch note below |

---

## Undocumented variables

These are read directly from `process.env`, bypassing `config/env.js` — so they are not validated,
not reported by `check:env`, and absent from `.env.example`.

| Variable | Default | Effect |
|---|---|---|
| `CF_THREAT_THRESHOLD` | `30` | Cloudflare threat score above which a request is blocked |
| `BLOCKED_COUNTRIES` | *(none)* | Comma-separated ISO country codes |
| `BOT_DETECTION` | **on** | `false` to disable |
| `BOT_BLOCK_BOTS` | **off** | Bots are logged but not blocked until this is on |
| `BEHAVIOR_BLOCK_SCORE` | `80` | Anomaly score that triggers a block |
| `BEHAVIOR_WINDOW_MS` | `300000` | Scoring window |
| `RATE_LIMIT_DISABLED` | — | Test-only escape hatch |

`BOT_BLOCK_BOTS` defaults to **off**, so bot detection is log-only out of the box. That is the safe
default — a false positive silently blocks real users — but it means the feature does nothing
protective until you turn it on and review the logs.

---

## Known configuration inconsistencies

Verified in code. None break a default deployment, but each will surprise you.

**`BEHIND_CLOUDFLARE` truthiness disagrees between two files.** `config/env.js:107` tests
`=== '1'`; `middleware/cloudflareGuard.js:22` tests `=== 'true'`. The guard is what actually
enforces origin-direct blocking, so **set `BEHIND_CLOUDFLARE=true`** to enable it. Setting `1`
satisfies the config layer while leaving the guard off.

**Four variables are defined but unconsumed:** `JWT_ISSUER`, `SUPABASE_JWT_SECRET`,
`SMTP_REJECT_UNAUTHORIZED`, `MAX_UPLOAD_BYTES`, `MAX_IMAGE_BYTES`. Changing them has no effect.
The issuer and byte limits are hardcoded at their point of use; local Supabase JWT verification is
not implemented (`supabaseAuth.js` calls the Supabase API instead).

**Real-IP property names diverge.** `cloudflareGuard` sets `req.clientIP`; `rateLimit` and
`errorHandler` read `req.realIp`; `requestContext` reads `req.clientIp`. Only the capital-P form is
ever assigned, so the others fall through to `req.ip` — correct as long as `TRUST_PROXY` is set,
which is why this has not caused a visible problem.

**`env.report()` is exported but not called from `server.js`.** Module load populates
`env.errors`; the hard failure only happens where `report()` runs, which is `npm run check:env`.
Run it in your deploy pipeline — the deploy script does.

---

## Frontend variables

Build-time, public, all inlined into the bundle.

| Variable | Purpose |
|---|---|
| `VITE_BACKEND_URL` | Backend base URL |
| `VITE_GA_MEASUREMENT_ID` | Google Analytics 4 |
| `VITE_SENTRY_DSN` | Sentry, production only |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | Supabase client |
| `VITE_RESEARCH_API_URL` | GPT-Researcher endpoint |
| `VITE_STRIPE_PAYMENT_LINK` | Present but unused in the upgrade flow |
| `VITE_FIREBASE_*` | Firebase init — not wired into auth |
| `VITE_GOOGLE_CLIENT_ID`, `VITE_GITHUB_CLIENT_ID`, `VITE_NOTION_CLIENT_ID` | OAuth client ids |

`VITE_TAVILY_KEY` also exists and is a genuine problem: it ships a search-provider API key to every
browser. See [SECURITY.md](SECURITY.md#client-side-secrets). Web search belongs behind the backend
proxy, which already exists at `POST /api/rag/web/search`.
