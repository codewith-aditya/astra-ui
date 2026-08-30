# CLAUDE.md — Dev Reference (Summary Edition)
> Compiled by AstraGPT · Tantra AI Labs · 2025

---

## 🎨 FRONTEND

### HTML5
- **Semantic:** `<header>` `<nav>` `<main>` `<section>` `<article>` `<aside>` `<footer>` `<dialog>` `<template>`
- **Forms:** All input types + FormData API + Constraint Validation API
- **Media:** `<video>` `<audio>` `<canvas>` `<svg>` `<picture>`
- **APIs:** IntersectionObserver, ResizeObserver, Clipboard, Geolocation, Web Share, Popover, View Transitions
- **a11y:** ARIA roles/states/properties, aria-live, tabindex, skip links, focus management

---

### CSS3
- **Selectors:** `:has()` `:is()` `:where()` `:not()` `::before/after` — full pseudo coverage
- **Layout:** Flexbox, CSS Grid (subgrid), multi-column, logical properties
- **Modern:** Custom Properties, Container Queries (`@container`), Cascade Layers (`@layer`), `@scope`
- **Animations:** `@keyframes`, scroll-driven animations, View Transitions, GSAP-ready
- **Theming:** OKLCH/LCH colors, `color-mix()`, `light-dark()`, `prefers-color-scheme`
- **Frameworks:** TailwindCSS (v4), Bootstrap 5, Sass/SCSS, CSS Modules, Styled Components, Vanilla Extract

---

### JavaScript / TypeScript
- **JS:** ES6+ full coverage — async/await, Proxy, Generators, Web Workers, Intl API
- **TS:** Generics, Conditional Types, Mapped Types, Template Literal Types
- **Key Utilities:** `Partial` `Required` `Pick` `Omit` `ReturnType` `Awaited` `NoInfer`

---

### React / Next.js
- **Hooks:** useState, useEffect, useReducer, useCallback, useMemo, useRef, useTransition, useOptimistic
- **Custom Hooks:** useLocalStorage, useDebounce, useFetch, useMediaQuery, useClickOutside
- **Patterns:** Compound Components, Render Props, Provider, Composition
- **Next.js App Router:** Server Components, Server Actions, Route Handlers, Middleware, PPR, ISR
- **Features:** `next/image`, `next/font`, Metadata API, Edge Runtime, Turbopack

---

### Other Frameworks
| Framework | Key Feature |
|-----------|------------|
| Vue 3 | Composition API, Pinia, Nuxt 3 |
| Svelte 5 | Runes (`$state` `$derived` `$effect`) |
| Astro | Islands Architecture, zero JS |
| Solid.js | Fine-grained Signals |
| htmx | AJAX without JS |

---

### State & Data
- **State:** Zustand, Redux Toolkit (RTK Query), Jotai, MobX, XState
- **Fetching:** TanStack Query, SWR, tRPC, Apollo Client, Axios
- **Forms:** React Hook Form + Zod (zodResolver), Yup, Valibot
- **UI Libs:** shadcn/ui, Radix UI, MUI, Mantine, DaisyUI, Aceternity

---

### Performance
- Code Splitting (`React.lazy` + `Suspense`), Tree Shaking
- Core Web Vitals: LCP `<2.5s` · INP `<200ms` · CLS `<0.1`
- Virtual Scrolling (tanstack-virtual), Streaming SSR, Partial Hydration
- Bundle Analysis, Brotli/Gzip, CDN Caching, HTTP/2+3

---

### Testing (Frontend)
- **Unit:** Vitest / Jest
- **Component:** React Testing Library
- **E2E:** Playwright, Cypress
- **Visual:** Storybook, MSW (Mock Service Worker)

---
---

## ⚙️ BACKEND

### Node.js Frameworks
| Framework | Use Case |
|-----------|---------|
| **Express** | General purpose, middleware-first |
| **Fastify** | High perf, schema validation, Pino logging |
| **NestJS** | Enterprise, DI, decorators, microservices |
| **Hono** | Edge (CF Workers/Bun/Deno), ultrafast |
| **tRPC** | End-to-end type safety |

---

### Python Frameworks
| Framework | Use Case |
|-----------|---------|
| **FastAPI** | Async, Pydantic, auto-docs, DI |
| **Django** | Full-stack, ORM, Admin, DRF |
| **Flask** | Lightweight, Blueprints, SQLAlchemy |

---

### API Design
- **REST:** Proper HTTP verbs, status codes, versioning, cursor pagination, HATEOAS
- **GraphQL:** SDL, DataLoader (N+1 fix), Federation, Subscriptions
- **gRPC:** Protobuf, streaming types, interceptors
- **WebSockets / SSE / WebHooks:** Real-time patterns
- **OpenAPI / Swagger:** Auto-generated docs

---

### Databases
#### SQL
| DB | Highlight |
|----|-----------|
| **PostgreSQL** | JSONB, Full-text, RLS, pgvector, partitioning |
| **SQLite** | Embedded, Turso for edge |
| **Neon/Supabase** | Serverless PostgreSQL |
| **CockroachDB** | Distributed SQL |

#### NoSQL
| DB | Use Case |
|----|---------|
| **Redis** | Cache, sessions, pub/sub, rate limiting |
| **MongoDB** | Documents, Aggregation Pipeline, Atlas |
| **DynamoDB** | AWS key-value / wide-column |
| **ClickHouse** | OLAP, analytics |
| **Neo4j** | Graph (Cypher) |

#### Vector
- Pinecone, Weaviate, Chroma, Qdrant, pgvector (HNSW)

---

### ORMs
| ORM | Language |
|-----|---------|
| **Prisma** | TypeScript — type-safe, migrations |
| **Drizzle** | TypeScript — SQL-like, lightweight |
| **TypeORM** | TypeScript — decorators |
| **SQLAlchemy** | Python — Core + ORM + Alembic |
| **Django ORM** | Python — built-in, queryset API |
| **GORM** | Go |

---

### Caching
- **Redis** — primary (Cache-Aside, Read/Write-Through, Write-Behind)
- **CDN** — Cloudflare, CloudFront (edge caching)
- **HTTP** — `Cache-Control`, `ETag`, `stale-while-revalidate`
- **Multi-tier** — L1: in-memory → L2: Redis → L3: CDN

---

### Message Queues
- **Kafka** — high throughput, consumer groups, partitions
- **RabbitMQ** — exchanges (direct/fanout/topic), DLQ
- **BullMQ** — Node.js, retries, cron, rate limiting
- **Celery** — Python, beat scheduler, chains/groups
- **Temporal** — workflows, activities, signals

---

### Auth & Security
- JWT (access + refresh, RS256/ES256, HttpOnly cookies)
- OAuth 2.0 + PKCE, OpenID Connect
- Passwords: `argon2id` > bcrypt (cost ≥ 10)
- RBAC / ABAC / Zanzibar (ReBAC)
- MFA: TOTP, WebAuthn/Passkeys
- CSRF (SameSite + tokens), Helmet.js, CSP, HSTS
- Rate Limiting (sliding window, token bucket)
- OWASP Top 10: injection, XSS, SSRF, BOLA, broken auth
- Secrets: Vault, AWS Secrets Manager, Doppler

---

### File Storage & CDN
- **S3** — presigned URLs, multipart, lifecycle
- **Cloudflare R2** — S3-compatible, zero egress
- **Cloudinary / ImageKit** — image/video transforms
- **Sharp** (Node) / **Pillow** (Python) — server-side processing

---

### Real-time
- Socket.io (rooms, namespaces, Redis adapter)
- Server-Sent Events (SSE — streaming AI responses)
- WebRTC (peer-to-peer, ICE/STUN/TURN)
- Supabase Realtime, Pusher, Ably

---

### Logging & Monitoring
- **Logging:** Winston, Pino, Morgan (Node) · Loguru (Python)
- **Errors:** Sentry (tracking + performance)
- **Metrics:** Prometheus + Grafana (PromQL)
- **Tracing:** OpenTelemetry, Jaeger, Zipkin
- **3 Pillars:** Logs · Metrics · Traces
- **Methods:** RED (Rate/Errors/Duration) · USE (Utilization/Saturation/Errors)

---

### Testing (Backend)
- **Node:** Jest / Vitest + Supertest
- **Python:** Pytest + asyncio + fixtures
- **Load:** k6, Artillery
- **API:** Postman, Bruno, Hurl
- **Integration:** Testcontainers

---

### DevOps & Infrastructure
#### Docker
- Multi-stage builds, Alpine/Distroless images, `.dockerignore`
- Docker Compose: services, volumes, networks, healthchecks

#### Kubernetes
- Pods, Deployments, Services, Ingress, ConfigMaps, Secrets
- Helm, Kustomize, HPA, ArgoCD (GitOps)

#### CI/CD
- GitHub Actions (matrix, reusable workflows, secrets, artifacts)
- GitLab CI, Jenkins Pipelines

#### IaC
- Terraform (state, modules, workspaces)
- Pulumi, AWS CDK, Ansible

#### Cloud Quick-Ref
| Cloud | Key Services |
|-------|-------------|
| **AWS** | EC2, Lambda, S3, RDS, ECS/EKS, CloudFront, Bedrock |
| **GCP** | Cloud Run, BigQuery, Vertex AI, Pub/Sub |
| **Azure** | App Service, Cosmos DB, AKS |
| **Serverless** | Vercel, Fly.io, Railway, Render, Supabase Edge |

#### Reverse Proxy
- Nginx, Caddy (auto-HTTPS), Traefik (auto-discovery)

---

### Architecture Patterns
| Pattern | When to Use |
|---------|------------|
| Monolith | Simple, single team |
| Modular Monolith | Scalable without ops overhead |
| Microservices | Large teams, independent scaling |
| Event-Driven | Async, decoupled systems |
| CQRS + Event Sourcing | Audit trail, complex domain |
| Saga Pattern | Distributed transactions |
| Outbox Pattern | Reliable event publishing |
| Circuit Breaker | Fault tolerance |
| BFF | Per-client API layer |

#### Gang of Four (GoF)
- **Creational:** Singleton, Factory, Builder, Prototype
- **Structural:** Adapter, Decorator, Facade, Proxy
- **Behavioral:** Observer, Strategy, Command, State, Chain of Responsibility

---

### System Design Cheatsheet
- **Scalability:** Horizontal (more machines) vs Vertical (bigger machine)
- **Load Balancing:** Round Robin, Least Connections, Consistent Hashing
- **DB Scaling:** Sharding, Read Replicas, Connection Pooling
- **CAP Theorem:** Consistency / Availability / Partition Tolerance (pick 2)
- **Rate Limiting:** Token Bucket vs Sliding Window
- **Deployments:** Blue-Green, Canary, Rolling, Feature Flags

---
---

## 📋 Meta

| | |
|-|-|
| **Version** | 2025 |
| **Author** | AstraGPT — Tantra AI Labs |
| **Covers** | 40 sections · 1500+ skills |
| **Use as** | Interview prep · Code review · Architecture reference |


═══════════════════════════════════════════════════════════
              🎨 UI/UX DESIGN SKILLS — 2025
═══════════════════════════════════════════════════════════

1. DESIGN FUNDAMENTALS
   • Visual Hierarchy
   • Typography (pairing, scale, kerning, leading, variable fonts)
   • Color Theory (wheel, complementary, analogous, triadic)
   • Color Psychology
   • Color Systems (HSL, OKLCH, P3 gamut)
   • Spacing Systems (4px grid, 8px grid, modular scale)
   • Layout Composition (Rule of Thirds, Golden Ratio, Z/F-pattern)
   • Whitespace / Negative Space
   • Contrast (size, color, weight, shape)
   • Gestalt Principles (proximity, similarity, closure, continuity)
   • Balance (symmetrical, asymmetrical)
   • Depth & Elevation (shadows, layers)
   • Iconography Principles
   • Brand Visual Language

2. DESIGN TOOLS
   • Figma (Auto Layout, Components, Variants, Variables, Prototyping, Dev Mode, Branching, AI Features, Code Connect)
   • Sketch (Symbols, Smart Layout)
   • Framer (Code Components, CMS, Animations)
   • Webflow (Visual Dev, CMS, Interactions)
   • Adobe Photoshop, Illustrator, After Effects, InDesign
   • Affinity Designer 2, Affinity Photo 2
   • Penpot (open-source)
   • Canva
   • Spline (3D), Rive (interactive animations)

3. PROTOTYPING
   • Figma Prototyping (Smart Animate, Variables, Conditional Logic)
   • ProtoPie (sensors, variables, formulas)
   • Principle (Mac — advanced animations)
   • Origami Studio (Meta)
   • Axure RP (enterprise, logic, dynamic panels)
   • Lottie (After Effects → code)
   • Jitter (browser motion design)
   • Play (SwiftUI prototyping)

4. WIREFRAMING
   • Low-fidelity (paper, whiteboard)
   • Mid-fidelity (grayscale, basic layout)
   • High-fidelity (near-final with real content)
   • Tools: Figma, Balsamiq, Whimsical, Miro, Excalidraw

5. DESIGN SYSTEMS
   • Design Tokens (color, spacing, typography, shadow, motion)
   • Token Taxonomy (Global → Alias → Component)
   • Semantic Tokens (primary, surface, error, success)
   • Atomic Design (atoms → molecules → organisms → templates → pages)
   • Component API Design (props, variants, states)
   • Theming (light/dark, high contrast, multi-brand)
   • Industry Systems: Material Design 3, Apple HIG, Fluent, Carbon, Polaris, Primer, Spectrum
   • Tools: Style Dictionary, Tokens Studio, Supernova, Zeroheight, Storybook

6. RESPONSIVE DESIGN
   • Mobile-first, Desktop-first
   • Breakpoints (320, 375, 768, 1024, 1280, 1440, 1920)
   • Fluid Design (no fixed breakpoints)
   • Container Queries
   • Touch Targets (44px iOS, 48dp Android)
   • Thumb Zone mapping
   • Responsive grids (12/8/4 column)
   • Foldable, Tablet, TV, Watch design

7. ICON & ILLUSTRATION
   • Icon grids (24x24, 20x20, 16x16)
   • Stroke vs Fill, consistency
   • SVG optimization (SVGO)
   • Icon libraries: Lucide, Heroicons, Phosphor, Tabler
   • Spot/Hero/Empty-state illustrations
   • Isometric, flat, 3D styles
   • AI illustration (Midjourney, DALL-E)

8. MOTION & MICRO-INTERACTIONS
   • Timing, Easing, Duration
   • Easing curves (ease-in-out, spring, bounce)
   • Micro-interactions (button press, toggle, hover, loading)
   • Page transitions (fade, slide, morph, shared element)
   • Scroll animations (parallax, reveal, sticky)
   • Loading (skeleton, shimmer, spinner, progress)
   • Reduced motion (prefers-reduced-motion)
   • Tools: After Effects, Principle, ProtoPie, Rive, Framer Motion

9. DATA VISUALIZATION
   • Chart types (bar, line, area, pie, scatter, heatmap, treemap)
   • Dashboard design
   • Data storytelling
   • Color in data viz (sequential, diverging, categorical)
   • Interactive viz (tooltips, drill-down, filter)
   • Table design (sortable, filterable, pagination)
   • KPI cards & metrics display

10. UX RESEARCH — QUALITATIVE
    • User Interviews (structured, semi-structured)
    • Contextual Inquiry
    • Diary Studies
    • Focus Groups
    • Think-Aloud Protocol
    • Card Sorting (open, closed, hybrid)
    • Tree Testing
    • First-Click Testing
    • Five-Second Test
    • Concept Testing
    • Guerrilla Research

11. UX RESEARCH — QUANTITATIVE
    • Surveys (SUS, NPS, CSAT, CES)
    • A/B Testing, Multivariate Testing
    • Analytics (Google Analytics, Mixpanel, Amplitude, PostHog)
    • Heatmaps (Hotjar, FullStory, Clarity)
    • Session Recordings
    • Funnel Analysis
    • Cohort Analysis
    • Eye-tracking Studies

12. USABILITY TESTING
    • Moderated / Unmoderated
    • Remote / In-person
    • Task-based Testing
    • Heuristic Evaluation (Nielsen's 10 Heuristics)
    • Cognitive Walkthrough
    • Tools: Maze, UserTesting, Lookback, Dovetail

13. UX STRATEGY & FRAMEWORKS
    • Design Thinking (Empathize → Define → Ideate → Prototype → Test)
    • Double Diamond (Discover → Define → Develop → Deliver)
    • Lean UX (Build → Measure → Learn)
    • Jobs-to-be-Done (JTBD)
    • Design Sprint (5-day)
    • Kano Model
    • MoSCoW / RICE Prioritization
    • Impact-Effort Matrix
    • North Star Metric

14. INFORMATION ARCHITECTURE
    • Site Maps, Content Inventory, Content Audit
    • Navigation Design (global, local, breadcrumbs, mega menu)
    • Taxonomy, Labeling Systems
    • Mental Models, Conceptual Models
    • Findability & Discoverability
    • Search Design (autocomplete, filters, results)
    • Progressive Disclosure

15. INTERACTION DESIGN
    • Affordances, Signifiers, Feedback, Constraints
    • Error Prevention & Recovery
    • Inline Validation
    • Drag & Drop, Swipe, Pull-to-Refresh
    • Onboarding (coach marks, tooltips, tours)
    • Command Palette (⌘K pattern)
    • Keyboard Shortcuts
    • Multi-step Flows (wizards, steppers)

16. USER FLOWS & JOURNEY MAPPING
    • User Flow Diagrams, Task Flows, Wire Flows
    • Customer Journey Maps
    • Empathy Maps (Says, Thinks, Does, Feels)
    • Service Blueprints
    • Storyboarding
    • Happy Path vs Edge Cases
    • Tools: FigJam, Miro, Mural, Whimsical, Lucidchart

17. PERSONAS & USER MODELING
    • Research-based Personas
    • JTBD Profiles
    • Behavioral Personas
    • Anti-personas
    • User Stories, Job Stories
    • Accessibility Personas

18. UX WRITING & CONTENT DESIGN
    • Microcopy (buttons, labels, tooltips)
    • Error Messages (clear, actionable, human)
    • Empty States, Loading States copy
    • Voice & Tone Guidelines
    • Inclusive Language
    • Content Testing (Readability Scores)
    • Tools: Frontitude, Ditto, Writer

19. ACCESSIBILITY (a11y)
    • WCAG 2.2 (A, AA, AAA)
    • POUR Principles (Perceivable, Operable, Understandable, Robust)
    • Color Contrast (4.5:1 normal, 3:1 large)
    • Keyboard Navigation, Focus Management
    • Screen Readers (NVDA, VoiceOver, TalkBack)
    • Touch Targets (44px+ minimum)
    • Reduced Motion
    • Inclusive Design (permanent, temporary, situational disabilities)
    • Neurodiversity (ADHD, Autism, Dyslexia)
    • Tools: axe, WAVE, Lighthouse, Stark

20. PSYCHOLOGY & BEHAVIORAL DESIGN
    • Cognitive Load Theory
    • Hick's Law, Fitts's Law, Miller's Law, Jakob's Law
    • Peak-End Rule, Paradox of Choice
    • Social Proof, Loss Aversion, Anchoring
    • Fogg Behavior Model
    • Hook Model (Trigger → Action → Reward → Investment)
    • Gamification
    • Dark Patterns Awareness & Prevention
    • Ethical Design, Digital Wellbeing

21. UX METRICS
    • Task Success Rate, Completion Time, Error Rate
    • SUS, NPS, CSAT, CES
    • DAU/WAU/MAU, Retention, Churn
    • Feature Adoption, Activation Rate
    • Funnel Conversion, Drop-off Rate
    • Tools: Mixpanel, Amplitude, PostHog, FullStory

22. FORM DESIGN
    • Single column, Multi-step, Inline forms
    • Labels (top vs floating vs side)
    • Smart Defaults, Autofill, Input Masking
    • Real-time vs On-submit validation
    • Conditional Fields
    • File Upload patterns
    • Conversational Forms

23. PLATFORM-SPECIFIC DESIGN
    • iOS (HIG, SF Symbols, Tab Bar, Dynamic Type)
    • Android (Material Design 3, Dynamic Color)
    • Web (hover states, keyboard nav, browser compat)
    • Cross-platform consistency

24. DESIGN HANDOFF & COLLABORATION
    • Figma Dev Mode
    • Design Specs, Redline Docs
    • Asset Export (SVG, PNG, WebP)
    • Design Token Handoff
    • Design QA
    • Sprint Planning for Design
    • Design Reviews & Critiques

25. AI-POWERED UX TOOLS
    • Figma AI, Galileo AI, Uizard, Visily
    • Relume (AI sitemap → wireframe)
    • v0.dev (AI UI generation)
    • Locofy, Anima (design → code)
    • Midjourney, DALL-E (concept art)
    • Attention Insight (AI heatmaps)

═══════════════════════════════════════════════════════════
      UI/UX TOTAL: 300+ Skills Listed ✅
═══════════════════════════════════════════════════════════
> **Tip:** For system design interviews → jump to Architecture (18) + System Design (19).
> For security audits → Auth & Security section.
> For AI/LLM backends → Vector DBs + SSE + Redis.