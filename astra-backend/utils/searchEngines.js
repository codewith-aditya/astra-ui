// ═══════════════════════════════════════════════════════════════════════════════
//  Multi-Search Engine Support
//  Supports: Tavily, Brave, DuckDuckGo, Serper, SearXNG, Bing, Jina, Exa
// ═══════════════════════════════════════════════════════════════════════════════

const Config = require('../models/Config')

const SEARCH_ENGINES = {
    tavily: {
        name: 'Tavily',
        requiresKey: true,
        search: async (query, apiKey) => {
            const res = await fetch('https://api.tavily.com/search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    api_key: apiKey,
                    query,
                    max_results: 5,
                    include_answer: true,
                }),
                signal: AbortSignal.timeout(15000),
            })
            if (!res.ok) throw new Error(`Tavily: ${res.status}`)
            const data = await res.json()
            return {
                answer: data.answer || '',
                results: (data.results || []).map(r => ({
                    title: r.title,
                    url: r.url,
                    snippet: r.content?.slice(0, 300) || '',
                })),
            }
        },
    },

    brave: {
        name: 'Brave Search',
        requiresKey: true,
        search: async (query, apiKey) => {
            const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`
            const res = await fetch(url, {
                headers: { 'Accept': 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': apiKey },
                signal: AbortSignal.timeout(15000),
            })
            if (!res.ok) throw new Error(`Brave: ${res.status}`)
            const data = await res.json()
            return {
                answer: '',
                results: (data.web?.results || []).map(r => ({
                    title: r.title,
                    url: r.url,
                    snippet: r.description?.slice(0, 300) || '',
                })),
            }
        },
    },

    serper: {
        name: 'Serper (Google)',
        requiresKey: true,
        search: async (query, apiKey) => {
            const res = await fetch('https://google.serper.dev/search', {
                method: 'POST',
                headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ q: query, num: 5 }),
                signal: AbortSignal.timeout(15000),
            })
            if (!res.ok) throw new Error(`Serper: ${res.status}`)
            const data = await res.json()
            return {
                answer: data.answerBox?.snippet || data.answerBox?.answer || '',
                results: (data.organic || []).map(r => ({
                    title: r.title,
                    url: r.link,
                    snippet: r.snippet?.slice(0, 300) || '',
                })),
            }
        },
    },

    duckduckgo: {
        name: 'DuckDuckGo',
        requiresKey: false,
        search: async (query) => {
            // DDG instant answer API (limited but free, no key needed)
            const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`
            const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
            if (!res.ok) throw new Error(`DuckDuckGo: ${res.status}`)
            const data = await res.json()
            const results = []
            if (data.AbstractText) {
                results.push({ title: data.Heading || query, url: data.AbstractURL || '', snippet: data.AbstractText })
            }
            for (const topic of (data.RelatedTopics || []).slice(0, 5)) {
                if (topic.Text) {
                    results.push({ title: topic.Text.slice(0, 80), url: topic.FirstURL || '', snippet: topic.Text })
                }
            }
            return { answer: data.AbstractText || '', results }
        },
    },

    searxng: {
        name: 'SearXNG',
        requiresKey: false,
        search: async (query, apiKey, instanceUrl) => {
            const base = instanceUrl || 'https://searx.be'
            const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&categories=general&engines=google,bing,duckduckgo`
            const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
            if (!res.ok) throw new Error(`SearXNG: ${res.status}`)
            const data = await res.json()
            return {
                answer: '',
                results: (data.results || []).slice(0, 5).map(r => ({
                    title: r.title,
                    url: r.url,
                    snippet: (r.content || '').slice(0, 300),
                })),
            }
        },
    },

    bing: {
        name: 'Bing',
        requiresKey: true,
        search: async (query, apiKey) => {
            const url = `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(query)}&count=5`
            const res = await fetch(url, {
                headers: { 'Ocp-Apim-Subscription-Key': apiKey },
                signal: AbortSignal.timeout(15000),
            })
            if (!res.ok) throw new Error(`Bing: ${res.status}`)
            const data = await res.json()
            return {
                answer: '',
                results: (data.webPages?.value || []).map(r => ({
                    title: r.name,
                    url: r.url,
                    snippet: r.snippet?.slice(0, 300) || '',
                })),
            }
        },
    },

    jina: {
        name: 'Jina Search',
        requiresKey: true,
        search: async (query, apiKey) => {
            const res = await fetch(`https://s.jina.ai/${encodeURIComponent(query)}`, {
                headers: {
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                },
                signal: AbortSignal.timeout(15000),
            })
            if (!res.ok) throw new Error(`Jina: ${res.status}`)
            const data = await res.json()
            return {
                answer: '',
                results: (data.data || []).slice(0, 5).map(r => ({
                    title: r.title || '',
                    url: r.url || '',
                    snippet: (r.description || r.content || '').slice(0, 300),
                })),
            }
        },
    },

    exa: {
        name: 'Exa',
        requiresKey: true,
        search: async (query, apiKey) => {
            const res = await fetch('https://api.exa.ai/search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
                body: JSON.stringify({ query, numResults: 5, useAutoprompt: true }),
                signal: AbortSignal.timeout(15000),
            })
            if (!res.ok) throw new Error(`Exa: ${res.status}`)
            const data = await res.json()
            return {
                answer: '',
                results: (data.results || []).map(r => ({
                    title: r.title || '',
                    url: r.url || '',
                    snippet: (r.text || '').slice(0, 300),
                })),
            }
        },
    },
}

/**
 * Search using configured engine
 * @param {string} query - Search query
 * @param {string} userId - User ID to load config
 * @param {string} [engine] - Override engine name
 * @returns {Promise<{answer: string, results: Array}>}
 */
async function search(query, userId, engine) {
    // Load user's search config
    let engineName = engine
    let apiKey = ''
    let instanceUrl = ''

    if (userId) {
        try {
            const config = await Config.findOne({ userId, key: 'search_engine' }).lean()
            if (config?.value) {
                engineName = engineName || config.value.engine || 'duckduckgo'
                apiKey = config.value.apiKey || ''
                instanceUrl = config.value.instanceUrl || ''
            }
        } catch { /* use defaults */ }
    }

    // Fallback to env vars
    engineName = engineName || process.env.SEARCH_ENGINE || 'duckduckgo'
    apiKey = apiKey || process.env[`${engineName.toUpperCase()}_API_KEY`] || process.env.TAVILY_API_KEY || ''

    const handler = SEARCH_ENGINES[engineName]
    if (!handler) {
        throw new Error(`Unknown search engine: ${engineName}. Available: ${Object.keys(SEARCH_ENGINES).join(', ')}`)
    }

    if (handler.requiresKey && !apiKey) {
        throw new Error(`${handler.name} requires an API key. Set it in Settings → Search.`)
    }

    return handler.search(query, apiKey, instanceUrl)
}

module.exports = { search, SEARCH_ENGINES }
