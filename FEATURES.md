# 🔱 AstraGPT — Complete Project Features Documentation
> **Generated:** April 2026 | Tantra AI Labs | Full Stack Analysis

---

## 📁 PROJECT ARCHITECTURE OVERVIEW

```
astragpt/
├── src/                        ← React 19 Frontend (Vite 7)
│   ├── App.jsx                 ← Root component — 1464 lines, complete state machine
│   ├── components/             ← 40+ UI components
│   └── lib/                    ← 20 utility/service modules
├── server/index.js             ← ZIP generator server (port 4000)
├── api-server/
│   ├── backend/                ← Secondary API server (port 4500, JWT auth)
│   └── proxy/server.js         ← Nexusify proxy (port 8317, 43 models)
├── vite.config.js              ← Dev proxy: Orbit API + VPS backend
├── package.json                ← React 19 + Supabase + Mermaid + KaTeX
├── netlify.toml / vercel.json  ← Deployment configs
└── CLAUDE.md                   ← Dev reference (this project)
```

---

## 🌐 FRONTEND — React 19 + Vite 7

### 📄 Page / Route System (SPA, No Router Library)

| Route | Page Name | Purpose |
|-------|-----------|---------|
| `/` | `landing` | Marketing landing page |
| `/login` | `auth` | Login / signup (Email OTP + Google OAuth) |
| `/chat` | `chat` | Main AI chat interface |
| `/upgrade` | `upgrade` | Plan upgrade + billing |
| `/ax-ctrl` | `admin` | Admin panel (email-gated whitelist) |
| `/ax-security` | `security` | Cloudflare security management |
| `/knowledge` | `knowledge` | Knowledge base manager (RAG) |
| `/functions` | `functions` | Custom function definitions editor |
| `/evaluations` | `evaluations` | AI evaluation & leaderboard |
| `/c/:chatId` | `shared` | Public shareable read-only chat URL |
| `*` | `notfound` | 404 page |

---

## 🤖 AI MODELS — Complete List

### Frontend-Exposed Models (6 Core Models)

| Display Name | Model ID | Provider | Plan | Special |
|---|---|---|---|---|
| **Astra Pro** | `claude-opus-4-6-20260205` | Anthropic/Orbit | Pro+ only | Most powerful |
| **Astra Smart** | `claude-sonnet-4-6` | Anthropic/Orbit | Free (10/day) | Default model |
| **Astra Fast** | `claude-haiku-4-5-20251001` | Anthropic/Orbit | Pro | Speed optimized |
| **Astra Flash** | `gemini-3-flash-preview` | Google/Orbit | Free | Ultra fast |
| **Astra Flash Pro** | `gemini-3-pro-preview` | Google/Orbit | Pro | Next-gen Gemini |
| **Astra Search** | `gpt-5.1-search` | Tavily + Claude | Free | Live web search |
| **Astra Think** | `gpt-oss-120b` | Nexusify | Free | `<think>` reasoning |
| **Astra Coder Max** | `astra-coder-max` → `gpt-5.4` | Orbit Codex | Pro | Code specialist |
| **Astra Coder Mini** | `astra-coder-mini` → `gpt-5.4-mini` | Orbit Codex | Pro | Fast coder |

### Nexusify Proxy Models (43 Total, Port 8317)

| Category | Models |
|---|---|
| **OpenAI GPT** | GPT-4o Mini, GPT-5, GPT-5 Nano, GPT-5 Mini, GPT-5.1, GPT-5.4, GPT-5.3 Codex |
| **Google Gemini** | Gemini 2.5 Flash/Pro, Gemini 3.0 Flash/Pro, Gemma 7B, Gemma 2-9B |
| **Meta Llama** | Llama 3.1 8B/70B/405B, Llama 3.2 3B/90B Vision, Llama 3.3 70B, Llama 4 Maverick |
| **Mistral** | Mistral Small 3.1/24B, Mistral Large 3, Mistral Medium 3, Mixtral 8x22B, Devstral-2, Magistral Small, Mamba Codestral, Nemotron |
| **DeepSeek** | DeepSeek V3.1, DeepSeek V3.2 |
| **Alibaba Qwen** | Qwen 2.5 Coder 32B, Qwen3 Next 80B |
| **Moonshot** | Kimi K2, Kimi K2.5 |
| **NVIDIA** | Nemotron Nano 8B, Nemotron Super 49B, Nemotron Ultra 253B |
| **Others** | GPT-OSS 120B/20B, Step 3.5 Flash, MiniMax M2.1 |

---

## 💬 CORE CHAT FEATURES

### Real-Time Streaming
- **SSE Streaming** — `ReadableStream` reader + TextDecoder, line-by-line SSE parsing
- **RAF Batching** — RequestAnimationFrame coalesces rapid chunks → single `setMessages` per frame (prevents 500+ setState/sec)
- **AbortController** — User can stop streaming mid-response with ✕ button
- **Stream error handling** — Graceful degradation with user-friendly error messages

### Message Actions
- **Edit Message** — Truncates history to that point + re-sends from scratch
- **Retry** — Re-sends last user message (new AI response)
- **Copy** — Copies raw markdown text
- **Like / Dislike** — Reaction saved to MongoDB via backend
- **TTS Readout** — Text-to-speech for any AI message

### Chat Management
- **New Chat** — Clears current + starts fresh session
- **Incognito Mode** — Messages NOT saved to database, badge shown
- **Chat History** — Full sidebar with all past conversations
- **Pin Chat** — Pin important chats to top of sidebar
- **Archive Chat** — Remove from main list without deleting
- **Delete Chat / Delete All** — Permanent removal
- **Tags** — Color-coded chat tags for organization
- **Folders** — Hierarchical folder tree for chat organization
- **Export Chat** — Download as Markdown file
- **Import Chats** — Bulk import chat data
- **Share Chat** — Public URL (`/c/:chatId`) — read-only, no auth needed

---

## 🧠 CONTEXT & MEMORY SYSTEM

### Conversation Context
- **1M Token Context Window** — 950k safe limit (50k reserved for response)
- **Auto Context Compression** — Triggers at 800k tokens; AI summarizes history, keeps last 20 messages
- **Per-Plan Warning Thresholds:**
  - Free → warns at 700k tokens
  - Pro → warns at 800k tokens
  - Pro+ → warns at 850k tokens
- **Smart Context Continuation** — Carries compressed summary to new chat

### Cross-Chat Persistent Memory
- **Auto Memory Extraction** — Regex detects: name, profession, location, tech stack, current project, spoken language
- **Memory Storage** — Saved to MongoDB via `/api/memory/:userId`
- **Memory Injection** — Every system prompt gets memories via `buildSystemPromptWithMemory()`
- **Memory Management** — View, delete individual, or clear all memories via Settings
- **Memory in Search** — Astra Search also injects user memories (fixed Bug 2)

### Per-Chat System Prompt
- **Custom system prompt per conversation** — overrides global AstraGPT system prompt
- **Stored in MongoDB** — persists across sessions

---

## 🔍 WEB SEARCH & BROWSING

### Astra Search (Search Model)
- **Model:** `gpt-5.1-search` — Tavily Search → Claude streaming answer
- **Search Depth:** `advanced` with up to 5-6 results
- **User memories injected** into search responses

### Auto-Search Trigger
- Detects keywords: `"today"`, `"latest"`, `"news"`, `"price"`, `"weather"`, `"score"`, `"current"`, `"2024"`, `"2025"` etc.
- Automatically switches to web search mode

### Manual Web Search Toggle
- Toggle button in InputArea — forces Tavily search for any query

### URL Browsing
- Detects URLs in user messages
- Fetches via Tavily Extract API → AllOrigins CORS proxy fallback
- Full page content injected into AI context with `URL_BROWSE_CAPABILITY` instruction

### Perplexity-Style Search Page
- Full-screen animated search experience
- Step animation: **Searching → Collecting Sources → Analyzing → AI Answer**
- Inline source citations with clickable links

---

## 📤 FILE & MEDIA HANDLING

### File Upload
- **Supported formats:** PDF, DOCX, ZIP, TXT, MD, CSV
- Backend parsing → text extraction → injected as context
- **Image Upload** — Base64 converted, sent to Anthropic vision API (inline `image_source`)

### Folder Upload
- Reads ALL text files recursively from folder
- Builds concatenated context with file paths/content
- Drag-and-drop supported

### Vision / Image AI
- Supports: JPG, PNG, GIF, WEBP
- Base64 encoding in frontend → Anthropic vision message format
- Compatible with Claude Sonnet, Haiku, Opus

### Voice Input (STT)
- Web Speech API — browser-native speech recognition
- Audio level visualization (animated bars)
- Auto-stop on silence

### Text-to-Speech (TTS)
- Web Speech API — browser-native TTS
- Microsoft Neural voices prioritized
- Per-message "speak" button on AI responses

---

## 🖼️ RENDERING & DISPLAY

### Markdown Rendering
- `marked` + `marked-highlight` libraries
- Full GitHub-flavored Markdown (GFM)
- Tables, lists, blockquotes, strikethrough

### Code Highlighting
- `highlight.js` with `github-dark` theme
- 40+ languages supported
- Copy button on every code block
- Line numbers

### Math (LaTeX / KaTeX)
- Inline: `$...$`
- Block: `$$...$$`
- Rendered via KaTeX (fast, accurate)

### Mermaid Diagrams
- Full Mermaid.js integration (flowcharts, sequence, state, ER, Gantt, etc.)
- Dark theme with custom AstraGPT colors (purple/dark palette)
- `htmlLabels: false` → pure SVG text (no foreignObject issues)
- **Copy code** button
- **Download SVG** button
- **Full View** button → opens new browser tab with high-quality standalone page
- Clicking diagram also opens new tab
- Standalone page has: AstraGPT branding, Copy Code, Download SVG, Close buttons

### Thinking Blocks
- `<think>...</think>` tags parsed from Claude Thinking model
- Rendered as collapsible "Thinking..." section
- Budget: 5000 tokens of thinking

### Artifact Panel
- Split-pane code viewer (triggered by artifacts in responses)
- React iframe sandbox for live preview
- Syntax highlighting + line numbers
- Download artifact button

---

## ⚙️ SPECIAL AI MODES

### Thinking Mode
- Adds `-thinking` suffix to Claude model ID
- Extended reasoning with 5000-token budget
- Collapsible think block UI

### Professional Mode
- Injects formal tone instruction into system prompt
- No slang/emojis, proper headings, formal language

### Project Generation Mode
- **Trigger:** Detects "generate/create/build a project/app/website" in message
- AI generates structured JSON with complete file tree
- Frontend sends to `/generate-project` server
- ZIP auto-downloaded with all project files
- Max tokens: 32,000

### Code Execution Sandbox
- `/api/code/execute` — JavaScript execution in timeout sandbox
- `CodeExecutor.jsx` component for run/output display

### Auto-Tasks (AI-Powered)
| Task | Endpoint | Trigger |
|---|---|---|
| Chat Title | `/api/tasks/title` | After first message |
| Chat Tags | `/api/tasks/tags` | After conversation |
| Chat Emoji | `/api/tasks/emoji` | For sidebar icon |
| Follow-up Suggestions | `/api/tasks/followup` | After AI response |
| Autocomplete | `/api/tasks/autocomplete` | While typing |

---

## 🧩 KNOWLEDGE BASE & RAG

- **Create/Edit/Delete** knowledge bases
- **Add files** to knowledge bases (PDF, TXT, DOCX)
- **Vector embeddings** via `/api/rag/embed`
- **Semantic query** via `/api/rag/query`
- **Web-augmented RAG** via `/api/rag/web/search`
- **File processing** via `/api/rag/process`
- Used in `/knowledge` page with full CRUD UI

---

## 💾 PROMPT LIBRARY

- Save custom prompt templates
- List, create, update, delete prompts
- Track usage count
- Quick-insert into chat input

---

## 📝 NOTES PANEL

- Sticky notes sidebar
- Markdown-formatted notes
- Create, edit, delete
- Persist to MongoDB

---

## 🔗 CHANNELS (Slack-Style)

- Create and join channels
- Channel message history with pagination
- Groups with member management (add/remove)
- Real-time messaging within channels

---

## ⚡ FUNCTIONS & SKILLS

- Define custom functions (JavaScript)
- Toggle functions on/off
- Functions available during AI conversation
- Skills library with CRUD

---

## 🧪 EVALUATIONS & LEADERBOARD

- Submit AI evaluation responses
- Compare model performance
- Leaderboard ranking
- `/evaluations` page with full UI

---

## 🎭 THEMES

| Theme | Type | Availability |
|---|---|---|
| Dark | Default | All users |
| Light | Default | All users |
| System (auto) | Default | All users |
| Midnight Purple | Premium | Pro+ |
| Deep Space | Premium | Pro+ |
| Cyber Black | Premium | Pro+ |
| Neon AI | Premium | Pro+ |

---

## 📊 PLAN TIERS & LIMITS

| Plan | Daily Messages | Per Min | Astra Smart | Max Context | Models |
|---|---|---|---|---|---|
| **Free** | 50 | 3 | 10/day | 32k tokens | Flash, Smart, Search, Think, Codex |
| **Pro** | 500 | 15 | Unlimited | 80k tokens | + Fast, Flash Pro, GPT-5, Kimi K2, Devstral |
| **Pro+** | 2,500 | 30 | Unlimited | 160k tokens | + Astra Pro (Opus) |
| **Ultra** | 10,000 | 60 | Unlimited | 160k tokens | All models |

---

## 🔐 AUTHENTICATION SYSTEM

| Method | Provider | Flow |
|---|---|---|
| **Email + Password** | Supabase | Sign up → OTP verification email → Login |
| **Email OTP** | Supabase | `signUp()` → `verifyOtp()` → `resendOtp()` |
| **Google OAuth** | Supabase | `signInWithOAuth({ provider: 'google' })` → callback |
| **2FA / TOTP** | Backend (speakeasy) | Setup → QR code scan → verify code → enable |

**Backend Authorization:** `Bearer <supabaseUid>` header  
**Admin Access:** Hardcoded email whitelist (2 emails)

---

## 🛡️ ADMIN PANEL (`/ax-ctrl`)

| Feature | Details |
|---|---|
| **Platform Stats** | Total users, messages, chats, revenue |
| **User Management** | List all users, upgrade/downgrade plan |
| **Coupon System** | Create, enable/disable, delete coupons |
| **System Logs** | Filter by log level (info/warn/error) |
| **Analytics Dashboard** | Usage charts, model breakdown, token usage |

---

## 📡 API ROUTING ARCHITECTURE

```
Browser (React Frontend)
    │
    ├── /api/orbit/*  ──────────→  Orbit AI Provider (Claude + Gemini)
    │                              https://api.orbit-provider.com
    │
    ├── /api/backend/*  ─────────→  VPS Main Backend (MongoDB)
    │                              http://62.72.42.237:4000
    │
    └── Direct fetch  ───────────→  Tavily (Search + Extract)
                                    Nexusify (43 models proxy)
```

**3 API Call Paths in `streamChatMessage()`:**
1. **Orbit/Anthropic Native** — Claude & Gemini, real SSE, thinking mode support
2. **Astra Search** — Tavily Search → Claude streaming answer with memories
3. **Nexusify** — 120B reasoning model, GPT-5, Kimi K2, Devstral — VPS first → direct fallback
4. **Codex** — Coder models via Orbit codex endpoint

**Fallback Chain:** Primary model fails → `gpt-oss-120b` via Nexusify (guaranteed last resort) → structured error message

---

## ⚙️ BACKEND SERVERS

### 1. Main VPS Backend (`62.72.42.237:4000`) — Primary

**All accessed via Vite proxy at `/api/backend/*`**

#### Chat & Messages
| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/chat` | Save user message, create/find chat |
| POST | `/api/message` | Save AI response |
| GET | `/api/chats/:userId` | List user chats (pin/archive/tags) |
| GET | `/api/messages/:chatId` | Load chat message history |
| DELETE | `/api/chats/:chatId` | Delete a chat |
| DELETE | `/api/chats/all` | Delete ALL user chats |
| POST | `/api/chats/:chatId/pin` | Pin/unpin chat |
| POST | `/api/chats/:chatId/archive` | Archive/unarchive chat |
| POST | `/api/chats/:chatId/tags` | Update chat tags |
| GET/POST | `/api/chats/:chatId/system-prompt` | Per-chat custom system prompt |
| POST | `/api/chats/import` | Bulk import chats |
| GET | `/api/chats/:chatId/export` | Export as Markdown |

#### AI Streaming
| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/v1/chat/completions` | OpenAI-compatible streaming (Nexusify models) |

#### Memory
| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/memory/:userId` | Fetch all memories |
| POST | `/api/memory/:userId` | Add a memory |
| DELETE | `/api/memory/item/:memoryId` | Delete specific memory |
| DELETE | `/api/memory/:userId/all` | Clear all memories |

#### Files & Upload
| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/upload` | Upload + parse (PDF, DOCX, ZIP, TXT, MD, CSV) |
| POST | `/api/upload/image` | Upload image → public URL |
| GET | `/api/upload/image/stats` | Upload statistics |

#### Usage & Analytics
| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/usage/:userId` | Plan + daily usage stats |
| GET | `/api/analytics/:userId` | User analytics |
| GET | `/api/analytics/dashboard` | Dashboard charts |
| GET | `/api/analytics/models` | Model usage breakdown |
| GET | `/api/analytics/tokens` | Token usage over N days |

#### 2FA / MFA (TOTP)
| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/mfa/setup` | Generate TOTP secret + QR code |
| POST | `/api/mfa/verify` | Verify TOTP code + enable 2FA |
| POST | `/api/mfa/disable` | Disable 2FA |
| GET | `/api/mfa/status` | Get MFA enabled status |

#### API Keys
| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/keys` | List user API keys |
| POST | `/api/keys` | Create new API key |
| DELETE | `/api/keys/:keyId` | Revoke API key |

#### Knowledge Base & RAG
| Method | Endpoint | Purpose |
|---|---|---|
| GET/POST | `/api/knowledge` | List / create knowledge bases |
| GET/PUT/DELETE | `/api/knowledge/:id` | Get / update / delete KB |
| GET/POST | `/api/knowledge/:id/files` | List / add KB files |
| DELETE | `/api/knowledge/:id/files/:fileId` | Remove file from KB |
| POST | `/api/rag/embed` | Embed text into vector store |
| POST | `/api/rag/query` | Semantic RAG query |
| POST | `/api/rag/process` | Process file for RAG |
| POST | `/api/rag/web/search` | Web-augmented RAG search |

#### Other Backend Features
| Domain | Endpoints |
|---|---|
| **Prompts** | CRUD `/api/prompts`, track usage |
| **Notes** | CRUD `/api/notes` |
| **Tags** | GET `/api/tags` |
| **Reactions** | POST `/api/messages/:id/reaction` |
| **Contact** | POST `/api/contact` |
| **Banners** | GET `/api/banners` (system-wide announcements) |
| **Config** | GET/POST `/api/configs`, export/import |
| **Folders** | CRUD `/api/folders`, move chat |
| **Channels** | CRUD + messages + pagination |
| **Groups** | CRUD + member add/remove |
| **Functions** | CRUD `/api/functions`, toggle |
| **Skills** | CRUD `/api/skills` |
| **Evaluations** | Submit, list, leaderboard |
| **Auto Tasks** | Title, tags, emoji, followup, autocomplete |
| **Audio** | Transcribe (Whisper), Synthesize (TTS) |
| **MCP** | Server CRUD + tool execution |
| **Code Exec** | `/api/code/execute` (JS sandbox) |
| **User Account** | DELETE `/api/user/account` (full data wipe) |
| **Health** | GET `/health` (maintenance check) |
| **Admin** | Stats, users, coupons, logs |

### 2. ZIP Generator Server (`server/index.js`, Port 4000)
- `GET /health` — health check
- `POST /generate-project` — receives file tree JSON → writes files → zips → streams ZIP
- `GET /downloads/:file` — static ZIP serving
- Auto-deletes generated files after 30 minutes

### 3. API Key Backend (`api-server/backend/`, Port 4500)
- Email/password + Google OAuth registration
- JWT auth + refresh tokens
- User management (admin)
- API key CRUD
- Credits, billing, redeem codes
- Usage logs

### 4. Nexusify Proxy (`api-server/proxy/server.js`, Port 8317)
- Pure Node.js (no framework)
- 43 AI models with pricing
- `POST /v1/chat/completions` — streaming proxy
- API key validation

---

## 🗄️ DATABASE & STORAGE

| System | Technology | Data Stored |
|---|---|---|
| **Primary DB** | MongoDB (VPS) | Chats, Messages, Users, Memories, Notes, Prompts, Banners, Knowledge, Functions, Channels, Groups, Settings, API Keys, Evaluations |
| **Auth DB** | Supabase (PostgreSQL) | Auth sessions, email OTP, Google OAuth, plan metadata |
| **File Storage** | VPS Filesystem | Uploaded images (`/uploads/images/`), generated ZIPs (`/generated/`) |
| **Cache** | In-memory (Frontend) | Session data, settings, conversation summaries, usage counters |

---

## 🎨 UI COMPONENTS (40+ Files)

| Component | Purpose |
|---|---|
| `App.jsx` | Root — all state, routing, sendMessage (1464 lines) |
| `Sidebar.jsx` | Chat history, search, pin/archive, context menus, folders |
| `TopBar.jsx` | Menu, new chat, theme toggle, incognito, export, share |
| `WelcomeScreen.jsx` | Empty state with quick prompt pills |
| `ChatMessages.jsx` | Message renderer: markdown, code, Mermaid, KaTeX, thinking, search results |
| `InputArea.jsx` | Textarea, model picker, file/folder upload, drag-drop, voice, toggles |
| `VoiceInput.jsx` | Web Speech API STT + audio level visualization |
| `ArtifactPanel.jsx` | Split-pane code viewer with React iframe sandbox |
| `SettingsModal.jsx` | 8-tab settings (General, Personalization, Notifications, Apps, Data, Security, API Keys, Account) |
| `AdminPanel.jsx` | Admin dashboard: stats, users, coupons, logs |
| `AuthPage.jsx` | Login/signup with OTP flow |
| `LandingPage.jsx` | Marketing landing page |
| `UpgradePage.jsx` | Plan upgrade with pricing |
| `BillingPage.jsx` | Billing management |
| `SearchPage.jsx` | Perplexity-style search UI |
| `ShareModal.jsx` | Chat sharing dialog |
| `SharedChatPage.jsx` | Public read-only shared chat view |
| `CommandPalette.jsx` | Ctrl+K command palette |
| `KnowledgeBase.jsx` | Knowledge base CRUD + file management |
| `NotesPanel.jsx` | Sticky notes sidebar panel |
| `PromptLibrary.jsx` | Saved prompt templates |
| `ChannelsPanel.jsx` | Slack-style channels messaging |
| `FunctionsPage.jsx` | Custom function definitions |
| `EvaluationsPage.jsx` | AI evaluation/leaderboard |
| `FoldersTree.jsx` | Hierarchical folder organization |
| `FollowUpSuggestions.jsx` | Post-response follow-up chips |
| `BuilderPage.jsx` | Project builder UI |
| `CloudflarePage.jsx` | Cloudflare security management |
| `CodeExecutor.jsx` | Code sandbox execution UI |
| `FireParticles.jsx` | Ambient particle animation |
| `SplashScreen.jsx` | App loading screen |
| `ErrorBoundary.jsx` | React error boundary |
| `MaintenancePage.jsx` | 503 maintenance screen |
| `NotFoundPage.jsx` | 404 page |
| `Toast.jsx` | Toast notifications system |

---

## 🛠️ LIB / UTILITY MODULES (`src/lib/`)

| Module | Purpose |
|---|---|
| `api.js` | All API calls: `streamChatMessage()`, Tavily search, URL fetch, project generation |
| `systemPrompt.js` | System prompt builder with date injection + memory injection |
| `systemPrompt.txt` | Raw AstraGPT system prompt (editable, no backtick issues) |
| `memory.js` | Memory formatting for system prompts + auto-extraction patterns |
| `models.js` | Model registry: IDs, names, capabilities, plan requirements |
| `supabase.js` | Supabase client + auth helpers |
| `analytics.js` | Google Analytics 4 — page views, events, timing |
| `sentry.js` | Sentry error tracking + performance monitoring |
| `android-compat.js` | Android/mobile visual viewport + input fixes |
| `markdown.js` | Markdown rendering pipeline (marked + highlight.js + KaTeX + Mermaid) |

---

## ⚡ TECHNICAL FEATURES

| Feature | Implementation |
|---|---|
| **Real SSE Streaming** | `ReadableStream` reader + TextDecoder, line-by-line parsing |
| **RAF Batching** | requestAnimationFrame coalesces rapid stream chunks → 1 setState/frame |
| **Mermaid Diagrams** | `mermaid.render()`, dark theme, SVG injection, full-page new tab view |
| **KaTeX Math** | Inline `$` and block `$$` LaTeX rendering |
| **Syntax Highlighting** | highlight.js, github-dark theme, 40+ languages |
| **Thinking Blocks** | `<think>...</think>` parsed, collapsible UI |
| **Vision/Image AI** | Base64 conversion, Anthropic vision message format |
| **Folder Upload** | Recursive text file reading, concatenated context |
| **TTS** | Web Speech API, Microsoft Neural voice priority |
| **STT** | Web Speech API, audio level visualization |
| **Auto Memory Extraction** | Regex patterns: name, profession, language, location, stack, project |
| **Project ZIP Generation** | AI JSON → server writes files → ZIP → stream download |
| **Android/Mobile Compat** | `useAndroidCompat.js`, visual viewport API, input fixes |
| **Google Analytics 4** | Page views, events, user ID, timing |
| **Sentry** | Error tracking + performance |
| **Exponential Backoff** | Backend availability: 5s→15s→45s→120s retry delays |
| **Chat Share** | Public `/c/:chatId` URL, MongoDB read, no auth needed |
| **Per-Chat System Prompt** | Overridable per-conversation via backend |
| **Config Export/Import** | Full config (prompts + notes) as JSON |
| **MCP Integration** | Model Context Protocol server CRUD + tool execution |
| **RAG Pipeline** | Vector embeddings → semantic search → context injection |
| **Proxy Error Filtering** | Strips provider names from AI responses |
| **Backend Health Poll** | Every 30s → shows `MaintenancePage` on 503 |
| **Ctrl+K Palette** | CommandPalette component |
| **Coupon System** | Admin creates coupons → user redeems |

---

## 🌐 DEPLOYMENT

| Target | Config File | Details |
|---|---|---|
| **Netlify** | `netlify.toml` | SPA redirect rules (`/* → /index.html`) |
| **Vercel** | `vercel.json` | SPA routing config |
| **VPS (62.72.42.237)** | `deploy.ps1` + `deploy_vps.py` | PowerShell + Python SSH deploy |
| **Nginx** | `nginx.conf` | Reverse proxy: `/api/backend` → port 4000, serves `dist/` |
| **Build** | `vite build` | Output → `dist/` |

---

## 🔑 ENVIRONMENT VARIABLES

```env
VITE_SUPABASE_URL           — Supabase project URL
VITE_SUPABASE_ANON_KEY      — Supabase public anon key
VITE_ORBIT_KEY              — Orbit AI proxy API key (Claude/Gemini)
VITE_ORBIT_CODEX_KEY        — Orbit Codex endpoint key
VITE_NEXUSIFY_KEY           — Nexusify API key (GPT-OSS fallback)
VITE_TAVILY_KEY             — Tavily Search + Extract API key
VITE_GA_MEASUREMENT_ID      — Google Analytics 4 measurement ID
VITE_BACKEND_URL            — Override VPS backend URL
```

---

## 📦 DEPENDENCIES

```json
Production Dependencies:
  "@supabase/supabase-js"   — Auth + PostgreSQL DB
  "firebase"                — (imported, secondary auth)
  "highlight.js"            — Code syntax highlighting (40+ langs)
  "katex"                   — LaTeX math rendering
  "marked"                  — Markdown → HTML parser
  "marked-highlight"        — Marked + highlight.js integration
  "mermaid"                 — Diagram rendering (flowchart, sequence, etc.)
  "react"                   — UI framework (v19)
  "react-dom"               — React DOM renderer

Dev Dependencies:
  "vite"                    — Build tool (v7)
  "@vitejs/plugin-react"    — React fast refresh
```

---

## 📈 ANALYTICS & MONITORING

| System | Purpose |
|---|---|
| **Google Analytics 4** | Page views, custom events, user identification, timing metrics |
| **Sentry** | Frontend error tracking, performance monitoring |
| **Backend Logs** | Filterable by level (info/warn/error) — accessible in admin panel |
| **Usage Analytics** | Per-user: chats created, messages sent, reactions, weekly breakdown |
| **Model Analytics** | Which models used, how often, token counts |

---

## 🔒 SECURITY FEATURES

| Feature | Implementation |
|---|---|
| **Email OTP Verification** | Supabase — required for new accounts |
| **Google OAuth** | Supabase social login |
| **TOTP 2FA** | speakeasy library, QR code setup, per-user enable/disable |
| **API Key System** | User-generated keys for API access |
| **Admin Whitelist** | Hardcoded email list for `/ax-ctrl` access |
| **Cloudflare Security Page** | `/ax-security` — Cloudflare management UI |
| **Response Filtering** | Strips provider API names from leaked error messages |
| **Incognito Mode** | No persistence of conversation data |

---

*Last updated: April 2026 | AstraGPT · Tantra AI Labs*
