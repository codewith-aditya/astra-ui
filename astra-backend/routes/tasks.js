const express = require('express')
const router = express.Router()
const auth = require('../middleware/auth')
const { limiters } = require('../middleware/rateLimit')
const { ServiceUnavailableError } = require('../utils/errors')

// Every route here spends money on a paid upstream provider, so each one is
// capped per authenticated user. Without this an authenticated caller could
// loop these endpoints and run up the provider bill unbounded — the global
// per-IP limiter alone does not bound per-account spend.
const paid = limiters.inference

// A conversation is caller-supplied and unbounded. Cap what is forwarded so a
// single request cannot ship a megabyte of prompt to the provider.
const MAX_TURNS = 20
const MAX_CHARS_PER_TURN = 2_000
const MAX_PROMPT_CHARS = 12_000

// ─── Nexusify LLM Config ────────────────────────────────────────────────────
const NEXUSIFY_API_URL = process.env.NEXUSIFY_API_URL || 'https://api.nexusify.xyz/v1/responses'
const NEXUSIFY_API_KEY = process.env.NEXUSIFY_API_KEY
const NEXUSIFY_MODEL = process.env.NEXUSIFY_MODEL || 'gpt-oss-120b'

/**
 * Call the Nexusify LLM API and return extracted text.
 * @param {string} prompt - The prompt to send to the LLM
 * @returns {Promise<string>} - The text response
 */
async function callLLM(prompt) {
    // Without a key the request goes out with "Bearer undefined" and the
    // provider's 401 surfaced as a generic 500. Fail with the real reason.
    if (!NEXUSIFY_API_KEY) {
        throw new ServiceUnavailableError(
            'Text generation is not configured on this server',
            'provider_not_configured',
        )
    }

    const res = await fetch(NEXUSIFY_API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${NEXUSIFY_API_KEY}`,
        },
        body: JSON.stringify({
            model: NEXUSIFY_MODEL,
            input: String(prompt).slice(0, MAX_PROMPT_CHARS),
        }),
        signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) throw new Error(`LLM error: ${res.status}`)
    const data = await res.json()
    // Extract text from Nexusify response format
    let text = ''
    if (data.output && Array.isArray(data.output)) {
        for (const item of data.output) {
            if (item.type === 'message' && item.content) {
                for (const part of item.content) {
                    if (part.type === 'output_text') text += part.text || ''
                }
            }
        }
    }
    return text || data.output || ''
}

/**
 * Format messages array into a readable conversation string for LLM context.
 */
function formatConversation(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return ''
    return messages
        .slice(-MAX_TURNS)
        .map(m => {
            const role = m?.role === 'user' ? 'User' : 'Assistant'
            // Each turn is caller-supplied; a single one could otherwise be
            // arbitrarily large even though the turn count is capped.
            const body = String(m?.content ?? '').slice(0, MAX_CHARS_PER_TURN)
            return `${role}: ${body}`
        })
        .join('\n')
}

/**
 * Safely parse a JSON array from LLM output.
 * Handles cases where the LLM wraps in markdown code blocks or adds extra text.
 */
function parseJSONArray(text) {
    if (!text || typeof text !== 'string') return []
    // Strip markdown code fences if present
    let cleaned = text.trim()
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
    // Try direct parse
    try {
        const parsed = JSON.parse(cleaned)
        if (Array.isArray(parsed)) return parsed
    } catch { /* fall through */ }
    // Try to find a JSON array in the text
    const match = cleaned.match(/\[[\s\S]*\]/)
    if (match) {
        try {
            const parsed = JSON.parse(match[0])
            if (Array.isArray(parsed)) return parsed
        } catch { /* fall through */ }
    }
    return []
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/tasks/title — Generate a short title for a conversation
// ─────────────────────────────────────────────────────────────────────────────
router.post('/api/tasks/title', auth, paid, async (req, res) => {
    try {
        const { messages } = req.body
        if (!Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({ error: 'messages array is required' })
        }

        const conversation = formatConversation(messages)
        const prompt = `${conversation}\n\nGenerate a short (max 6 words) title for this conversation. Return ONLY the title, nothing else.`
        const result = await callLLM(prompt)
        const title = result.trim().replace(/^["']|["']$/g, '').slice(0, 80)

        res.json({ title: title || 'New Chat' })
    } catch (err) {
        console.error('[tasks/title]', err.message)
        res.status(500).json({ error: 'Failed to generate title' })
    }
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/tasks/tags — Generate relevant tags for a conversation
// ─────────────────────────────────────────────────────────────────────────────
router.post('/api/tasks/tags', auth, paid, async (req, res) => {
    try {
        const { messages } = req.body
        if (!Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({ error: 'messages array is required' })
        }

        const conversation = formatConversation(messages)
        const prompt = `${conversation}\n\nGenerate 1-3 relevant tags for this conversation. Return as JSON array of strings.`
        const result = await callLLM(prompt)
        const tags = parseJSONArray(result)
            .slice(0, 3)
            .map(t => String(t).trim().toLowerCase().slice(0, 30))
            .filter(Boolean)

        res.json({ tags })
    } catch (err) {
        console.error('[tasks/tags]', err.message)
        res.status(500).json({ error: 'Failed to generate tags' })
    }
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/tasks/emoji — Pick one emoji that best represents the conversation
// ─────────────────────────────────────────────────────────────────────────────
router.post('/api/tasks/emoji', auth, paid, async (req, res) => {
    try {
        const { messages } = req.body
        if (!Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({ error: 'messages array is required' })
        }

        const conversation = formatConversation(messages)
        const prompt = `${conversation}\n\nPick one emoji that best represents this conversation. Return ONLY the emoji.`
        const result = await callLLM(prompt)
        // Extract the first emoji character(s) from the response
        const emojiMatch = result.trim().match(/\p{Emoji_Presentation}|\p{Emoji}\uFE0F/u)
        const emoji = emojiMatch ? emojiMatch[0] : '💬'

        res.json({ emoji })
    } catch (err) {
        console.error('[tasks/emoji]', err.message)
        res.status(500).json({ error: 'Failed to generate emoji' })
    }
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/tasks/followup — Generate follow-up questions the user might ask
// ─────────────────────────────────────────────────────────────────────────────
router.post('/api/tasks/followup', auth, paid, async (req, res) => {
    try {
        const { messages } = req.body
        if (!Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({ error: 'messages array is required' })
        }

        const conversation = formatConversation(messages)
        const prompt = `${conversation}\n\nGenerate 3 follow-up questions the user might ask next. Return as JSON array of strings.`
        const result = await callLLM(prompt)
        const questions = parseJSONArray(result)
            .slice(0, 3)
            .map(q => String(q).trim().slice(0, 200))
            .filter(Boolean)

        res.json({ questions })
    } catch (err) {
        console.error('[tasks/followup]', err.message)
        res.status(500).json({ error: 'Failed to generate follow-up questions' })
    }
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/tasks/autocomplete — Autocomplete a partial message
// ─────────────────────────────────────────────────────────────────────────────
router.post('/api/tasks/autocomplete', auth, paid, async (req, res) => {
    try {
        const { text, messages } = req.body
        if (!text?.trim()) {
            return res.status(400).json({ error: 'text is required' })
        }
        if (text.length > 500) {
            return res.status(400).json({ error: 'text too long (max 500 chars)' })
        }

        let prompt = ''
        if (Array.isArray(messages) && messages.length > 0) {
            const conversation = formatConversation(messages)
            prompt = `${conversation}\n\nThe user is typing: "${text}"\n\nComplete this partial message in 5-10 words. Return ONLY the completion.`
        } else {
            prompt = `The user is typing: "${text}"\n\nComplete this partial message in 5-10 words. Return ONLY the completion.`
        }

        const result = await callLLM(prompt)
        const completion = result.trim().replace(/^["']|["']$/g, '').slice(0, 200)

        res.json({ completion })
    } catch (err) {
        console.error('[tasks/autocomplete]', err.message)
        res.status(500).json({ error: 'Failed to generate autocomplete' })
    }
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/tasks/query — Generate a concise web search query
// ─────────────────────────────────────────────────────────────────────────────
router.post('/api/tasks/query', auth, paid, async (req, res) => {
    try {
        const { messages } = req.body
        if (!Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({ error: 'messages array is required' })
        }

        const conversation = formatConversation(messages)
        const prompt = `${conversation}\n\nGenerate a concise web search query for this conversation context. Return ONLY the search query.`
        const result = await callLLM(prompt)
        const query = result.trim().replace(/^["']|["']$/g, '').slice(0, 200)

        res.json({ query })
    } catch (err) {
        console.error('[tasks/query]', err.message)
        res.status(500).json({ error: 'Failed to generate search query' })
    }
})

module.exports = router
