<div align="center">

# 🔱 AstraGPT

**World-class AI, made in India.**

An AI assistant platform built by [Tantra AI Labs](#-about-us) — streaming chat, retrieval over your own documents,
sandboxed code execution, and a defence-in-depth security stack, in one self-hostable system.

[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![React](https://img.shields.io/badge/react-19-61DAFB?logo=react&logoColor=black)](https://react.dev)
[![Vite](https://img.shields.io/badge/vite-7-646CFF?logo=vite&logoColor=white)](https://vite.dev)
[![MongoDB](https://img.shields.io/badge/mongodb-8.x-47A248?logo=mongodb&logoColor=white)](https://mongodb.com)
[![Tests](https://img.shields.io/badge/tests-60%20cases-brightgreen)](#testing)
[![License](https://img.shields.io/badge/license-none%20yet-lightgrey)](#license)

[Getting Started](#-getting-started) · [Architecture](docs/ARCHITECTURE.md) · [API Reference](docs/API.md) · [Configuration](docs/CONFIGURATION.md) · [Security](docs/SECURITY.md)

</div>

---

## What AstraGPT is

A production AI assistant, not a demo wrapper. A user signs in with an email one-time
passcode, talks to a model over a streamed connection, attaches PDFs and spreadsheets that get
parsed and searched, runs generated code inside a locked-down container, and organises
the result into folders, notes, and shared channels. An operator gets per-plan quotas,
a web application firewall, behavioural anomaly scoring, and a 30-day security audit trail.

Everything runs on infrastructure you control. The inference upstream is configurable, the
database is your MongoDB, and code execution happens in Docker containers on your host.

### Highlights

| | |
|---|---|
| **Streaming chat** | Server-sent events with true token-level relay, reasoning-trace parsing, and an agentic tool-calling loop (up to 4 rounds) |
| **Bring your own documents** | PDF, DOCX, CSV, ZIP, and Markdown parsed server-side; lexical retrieval with configurable chunking and scoring |
| **Sandboxed execution** | Python, Node, and shell in Docker with no network, dropped capabilities, read-only rootfs, and hard memory/CPU/PID ceilings |
| **Real-time collaboration** | Authenticated Socket.IO with per-room authorisation — channels, threads, presence, and typing indicators |
| **Security in depth** | CDN validation → WAF → behavioural scoring → bot fingerprinting, ahead of every route |
| **Session integrity** | Rotating refresh tokens with replay detection, TOTP two-factor, hashed recovery codes, and sign-out-everywhere |
| **Operator tooling** | Plan and quota administration, coupon redemption, live security dashboard, templated user notices |
| **Extensibility** | User-defined tools, prompt library, knowledge bases, and a Model Context Protocol client registry |

---

## 🚀 Getting Started

### Prerequisites

- **Node.js ≥ 20** (enforced by `package.json` `engines`)
- **MongoDB** — any reachable instance, local or hosted
- **Docker** — required only for the code-execution sandbox. Without it, sandbox endpoints fail closed and nothing else is affected.

### Backend

```bash
cd astra-backend
npm install
cp .env.example .env
```

Three variables are mandatory and the server refuses to boot without them:

```bash
MONGO_URI=mongodb://localhost:27017/astragpt
JWT_SECRET=$(openssl rand -base64 48)      # minimum 32 characters
ADMIN_SECRET=$(openssl rand -hex 32)       # minimum 16 characters
```

`JWT_SECRET` is additionally checked against a list of known-leaked values and rejected if it
matches. This is deliberate — a previous secret for this project leaked, and the validator
exists so it cannot be reintroduced.

Verify the environment, then start:

```bash
npm run check:env    # prints "env OK", or names exactly what is missing
npm run dev          # nodemon on http://localhost:4000
```

Confirm it is alive:

```bash
curl -s localhost:4000/health   # {"status":"ok","service":"AstraGPT API",...}
curl -s localhost:4000/ready    # {"status":"ready","database":"connected"}
```

### Frontend

> **Note:** the frontend lives in `astragpt/`, which is a **separate Git repository** and is not
> tracked by this one. See [Repository layout](#repository-layout).

```bash
cd astragpt
npm install
npm run dev          # Vite on http://localhost:5173
```

Vite proxies `/api/backend` to the configured backend host, so both halves work together in
development without CORS configuration.

### Optional capabilities

Each of these is off by default and fails closed when unconfigured — a missing key disables a
feature, it never degrades security or crashes the server.

| Set these | To enable |
|---|---|
| `AISUBSCRIPTION_API_KEY` | The primary inference upstream |
| `NEXUSIFY_API_KEY` | Secondary upstream; auto-titling, tags, and memory extraction |
| `OPENAI_API_KEY` | Speech-to-text and text-to-speech |
| `SMTP_USER` + `SMTP_PASS` | One-time passcode delivery and operator notices |
| `UPSTASH_REDIS_REST_URL` + `..._TOKEN` | Rate limiting shared across processes rather than per-process |
| `ENABLE_TOOLS=1` | The agentic tool-calling loop |

Full reference: [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

---

## Repository layout

```
.
├── astra-backend/        Express API, Socket.IO, security stack, data models
│   ├── config/env.js     Boot-time environment validation
│   ├── controllers/      Chat, RAG, files, generation, admin
│   ├── middleware/       Auth, WAF, rate limits, plan guard, uploads
│   ├── models/           24 Mongoose schemas
│   ├── routes/           24 route modules
│   ├── utils/            Tokens, sandbox, SSRF-safe fetch, validation
│   └── test/             60 test cases on Node's built-in runner
│
├── astragpt/             React 19 + Vite 7 frontend  ← separate Git repository
├── docs/                 The documentation set below
├── UI/                   Design notes
└── DEPLOY.md             VPS deployment runbook (written in Hinglish)
```

`astragpt/` has its own `.git` directory and is not a submodule of this repository. It is
excluded from version control here, so a fresh clone of this repository gives you the backend
only. Before publishing it anywhere, note that its existing commit history contains a live
Firebase API key — see [Known issues](#known-issues).

---

## Documentation

| Document | Contents |
|---|---|
| **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** | Request lifecycle, middleware order, data model, streaming internals, retrieval pipeline |
| **[docs/API.md](docs/API.md)** | Every HTTP endpoint with guards and parameters; Socket.IO events; error shapes |
| **[docs/CONFIGURATION.md](docs/CONFIGURATION.md)** | Every environment variable, its default, and what breaks without it |
| **[docs/SECURITY.md](docs/SECURITY.md)** | Threat model, security controls, audited weaknesses, disclosure process |
| **[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)** | Local setup, testing, conventions, deployment |

---

## Plans and limits

Enforced in `astra-backend/middleware/planGuard.js`. Quotas are applied with an atomic
conditional increment, so concurrent requests cannot exceed a daily cap.

| Plan | Messages/day | Messages/min | Models | Price |
|---|---|---|---|---|
| **Free** | 50 | 10 | Astra Flash, Astra Think | ₹0 |
| **Pro** | 500 | 25 | + Astra Pro, Astra Coder Next, Astra Ultra | ₹399/mo · ₹329/mo annual |
| **Pro+** | 2,500 | 40 | All | ₹799/mo · ₹649/mo annual |
| **Ultra** | 9,999 | 60 | All | ₹1,299/mo · ₹1,099/mo annual |

The plan guard **fails closed**: if the database or rate-limit backend is unreachable it returns
`503`, never an unmetered request. Plans are granted by coupon redemption or by an operator;
there is no payment processor wired in.

> Two numbers to reconcile before launch: the landing page advertises "20 queries per day" on
> the free tier while the backend enforces 50. The code is the source of truth above.

---

## Testing

```bash
cd astra-backend
npm test               # 60 cases: 40 security integration + 20 unit
npm run test:security  # against a real in-memory MongoDB via supertest
npm run test:unit      # pure functions: TOTP, SSRF filtering, zip-slip, validation
npm run check:env      # environment validation
npm run check:modules  # module resolution
```

No external test framework — Node's built-in `node:test` runner with `mongodb-memory-server`.
The suite isolates itself from your real `.env` by pointing `DOTENV_CONFIG_PATH` at a
nonexistent file, so a developer's live credentials can never bleed into a test run.

Coverage is concentrated on the security boundary: token forgery and expiry, cross-user access
attempts, NoSQL operator injection, refresh-token replay, coupon double-spend, admin gating,
zip-slip, and SSRF address filtering. The WAF, behavioural engine, and bot detection currently
have no dedicated tests, and rate limiting is disabled during the suite.

---

## Known issues

Carried forward from `DEPLOY.md` and confirmed against the code. These are live and unresolved.

**Provider keys are compiled into the frontend bundle.** `astragpt/src/lib/api.js` defines
`AISUBSCRIPTION_API_KEY` (line 12) and `FALLBACK_API_KEY` (line 17) as literal constants, and
`astragpt/src/lib/builderApi.js` defines `BUILDER_KEY` (line 3). Anything in frontend source
ships to every visitor and is readable in DevTools. All three need rotating, and rotation alone
is not a fix while the constants remain in frontend source — they belong behind a backend proxy.

**A Firebase API key is in `astragpt`'s Git history.** `astragpt/src/components/.txt` contains a
live key for project `astragpt-fc474`. An ignore rule does not help once something is committed;
the history needs rewriting before that repository is published anywhere.

**Model output is rendered as unsanitised HTML.** `ChatMessages.jsx` implements a hand-written
Markdown renderer that emits HTML strings into `dangerouslySetInnerHTML`, with no sanitizer in
the dependency tree. Mermaid is initialised with `securityLevel: 'loose'`. See
[docs/SECURITY.md](docs/SECURITY.md#client-side-rendering) for the full assessment.

**Deploy both halves together.** The authentication contract changed on both sides. Deploying
only the backend leaves the old frontend receiving `401` on every request.

Also worth resolving: `react-router` is installed but unused (routing is hand-rolled via
`history.pushState`); eight page components exist but are imported nowhere, so their backend
endpoints are live while the UI is unreachable; and `redisRateLimit.js` is superseded legacy that
fails open in every branch.

---

## 💜 About Us

<div align="center">

### Tantra AI Labs

**World-class AI, made in India.**

</div>

AstraGPT started from a straightforward observation: the best AI tools were being built for
somewhere else. They assumed your first language, your payment methods, your latency to a
data centre on another continent, and your willingness to hand conversations to a company with
no obligation to you.

We thought India deserved a first-class one of its own — not a localised port, but a system
designed from the first commit for the people who would actually use it. A student in Kochi
debugging at 2am. A founding engineer in Bengaluru shipping under deadline. An indie hacker in
Pune who switches between Hindi and English mid-sentence without thinking about it, and expects
the tool to keep up.

So we built for them specifically. AstraGPT speaks Hindi, English, and the Hinglish that most
people actually use. It runs close to its users instead of an ocean away. And it treats your
conversations as yours: we do not sell your data, we do not share it, and the whole system is
self-hostable if you would rather not take our word for it.

### What we believe

**Speed is a feature.** An assistant that takes eight seconds to start answering is a different
product from one that starts in two hundred milliseconds. We optimise for the second one.

**Security is not a roadmap item.** Every request passes a firewall, a behavioural scorer, and a
bot fingerprinter before it reaches a route. Credentials are hashed, sessions are revocable,
refresh-token replay wipes every session on the account, and untrusted code runs in a container
with no network and no capabilities. When a check cannot complete, it fails closed. The
`## Known issues` section above exists because we would rather write down what is still wrong
than pretend it isn't.

**Your data is yours.** No selling, no sharing, no training on your conversations. Self-host it
if you prefer — the whole stack is designed to run on infrastructure you own.

**Built here, competitive everywhere.** "Made in India" is a statement about where the work
happens, not a lowered bar. The engineering is meant to hold up anywhere.

### The engineering, honestly

This is a real system with real seams. One Express application serving 24 route modules and 24
Mongoose schemas. A hand-written Markdown renderer because the streaming behaviour we wanted was
easier to build than to configure. A Docker sandbox that replaced an in-process `node:vm`
executor after we found that `Function('return process')()` escaped it and read the environment —
the route files still carry that story in their comments, because the next person deserves to know
why the code looks the way it does.

We document the fixed bugs alongside the working features. The header comments in `server.js`
explain the routing collision that once put a wildcard `GET /:id` at the application root, and
why `/uploads` is now mounted after the WAF instead of before it. That history is the most useful
documentation in the repository.

<div align="center">

**[hello@tantraailabs.in](mailto:hello@tantraailabs.in)**

Made in India with ❤️

</div>

---

## Contributing

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for setup, conventions, and the test workflow.

The house style is worth knowing before your first pull request: comments explain *why*, not
*what*. Where a security control exists because something was exploitable, the comment says so.
Where a mounting order or a default value is load-bearing, the comment explains what breaks
without it. Please keep that up — it is the reason this codebase is navigable.

## License

**No license is currently declared.** Neither `package.json` carries a `license` field and there
is no `LICENSE` file, which means default copyright applies and no one has permission to use,
modify, or distribute this code. If you intend to open-source it, add a license file explicitly —
this is a legal decision, not a technical one, and it needs a deliberate choice rather than a
default.

<div align="center">

**AstraGPT** · Tantra AI Labs · Made in India

</div>
