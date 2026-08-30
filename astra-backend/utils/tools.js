// ═══════════════════════════════════════════════════════════════════════════
//  LLM Tools — schemas (OpenAI function-calling format) + executors.
//  Wired into the chat completion loop in Phase 3.
// ═══════════════════════════════════════════════════════════════════════════

const { runInSandbox } = require('./sandbox')
const { search } = require('./searchEngines')
const Chat = require('../models/Chat')
const Message = require('../models/Message')

// ─── Tool schemas (sent to the model as `tools`) ─────────────────────────────
const TOOL_SCHEMAS = [
    {
        type: 'function',
        function: {
            name: 'run_code',
            description: 'Execute code in a secure, isolated sandbox and return its stdout/stderr. Use for calculations, data processing, running scripts, testing logic, or verifying an answer. Supports python, javascript/node, and bash. No internet access inside the sandbox.',
            parameters: {
                type: 'object',
                properties: {
                    language: { type: 'string', enum: ['python', 'javascript', 'node', 'bash'], description: 'Language/runtime to execute' },
                    code: { type: 'string', description: 'The complete code to run. Print/log results to stdout.' },
                },
                required: ['language', 'code'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'web_search',
            description: 'Search the web for current, factual, or recent information. Returns top results with titles, URLs, and snippets. Use when the answer may have changed since training, needs live data, or references current events, prices, news, or specific facts you are unsure about.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'The search query — concise keywords describing what to find.' },
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_weather',
            description: 'Get the current live weather for a city or place — temperature, feels-like, condition, humidity, and wind. Use when the user asks about the weather anywhere.',
            parameters: {
                type: 'object',
                properties: {
                    location: { type: 'string', description: 'City or place name, e.g. "Pune", "London, UK", "New York".' },
                },
                required: ['location'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'search_past_chats',
            description: "Search the user's own past conversations by keyword. Call this when the user references prior context they assume you remember — e.g. 'my project', 'the bug we discussed', 'what you suggested last time'. Use content keywords (topics, proper nouns), not meta-words like 'discussed' or 'yesterday'.",
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'A few distinctive content words that likely appeared in the earlier chat.' },
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'recent_chats',
            description: "List the user's most recent conversations by time. Use when the reference is temporal ('yesterday', 'last week', 'my first chats').",
            parameters: {
                type: 'object',
                properties: {
                    limit: { type: 'integer', description: 'How many recent chats to return (max 20).' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'create_diagram',
            description: 'Render an inline diagram, flowchart, or chart using Mermaid syntax. Use when a visual explains structure, flow, or relationships better than prose. Provide valid Mermaid code.',
            parameters: {
                type: 'object',
                properties: {
                    mermaid: { type: 'string', description: 'Valid Mermaid diagram code (e.g. "graph TD; A-->B").' },
                    caption: { type: 'string', description: 'Optional short caption for the diagram.' },
                },
                required: ['mermaid'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'end_conversation',
            description: 'End the conversation. LAST RESORT only — after repeated abuse AND an explicit prior warning. NEVER use in cases of self-harm, crisis, or potential harm to others; always keep supporting those.',
            parameters: {
                type: 'object',
                properties: {
                    reason: { type: 'string', description: 'Brief reason shown to the user.' },
                },
                required: ['reason'],
            },
        },
    },
]

// ─── Helpers ─────────────────────────────────────────────────────────────────
function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

function snippet(text, rx, pad = 90) {
    const i = text.search(rx)
    if (i < 0) return text.slice(0, pad * 2)
    const start = Math.max(0, i - pad)
    const end = Math.min(text.length, i + pad)
    return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '')
}

// ─── Executors ───────────────────────────────────────────────────────────────
async function runCode({ language, code } = {}) {
    const result = await runInSandbox({ language, code })
    return result
}

async function webSearch({ query } = {}, ctx = {}) {
    if (!query || !query.trim()) return { error: 'query is required' }
    try {
        const { answer, results } = await search(query.trim(), ctx.userId)
        const top = (results || []).slice(0, 5).map(r => ({
            title: r.title || '',
            url: r.url || r.link || '',
            snippet: r.snippet || r.content || r.description || '',
        }))
        return { answer: answer || '', results: top }
    } catch (e) {
        return { error: 'Web search failed: ' + e.message }
    }
}

const WEATHER_CODES = {
    0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
    45: 'Fog', 48: 'Rime fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
    61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Heavy freezing rain',
    71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
    80: 'Rain showers', 81: 'Rain showers', 82: 'Violent rain showers',
    85: 'Snow showers', 86: 'Heavy snow showers',
    95: 'Thunderstorm', 96: 'Thunderstorm w/ hail', 99: 'Thunderstorm w/ heavy hail',
}

async function getWeather({ location } = {}) {
    if (!location || !location.trim()) return { error: 'location is required' }
    try {
        const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location.trim())}&count=1&language=en&format=json`)
        const geo = await geoRes.json()
        const place = geo?.results?.[0]
        if (!place) return { error: `Location not found: ${location}` }

        const wRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m`)
        const w = await wRes.json()
        const c = w?.current || {}
        return {
            location: [place.name, place.admin1, place.country].filter(Boolean).join(', '),
            temperature_c: c.temperature_2m,
            feels_like_c: c.apparent_temperature,
            humidity_pct: c.relative_humidity_2m,
            wind_kmh: c.wind_speed_10m,
            condition: WEATHER_CODES[c.weather_code] ?? 'Unknown',
        }
    } catch (e) {
        return { error: 'Weather lookup failed: ' + e.message }
    }
}

async function searchPastChats({ query } = {}, ctx = {}) {
    const userId = ctx.userId
    if (!userId) return { error: 'No user context available' }
    if (!query || !query.trim()) return { error: 'query is required' }

    const chats = await Chat.find({ userId, isArchived: { $ne: true } })
        .select('chatId title createdAt').sort({ createdAt: -1 }).limit(300).lean()
    if (!chats.length) return { results: [], note: 'No past conversations found.' }

    const titleById = Object.fromEntries(chats.map(c => [c.chatId, c.title]))
    const rx = new RegExp(escapeRegex(query.trim()), 'i')

    const msgs = await Message.find({ chatId: { $in: chats.map(c => c.chatId) }, content: rx })
        .select('chatId role content createdAt').sort({ createdAt: -1 }).limit(12).lean()

    const results = msgs.map(m => ({
        chatId: m.chatId,
        title: titleById[m.chatId] || 'Conversation',
        role: m.role,
        snippet: snippet(m.content, rx),
        when: m.createdAt,
    }))
    return results.length ? { results, count: results.length } : { results: [], note: 'No matching past messages.' }
}

async function recentChats({ limit } = {}, ctx = {}) {
    const userId = ctx.userId
    if (!userId) return { error: 'No user context available' }
    const n = Math.min(Math.max(parseInt(limit) || 10, 1), 20)
    const chats = await Chat.find({ userId, isArchived: { $ne: true } })
        .select('chatId title createdAt').sort({ createdAt: -1 }).limit(n).lean()
    return { chats: chats.map(c => ({ chatId: c.chatId, title: c.title, when: c.createdAt })) }
}

function createDiagram({ mermaid, caption } = {}) {
    if (!mermaid || !mermaid.trim()) return { error: 'mermaid code is required' }
    // Surfaced by the chat loop as a rendered ```mermaid block
    return { rendered: 'mermaid', mermaid: mermaid.trim(), caption: caption || '' }
}

function endConversation({ reason } = {}) {
    return { ended: true, reason: reason || 'Conversation ended.' }
}

// ─── System-prompt note (injected when tools are enabled) ─────────────────────
const TOOLS_SYSTEM_NOTE = `
CAPABILITIES (you can actually do these — never say you can't):
- Run code: execute Python, JavaScript/Node, or Bash in a secure sandbox for calculations, data work, or verifying logic.
- Search the web: get current, factual, or recent information (news, prices, live facts).
- Check live weather: current temperature and conditions for any city.
- Recall past chats: look up the user's earlier conversations when they reference prior context ("my project", "the bug we discussed", "what you suggested").
- Draw diagrams: render flowcharts/diagrams with Mermaid when a visual explains structure better than text.

Use these proactively the moment they help — don't ask permission for obvious cases. When info might be current or you're unsure, search rather than guess. Base answers on real tool results only; never fabricate data. After a web search, weave in what you found and cite sources when useful. Do not mention tool names, function calls, or internal mechanics to the user — just do the thing and answer naturally.`

// ─── Dispatcher ──────────────────────────────────────────────────────────────
async function runTool(name, args = {}, ctx = {}) {
    try {
        switch (name) {
            case 'run_code':          return await runCode(args)
            case 'web_search':        return await webSearch(args, ctx)
            case 'get_weather':       return await getWeather(args)
            case 'search_past_chats': return await searchPastChats(args, ctx)
            case 'recent_chats':      return await recentChats(args, ctx)
            case 'create_diagram':    return createDiagram(args)
            case 'end_conversation':  return endConversation(args)
            default:                  return { error: `Unknown tool: ${name}` }
        }
    } catch (err) {
        return { error: `Tool '${name}' failed: ${err.message}` }
    }
}

module.exports = { TOOL_SCHEMAS, runTool, TOOLS_SYSTEM_NOTE }
