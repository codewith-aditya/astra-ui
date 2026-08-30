# Development Guide

How to get AstraGPT running locally, what the test suites cover, and the
conventions the codebase follows.

The repository holds two independently installed packages:

| Directory | What it is | Package manager root |
| --- | --- | --- |
| `astra-backend/` | Express 4 API, Socket.IO, MongoDB | own `package.json` |
| `astragpt/` | React 19 + Vite 7 single-page app | own `package.json`, separate git repository |

There is no workspace tooling tying them together. Install and run each one
separately.

---

## Prerequisites

| Requirement | Version | Needed for |
| --- | --- | --- |
| Node.js | >= 20 | declared in `astra-backend/package.json` `engines` |
| MongoDB | any 6.x/7.x | the API refuses to start without a reachable database |
| Docker | any recent | only for the code-execution sandbox (`ENABLE_SANDBOX`, on by default) |

MongoDB is a hard dependency. `start()` in `astra-backend/server.js:230` awaits
`connectDatabase()` before binding the port, deliberately — an earlier version
accepted traffic without a database and returned 500 on every request.

Docker is only required if you exercise `/api/code/execute` or
`/api/sandbox/run`. Set `ENABLE_SANDBOX=0` to skip it.

---

## Backend setup

```bash
cd astra-backend
npm install
cp .env.example .env
```

Then fill in the four required values in `.env`. `config/env.js` validates them
and refuses to boot on a missing or weak one:

| Variable | Constraint |
| --- | --- |
| `MONGO_URI` | non-blank |
| `JWT_SECRET` | minimum 32 characters, and not one of the known-leaked values |
| `ADMIN_SECRET` | minimum 16 characters |
| `ALLOWED_ORIGINS` | required in production; defaults to the Vite dev origins otherwise |

Generate the two secrets rather than inventing them:

```bash
openssl rand -base64 48   # JWT_SECRET
openssl rand -hex 32      # ADMIN_SECRET
```

`config/env.js` keeps a `KNOWN_LEAKED` list and rejects any `JWT_SECRET` that
matches a previously-committed value, so copying an old secret forward will fail
validation rather than quietly working. See
[docs/CONFIGURATION.md](CONFIGURATION.md) for the full variable reference.

Verify the environment before starting:

```bash
npm run check:env      # prints "env OK", or names what is missing
npm run check:modules  # confirms every required module resolves
```

Run it:

```bash
npm run dev    # nodemon, restarts on change
npm start      # plain node server.js
```

The API listens on `PORT` (default 4000) on `0.0.0.0`. Two probes confirm it is
healthy — `GET /health` is dependency-free liveness, `GET /ready` reports the
database state and returns 503 when disconnected.

---

## Frontend setup

```bash
cd astragpt
npm install
npm run dev
```

Vite serves on port 5173 and proxies `/api/backend` to the backend. The target
is hardcoded in `astragpt/vite.config.js:10` and currently points at a remote
VPS address, not localhost — change it to `http://localhost:4000` to develop
against your own backend.

Frontend environment variables are the `VITE_*` family in `astragpt/.env`.
Everything with a `VITE_` prefix is **inlined into the built bundle** and is
therefore public. Never put a server-side secret there; see
[docs/CONFIGURATION.md](CONFIGURATION.md#vite-variables-are-public) for the
detail and for the three keys currently hardcoded in frontend source.

Available scripts:

```bash
npm run dev      # Vite dev server
npm run build    # production build into dist/
npm run preview  # serve the built bundle
npm run lint     # ESLint 9 flat config
npm test         # vitest run
npm run test:watch
```

---

## Running the tests

### Backend

Node's built-in test runner, no Jest or Mocha:

```bash
cd astra-backend
npm test              # both suites
npm run test:unit     # test/unit.test.js
npm run test:security # test/security.test.js
```

`test/security.test.js` runs against the real Express app and a real MongoDB
provided by `mongodb-memory-server`, so no external database is needed.

**`test/setup.js` must run before any application module is required.**
`config/env.js` validates at load time, so `applyTestEnv()` installs a valid
`JWT_SECRET` and `ADMIN_SECRET` first. It also points `DOTENV_CONFIG_PATH` at a
nonexistent file so your real `.env` cannot bleed into a test run, deletes the
SMTP, Upstash, Supabase and provider keys to keep the suite offline, and sets
`RATE_LIMIT_DISABLED=1`.

Coverage is 60 test cases: 40 security integration tests across 13 groups, 20
unit tests across 7. The security suite covers authentication (arbitrary
strings, forged signatures, refresh-token-as-access, stale `tokenVersion`,
banned accounts), NoSQL operator injection, cross-user access on accounts, chats
and tools, OTP hashing and lockout, the admin guard, coupon double-redemption,
error response shape, security headers, router mounting (including that no
wildcard sits at the application root), the full session rotation and
reuse-detection lifecycle, and MFA enrolment. The unit suite covers TOTP,
SSRF address filtering, zip-slip and header-injection in archive paths, input
validation, magic-byte file typing, and sandbox environment argument handling.

Known gaps: there are no dedicated tests for `waf.js`, `behaviorEngine.js`,
`aiDetection.js`, `cloudflareGuard.js`, `securityLogger.js`, or the Socket.IO
room-authorization paths, and rate limiting is disabled suite-wide via
`RATE_LIMIT_DISABLED=1`.

### Frontend

Vitest with jsdom, config in `astragpt/vitest.config.js`:

```bash
cd astragpt
npm test
```

Three specs exist — `src/test/settings.test.js`, `storage.test.js`,
`usage.test.js`. Component rendering is not covered.

---

## Conventions

**Backend style.** No semicolons, 4-space indentation, CommonJS `require`.
Route handlers are wrapped in `asyncHandler` from `utils/asyncHandler.js` —
Express 4 does not forward async rejections to the error handler, so an
unwrapped `async` handler that throws will hang the request.

**Frontend style.** ES modules, 4-space indentation, function components with
hooks. Styling is plain CSS Modules (`*.module.css`) — there is no Tailwind, no
CSS-in-JS, and no component library. Design tokens live in
`astragpt/src/index.css`.

**Errors.** Throw a typed error from `utils/errors.js` rather than calling
`res.status(...)` directly. The `expose` flag on `AppError` decides whether the
message reaches the client; anything unrecognised becomes a generic 500 with the
real detail logged server-side against a request id.

**Validation.** Coerce untrusted input through `utils/validate.js` before it
reaches a query. Its helpers strip MongoDB operators and prototype-pollution
keys, which is what stops `{"$gt": ""}` in an id field from matching every
document.

**Dates.** Use `utils/dateKeys.js` for day and month keys. It exists because
divergent implementations produced `2026-8-30` in one place and `2026-08-30` in
another, which silently reset daily quotas.

**Outbound HTTP.** Use `utils/safeFetch.js` for any request to a
user-influenced URL. It resolves DNS and rejects private and reserved address
space, defeating decimal, hex, short-form and IPv4-mapped-IPv6 encodings of
localhost.

**Logging.** Use `utils/logger.js`, never `console.log`. It redacts
secret-looking keys and values automatically and emits JSON in production.

---

## Things to know before you change something

**Router mount order is load-bearing.** `astra-backend/server.js:145-165`
mounts 19 routers at `/`, each declaring its own full `/api/...` path. A router
holding a parameterised path must be registered *after* routers declaring
literal paths under the same prefix. `routes/analytics.js` owns the literal
`/api/analytics/{dashboard,models,users,tokens}` and must precede
`routes/features.js`, which owns `/api/analytics/:userId` — otherwise `:userId`
captures `"users"` and shadows the admin endpoint entirely.

The same pattern appears within files: `DELETE /api/chats/all` is registered
before `DELETE /api/chats/:chatId`, and `/api/configs/default` before
`/api/configs/:key`. Both orderings are covered by tests.

**Middleware order is a security boundary, not a preference.** The stack in
`server.js` runs security headers, CORS, request context, body parsing, the
global rate limit, then the Cloudflare guard, WAF, behaviour engine and bot
detection before any route. Static `/uploads` is mounted *after* that stack —
an earlier version mounted it before the WAF, serving stored user content with
no inspection. Do not move it.

**The frontend has significant dead code.** Sixteen components exist but are
imported nowhere, including `ErrorBoundary` and `Toast`, so there is currently
no error boundary mounted. `react-router` is installed but never imported —
routing is hand-rolled with `history.pushState` in `App.jsx`. `marked` and
`marked-highlight` are dependencies but unused; `ChatMessages.jsx` implements
its own markdown renderer. Check whether a component is actually reachable
before investing in it.

**Markdown rendering emits raw HTML.** `ChatMessages.jsx` builds HTML strings
from model output and injects them with `dangerouslySetInnerHTML`, with no
sanitizer in the dependency tree. The XSS surface depends entirely on its
regexes. Treat any change there as security-sensitive.

**RAG has no vector embeddings.** Despite the name, `ragController.js` scores
with lexical term-frequency cosine similarity and stores chunks in a
process-local `Map`, so they are lost on restart and not shared across
processes. Only file and knowledge-base metadata persist to MongoDB.

---

## Deployment

Production deployment is documented separately in
[DEPLOY.md](../DEPLOY.md) — VPS provisioning via
`astra-backend/scripts/setup-vps.sh`, then `scripts/deploy.sh` for each release.
The deploy script pulls, installs both sides, runs the backend tests, builds the
frontend, validates nginx, reloads pm2, and health-checks — rolling back to the
previous commit automatically if the health check fails.

Frontend and backend must ship together. The auth contract changed on both
sides; deploying only the backend leaves an old frontend receiving 401 on every
request.
