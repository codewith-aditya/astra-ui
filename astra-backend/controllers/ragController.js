const { v4: uuidv4 } = require('uuid')
const File = require('../models/File')
const Knowledge = require('../models/Knowledge')
const KnowledgeFile = require('../models/KnowledgeFile')
const Config = require('../models/Config')
const logger = require('../utils/logger')
const { safeFetch } = require('../utils/safeFetch')

// ═══════════════════════════════════════════════════════════════════════════════
//  RAG Controller — Retrieval Augmented Generation
//  In-memory vector store with TF-IDF keyword search fallback
//  AstraGPT · Tantra AI Labs · 2025
// ═══════════════════════════════════════════════════════════════════════════════

// ─── In-Memory Vector Store ──────────────────────────────────────────────────
// Map<knowledgeId, Array<{ chunkId, text, terms, fileId, index }>>
const vectorStore = new Map()

// ─── Default RAG Config ──────────────────────────────────────────────────────
const DEFAULT_RAG_CONFIG = {
    chunkSize: 1000,
    chunkOverlap: 200,
    topK: 5,
    scoreThreshold: 0.05,
    maxFileSize: 50000,      // max chars per file
    maxChunksPerFile: 200,
    searchEngine: 'tavily',  // tavily | brave | serper | google
}

// ─── Text Utilities ──────────────────────────────────────────────────────────

/**
 * Split text into overlapping chunks
 */
function chunkText(text, chunkSize = 1000, overlap = 200) {
    if (!text || text.length === 0) return []
    const chunks = []
    let start = 0
    while (start < text.length) {
        const end = Math.min(start + chunkSize, text.length)
        chunks.push(text.slice(start, end))
        start += chunkSize - overlap
        if (start >= text.length) break
        // Avoid creating tiny trailing chunks
        if (text.length - start < overlap) {
            chunks.push(text.slice(start))
            break
        }
    }
    return chunks
}

/**
 * Tokenize text into normalized terms (simple whitespace + lowercase)
 */
function tokenize(text) {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length > 1)
}

/**
 * Build term frequency map from tokens
 */
function termFrequency(tokens) {
    const tf = {}
    for (const t of tokens) {
        tf[t] = (tf[t] || 0) + 1
    }
    // Normalize by total tokens
    const total = tokens.length || 1
    for (const t in tf) {
        tf[t] = tf[t] / total
    }
    return tf
}

/**
 * Compute cosine similarity between two TF vectors
 */
function cosineSimilarity(tfA, tfB) {
    const allTerms = new Set([...Object.keys(tfA), ...Object.keys(tfB)])
    let dotProduct = 0
    let magA = 0
    let magB = 0
    for (const term of allTerms) {
        const a = tfA[term] || 0
        const b = tfB[term] || 0
        dotProduct += a * b
        magA += a * a
        magB += b * b
    }
    const magnitude = Math.sqrt(magA) * Math.sqrt(magB)
    return magnitude === 0 ? 0 : dotProduct / magnitude
}

/**
 * Search chunks in a knowledge base by query using TF-IDF cosine similarity
 */
function searchChunks(knowledgeId, query, topK = 5, scoreThreshold = 0.05) {
    const chunks = vectorStore.get(knowledgeId)
    if (!chunks || chunks.length === 0) return []

    const queryTokens = tokenize(query)
    if (queryTokens.length === 0) return []

    const queryTF = termFrequency(queryTokens)

    const scored = chunks.map(chunk => ({
        ...chunk,
        score: cosineSimilarity(queryTF, chunk.terms),
    }))

    return scored
        .filter(c => c.score >= scoreThreshold)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)
        .map(c => ({
            chunkId: c.chunkId,
            text: c.text,
            score: Math.round(c.score * 10000) / 10000,
            fileId: c.fileId,
            index: c.index,
        }))
}

/**
 * Store chunks for a knowledge base
 */
function storeChunks(knowledgeId, fileId, textChunks) {
    if (!vectorStore.has(knowledgeId)) {
        vectorStore.set(knowledgeId, [])
    }
    const store = vectorStore.get(knowledgeId)
    const newChunks = textChunks.map((text, index) => {
        const tokens = tokenize(text)
        return {
            chunkId: uuidv4(),
            text,
            terms: termFrequency(tokens),
            fileId,
            index,
        }
    })
    store.push(...newChunks)
    return newChunks.length
}

/**
 * Get user's RAG config from DB, with defaults
 */
async function getUserConfig(userId) {
    const doc = await Config.findOne({ userId, key: 'rag' })
    if (!doc || !doc.value) return { ...DEFAULT_RAG_CONFIG }
    return { ...DEFAULT_RAG_CONFIG, ...doc.value }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  CONTROLLER METHODS
// ═══════════════════════════════════════════════════════════════════════════════

// ─── POST /api/rag/embed — Chunk and store file text ─────────────────────────
exports.embedFile = async (req, res) => {
    try {
        const userId = req.userId
        const { text, fileId, knowledgeId, filename } = req.body

        if (!text?.trim()) {
            return res.status(400).json({ error: 'text is required' })
        }
        if (!knowledgeId) {
            return res.status(400).json({ error: 'knowledgeId is required' })
        }

        // Verify knowledge base belongs to user
        const kb = await Knowledge.findOne({ knowledgeId, userId })
        if (!kb) {
            return res.status(404).json({ error: 'Knowledge base not found' })
        }

        // Get user config for chunk parameters
        const config = await getUserConfig(userId)
        const trimmedText = text.slice(0, config.maxFileSize)

        // Chunk the text
        const chunks = chunkText(trimmedText, config.chunkSize, config.chunkOverlap)
        if (chunks.length === 0) {
            return res.status(400).json({ error: 'No content to embed after chunking' })
        }
        if (chunks.length > config.maxChunksPerFile) {
            return res.status(400).json({
                error: `Too many chunks (${chunks.length}). Max ${config.maxChunksPerFile} per file. Reduce text or increase chunk size.`,
            })
        }

        // Create or find File record
        let file
        if (fileId) {
            file = await File.findOne({ fileId, userId })
        }
        if (!file) {
            file = await File.create({
                userId,
                filename: filename || 'uploaded-text.txt',
                contentType: 'text/plain',
                size: trimmedText.length,
                meta: {
                    extractedText: trimmedText.slice(0, 5000),
                    tokenCount: tokenize(trimmedText).length,
                    embeddingStatus: 'processing',
                    chunkCount: chunks.length,
                },
            })
        }

        // Store chunks in memory
        const stored = storeChunks(knowledgeId, file.fileId, chunks)

        // Link file to knowledge base
        await KnowledgeFile.findOneAndUpdate(
            { knowledgeId, fileId: file.fileId },
            { knowledgeId, fileId: file.fileId, userId },
            { upsert: true, new: true }
        )

        // Update file embedding status
        await File.findOneAndUpdate(
            { fileId: file.fileId },
            { 'meta.embeddingStatus': 'completed', 'meta.chunkCount': chunks.length }
        )

        // Update knowledge base file count
        const fileCount = await KnowledgeFile.countDocuments({ knowledgeId })
        await Knowledge.findOneAndUpdate({ knowledgeId }, { fileCount })

        console.log(`[RAG embed] ✅ ${stored} chunks stored for KB ${knowledgeId.slice(0, 8)} | file: ${file.fileId.slice(0, 8)}`)

        res.json({
            ok: true,
            fileId: file.fileId,
            knowledgeId,
            chunks: stored,
            totalChunksInKB: vectorStore.get(knowledgeId)?.length || 0,
        })
    } catch (err) {
        console.error('[RAG embed]', err.message)
        res.status(500).json({ error: 'Failed to embed file' })
    }
}

// ─── POST /api/rag/query — Search knowledge base ────────────────────────────
exports.queryRAG = async (req, res) => {
    try {
        const userId = req.userId
        const { query, knowledgeId, topK, scoreThreshold } = req.body

        if (!query?.trim()) {
            return res.status(400).json({ error: 'query is required' })
        }
        if (!knowledgeId) {
            return res.status(400).json({ error: 'knowledgeId is required' })
        }

        // Verify ownership
        const kb = await Knowledge.findOne({ knowledgeId, userId })
        if (!kb) {
            return res.status(404).json({ error: 'Knowledge base not found' })
        }

        const config = await getUserConfig(userId)
        const k = topK || config.topK
        const threshold = scoreThreshold ?? config.scoreThreshold

        const results = searchChunks(knowledgeId, query, k, threshold)

        // Build context string for LLM consumption
        const context = results.map((r, i) => `[${i + 1}] (score: ${r.score})\n${r.text}`).join('\n\n---\n\n')

        console.log(`[RAG query] 🔍 "${query.slice(0, 50)}" → ${results.length} results from KB ${knowledgeId.slice(0, 8)}`)

        res.json({
            ok: true,
            query,
            knowledgeId,
            results,
            context,
            totalResults: results.length,
        })
    } catch (err) {
        console.error('[RAG query]', err.message)
        res.status(500).json({ error: 'Failed to query knowledge base' })
    }
}

// ─── GET /api/rag/config — Get user's RAG configuration ─────────────────────
exports.getConfig = async (req, res) => {
    try {
        const config = await getUserConfig(req.userId)
        res.json({ config })
    } catch (err) {
        console.error('[RAG getConfig]', err.message)
        res.status(500).json({ error: 'Failed to fetch RAG config' })
    }
}

// ─── POST /api/rag/config — Update user's RAG configuration ─────────────────
exports.updateConfig = async (req, res) => {
    try {
        const userId = req.userId
        const { chunkSize, chunkOverlap, topK, scoreThreshold, searchEngine } = req.body

        // Validate ranges
        const update = {}
        if (chunkSize !== undefined) {
            const size = parseInt(chunkSize)
            if (isNaN(size) || size < 100 || size > 10000) {
                return res.status(400).json({ error: 'chunkSize must be between 100 and 10000' })
            }
            update.chunkSize = size
        }
        if (chunkOverlap !== undefined) {
            const overlap = parseInt(chunkOverlap)
            if (isNaN(overlap) || overlap < 0 || overlap > 5000) {
                return res.status(400).json({ error: 'chunkOverlap must be between 0 and 5000' })
            }
            update.chunkOverlap = overlap
        }
        if (topK !== undefined) {
            const k = parseInt(topK)
            if (isNaN(k) || k < 1 || k > 50) {
                return res.status(400).json({ error: 'topK must be between 1 and 50' })
            }
            update.topK = k
        }
        if (scoreThreshold !== undefined) {
            const thresh = parseFloat(scoreThreshold)
            if (isNaN(thresh) || thresh < 0 || thresh > 1) {
                return res.status(400).json({ error: 'scoreThreshold must be between 0 and 1' })
            }
            update.scoreThreshold = thresh
        }
        if (searchEngine !== undefined) {
            const valid = ['tavily', 'brave', 'serper', 'google']
            if (!valid.includes(searchEngine)) {
                return res.status(400).json({ error: `searchEngine must be one of: ${valid.join(', ')}` })
            }
            update.searchEngine = searchEngine
        }

        // Validate chunkOverlap < chunkSize
        const current = await getUserConfig(userId)
        const merged = { ...current, ...update }
        if (merged.chunkOverlap >= merged.chunkSize) {
            return res.status(400).json({ error: 'chunkOverlap must be less than chunkSize' })
        }

        // Upsert config
        await Config.findOneAndUpdate(
            { userId, key: 'rag' },
            { userId, key: 'rag', value: merged },
            { upsert: true, new: true }
        )

        console.log(`[RAG config] ⚙️ Updated for user ${userId.slice(0, 8)}`)

        res.json({ ok: true, config: merged })
    } catch (err) {
        console.error('[RAG updateConfig]', err.message)
        res.status(500).json({ error: 'Failed to update RAG config' })
    }
}

// ─── POST /api/rag/process — Process a file for knowledge base ──────────────
exports.processFile = async (req, res) => {
    try {
        const userId = req.userId
        const { fileId, knowledgeId, text, filename } = req.body

        if (!knowledgeId) {
            return res.status(400).json({ error: 'knowledgeId is required' })
        }

        // Verify ownership
        const kb = await Knowledge.findOne({ knowledgeId, userId })
        if (!kb) {
            return res.status(404).json({ error: 'Knowledge base not found' })
        }

        // Get text — either from body or from existing File record
        let content = text
        if (!content && fileId) {
            const file = await File.findOne({ fileId, userId })
            if (!file) {
                return res.status(404).json({ error: 'File not found' })
            }
            content = file.meta?.extractedText
            if (!content) {
                return res.status(400).json({ error: 'File has no extracted text. Upload text content directly.' })
            }
        }

        if (!content?.trim()) {
            return res.status(400).json({ error: 'No text content to process. Provide text or a valid fileId.' })
        }

        const config = await getUserConfig(userId)
        const trimmedText = content.slice(0, config.maxFileSize)

        // Chunk
        const chunks = chunkText(trimmedText, config.chunkSize, config.chunkOverlap)
        if (chunks.length === 0) {
            return res.status(400).json({ error: 'No content after chunking' })
        }

        // Create File record if needed
        let file
        if (fileId) {
            file = await File.findOne({ fileId, userId })
        }
        if (!file) {
            file = await File.create({
                userId,
                filename: filename || 'processed-file.txt',
                contentType: 'text/plain',
                size: trimmedText.length,
                meta: {
                    extractedText: trimmedText.slice(0, 5000),
                    tokenCount: tokenize(trimmedText).length,
                    embeddingStatus: 'processing',
                    chunkCount: chunks.length,
                },
            })
        }

        // Store
        const stored = storeChunks(knowledgeId, file.fileId, chunks)

        // Link
        await KnowledgeFile.findOneAndUpdate(
            { knowledgeId, fileId: file.fileId },
            { knowledgeId, fileId: file.fileId, userId },
            { upsert: true, new: true }
        )

        // Update statuses
        await File.findOneAndUpdate(
            { fileId: file.fileId },
            { 'meta.embeddingStatus': 'completed', 'meta.chunkCount': chunks.length }
        )
        const fileCount = await KnowledgeFile.countDocuments({ knowledgeId })
        await Knowledge.findOneAndUpdate({ knowledgeId }, { fileCount })

        console.log(`[RAG process] ✅ Processed "${file.filename}" → ${stored} chunks into KB ${knowledgeId.slice(0, 8)}`)

        res.json({
            ok: true,
            fileId: file.fileId,
            filename: file.filename,
            knowledgeId,
            chunks: stored,
            totalChunksInKB: vectorStore.get(knowledgeId)?.length || 0,
        })
    } catch (err) {
        console.error('[RAG process]', err.message)
        res.status(500).json({ error: 'Failed to process file' })
    }
}

// ─── POST /api/rag/process/batch — Process multiple files ────────────────────
exports.batchProcess = async (req, res) => {
    try {
        const userId = req.userId
        const { files, knowledgeId } = req.body

        if (!knowledgeId) {
            return res.status(400).json({ error: 'knowledgeId is required' })
        }
        if (!Array.isArray(files) || files.length === 0) {
            return res.status(400).json({ error: 'files array is required and must not be empty' })
        }
        if (files.length > 50) {
            return res.status(400).json({ error: 'Maximum 50 files per batch' })
        }

        // Verify ownership
        const kb = await Knowledge.findOne({ knowledgeId, userId })
        if (!kb) {
            return res.status(404).json({ error: 'Knowledge base not found' })
        }

        const config = await getUserConfig(userId)
        const results = []
        let totalChunks = 0

        for (const item of files) {
            const { text, fileId, filename } = item
            try {
                // Resolve text content
                let content = text
                if (!content && fileId) {
                    const existingFile = await File.findOne({ fileId, userId })
                    content = existingFile?.meta?.extractedText
                }

                if (!content?.trim()) {
                    results.push({
                        filename: filename || fileId || 'unknown',
                        status: 'skipped',
                        error: 'No text content',
                    })
                    continue
                }

                const trimmedText = content.slice(0, config.maxFileSize)
                const chunks = chunkText(trimmedText, config.chunkSize, config.chunkOverlap)

                if (chunks.length === 0) {
                    results.push({
                        filename: filename || fileId || 'unknown',
                        status: 'skipped',
                        error: 'Empty after chunking',
                    })
                    continue
                }

                // Create File record
                let file
                if (fileId) {
                    file = await File.findOne({ fileId, userId })
                }
                if (!file) {
                    file = await File.create({
                        userId,
                        filename: filename || `batch-file-${results.length + 1}.txt`,
                        contentType: 'text/plain',
                        size: trimmedText.length,
                        meta: {
                            extractedText: trimmedText.slice(0, 5000),
                            tokenCount: tokenize(trimmedText).length,
                            embeddingStatus: 'processing',
                            chunkCount: chunks.length,
                        },
                    })
                }

                // Store and link
                const stored = storeChunks(knowledgeId, file.fileId, chunks)

                await KnowledgeFile.findOneAndUpdate(
                    { knowledgeId, fileId: file.fileId },
                    { knowledgeId, fileId: file.fileId, userId },
                    { upsert: true, new: true }
                )

                await File.findOneAndUpdate(
                    { fileId: file.fileId },
                    { 'meta.embeddingStatus': 'completed', 'meta.chunkCount': chunks.length }
                )

                totalChunks += stored
                results.push({
                    fileId: file.fileId,
                    filename: file.filename,
                    status: 'completed',
                    chunks: stored,
                })
            } catch (fileErr) {
                results.push({
                    filename: filename || fileId || 'unknown',
                    status: 'failed',
                    error: fileErr.message,
                })
            }
        }

        // Update knowledge base file count
        const fileCount = await KnowledgeFile.countDocuments({ knowledgeId })
        await Knowledge.findOneAndUpdate({ knowledgeId }, { fileCount })

        const completed = results.filter(r => r.status === 'completed').length
        const failed = results.filter(r => r.status === 'failed').length
        const skipped = results.filter(r => r.status === 'skipped').length

        console.log(`[RAG batch] ✅ ${completed}/${files.length} files processed (${failed} failed, ${skipped} skipped) → KB ${knowledgeId.slice(0, 8)}`)

        res.json({
            ok: true,
            knowledgeId,
            totalFiles: files.length,
            completed,
            failed,
            skipped,
            totalChunks,
            totalChunksInKB: vectorStore.get(knowledgeId)?.length || 0,
            results,
        })
    } catch (err) {
        console.error('[RAG batch]', err.message)
        res.status(500).json({ error: 'Failed to batch process files' })
    }
}

// ─── POST /api/rag/web/search — Proxy to search engine ──────────────────────
exports.webSearch = async (req, res) => {
    try {
        const userId = req.userId
        const { query, maxResults = 5 } = req.body

        if (!query?.trim()) {
            return res.status(400).json({ error: 'query is required' })
        }

        const config = await getUserConfig(userId)
        const engine = config.searchEngine || 'tavily'

        let results = []

        // ── Tavily Search ────────────────────────────────────────────────────
        if (engine === 'tavily') {
            const apiKey = process.env.TAVILY_API_KEY
            if (!apiKey) {
                return res.status(503).json({ error: 'Tavily API key not configured. Set TAVILY_API_KEY in .env' })
            }
            try {
                const response = await fetch('https://api.tavily.com/search', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        api_key: apiKey,
                        query: query.trim(),
                        max_results: Math.min(maxResults, 20),
                        include_answer: true,
                        include_raw_content: false,
                    }),
                })
                if (!response.ok) {
                    const errText = await response.text()
                    throw new Error(`Tavily API error: ${response.status} — ${errText}`)
                }
                const data = await response.json()
                results = (data.results || []).map(r => ({
                    title: r.title,
                    url: r.url,
                    snippet: r.content || '',
                    score: r.score,
                }))
                // Include Tavily's generated answer if available
                if (data.answer) {
                    results.unshift({ title: 'AI Summary', url: '', snippet: data.answer, score: 1 })
                }
            } catch (tavilyErr) {
                console.error('[RAG webSearch] Tavily error:', tavilyErr.message)
                return res.status(502).json({ error: `Search provider error: ${tavilyErr.message}` })
            }
        }

        // ── Brave Search ─────────────────────────────────────────────────────
        else if (engine === 'brave') {
            const apiKey = process.env.BRAVE_SEARCH_KEY
            if (!apiKey) {
                return res.status(503).json({ error: 'Brave Search API key not configured. Set BRAVE_SEARCH_KEY in .env' })
            }
            try {
                const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query.trim())}&count=${Math.min(maxResults, 20)}`
                const response = await fetch(url, {
                    headers: {
                        'Accept': 'application/json',
                        'Accept-Encoding': 'gzip',
                        'X-Subscription-Token': apiKey,
                    },
                })
                if (!response.ok) {
                    const errText = await response.text()
                    throw new Error(`Brave API error: ${response.status} — ${errText}`)
                }
                const data = await response.json()
                results = (data.web?.results || []).map(r => ({
                    title: r.title,
                    url: r.url,
                    snippet: r.description || '',
                    score: null,
                }))
            } catch (braveErr) {
                console.error('[RAG webSearch] Brave error:', braveErr.message)
                return res.status(502).json({ error: `Search provider error: ${braveErr.message}` })
            }
        }

        // ── Serper (Google SERP) ─────────────────────────────────────────────
        else if (engine === 'serper') {
            const apiKey = process.env.SERPER_API_KEY
            if (!apiKey) {
                return res.status(503).json({ error: 'Serper API key not configured. Set SERPER_API_KEY in .env' })
            }
            try {
                const response = await fetch('https://google.serper.dev/search', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-API-KEY': apiKey,
                    },
                    body: JSON.stringify({
                        q: query.trim(),
                        num: Math.min(maxResults, 20),
                    }),
                })
                if (!response.ok) {
                    const errText = await response.text()
                    throw new Error(`Serper API error: ${response.status} — ${errText}`)
                }
                const data = await response.json()
                results = (data.organic || []).map(r => ({
                    title: r.title,
                    url: r.link,
                    snippet: r.snippet || '',
                    score: null,
                }))
                if (data.answerBox?.answer) {
                    results.unshift({ title: 'Answer Box', url: '', snippet: data.answerBox.answer, score: 1 })
                }
            } catch (serperErr) {
                console.error('[RAG webSearch] Serper error:', serperErr.message)
                return res.status(502).json({ error: `Search provider error: ${serperErr.message}` })
            }
        }

        // ── Google Custom Search ─────────────────────────────────────────────
        else if (engine === 'google') {
            const apiKey = process.env.GOOGLE_SEARCH_KEY
            const cx = process.env.GOOGLE_SEARCH_CX
            if (!apiKey || !cx) {
                return res.status(503).json({ error: 'Google Search API key or CX not configured. Set GOOGLE_SEARCH_KEY and GOOGLE_SEARCH_CX in .env' })
            }
            try {
                const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cx}&q=${encodeURIComponent(query.trim())}&num=${Math.min(maxResults, 10)}`
                const response = await fetch(url)
                if (!response.ok) {
                    const errText = await response.text()
                    throw new Error(`Google API error: ${response.status} — ${errText}`)
                }
                const data = await response.json()
                results = (data.items || []).map(r => ({
                    title: r.title,
                    url: r.link,
                    snippet: r.snippet || '',
                    score: null,
                }))
            } catch (googleErr) {
                console.error('[RAG webSearch] Google error:', googleErr.message)
                return res.status(502).json({ error: `Search provider error: ${googleErr.message}` })
            }
        }

        else {
            return res.status(400).json({ error: `Unknown search engine: ${engine}` })
        }

        console.log(`[RAG webSearch] 🌐 "${query.slice(0, 50)}" via ${engine} → ${results.length} results`)

        res.json({
            ok: true,
            query,
            engine,
            results,
            totalResults: results.length,
        })
    } catch (err) {
        console.error('[RAG webSearch]', err.message)
        res.status(500).json({ error: 'Web search failed' })
    }
}

// ─── POST /api/rag/web/load — Load webpage content ──────────────────────────
exports.webLoad = async (req, res) => {
    try {
        const { url, maxLength = 50000 } = req.body

        if (!url?.trim()) {
            return res.status(400).json({ error: 'url is required' })
        }

        // SSRF protection is delegated to utils/safeFetch, which resolves DNS and
        // checks the resulting addresses against private/link-local/CGNAT ranges,
        // then re-checks every redirect hop. The previous guard compared hostname
        // string prefixes, which missed decimal (2130706433), hex (0x7f000001),
        // short-form (127.1) and IPv4-mapped IPv6 encodings, over-blocked all of
        // 172.*, and followed redirects into private space unchecked.
        let response
        try {
            response = await safeFetch(url, {
                timeoutMs: 15000,
                maxBytes: 5 * 1024 * 1024,
                headers: {
                    'User-Agent': 'AstraGPT-RAG/1.0 (compatible; bot)',
                    'Accept': 'text/html,application/xhtml+xml,text/plain,application/json',
                    'Accept-Language': 'en-US,en;q=0.9',
                },
            })
        } catch (fetchErr) {
            // safeFetch raises typed operational errors (blocked_address,
            // dns_failure, upstream_timeout, response_too_large). Surface their
            // own status and safe message rather than collapsing to a 500.
            if (fetchErr.expose && fetchErr.status) {
                return res.status(fetchErr.status).json({
                    error: fetchErr.message,
                    code: fetchErr.code,
                })
            }
            throw fetchErr
        }

        if (!response.ok) {
            return res.status(502).json({ error: `Failed to fetch URL: HTTP ${response.status}` })
        }

        const contentType = response.headers.get('content-type') || ''
        const rawBody = await response.text()

        // Strip HTML tags → extract readable text
        let text
        if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
            text = htmlToText(rawBody)
        } else if (contentType.includes('application/json')) {
            // Pretty-print JSON for readability
            try {
                text = JSON.stringify(JSON.parse(rawBody), null, 2)
            } catch {
                text = rawBody
            }
        } else {
            text = rawBody
        }

        // Truncate to max length
        const truncated = text.length > maxLength
        const content = text.slice(0, maxLength)

        console.log(`[RAG webLoad] 🌐 Loaded ${url.slice(0, 60)} → ${content.length} chars`)

        res.json({
            ok: true,
            url,
            contentType,
            content,
            length: content.length,
            truncated,
            originalLength: text.length,
        })
    } catch (err) {
        console.error('[RAG webLoad]', err.message)
        res.status(500).json({ error: 'Failed to load webpage' })
    }
}

// ─── HTML → Text (lightweight, no dependency) ───────────────────────────────
function htmlToText(html) {
    let text = html

    // Remove script, style, svg, noscript blocks entirely
    text = text.replace(/<(script|style|svg|noscript|head)[^>]*>[\s\S]*?<\/\1>/gi, '')

    // Remove HTML comments
    text = text.replace(/<!--[\s\S]*?-->/g, '')

    // Convert common block elements to newlines
    text = text.replace(/<\/(p|div|h[1-6]|li|tr|br|hr)[^>]*>/gi, '\n')
    text = text.replace(/<(br|hr)\s*\/?>/gi, '\n')

    // Convert list items
    text = text.replace(/<li[^>]*>/gi, '• ')

    // Strip remaining HTML tags
    text = text.replace(/<[^>]+>/g, ' ')

    // Decode common HTML entities
    text = text
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
        .replace(/&#x([a-f0-9]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))

    // Collapse whitespace
    text = text.replace(/[ \t]+/g, ' ')
    text = text.replace(/\n\s*\n/g, '\n\n')
    text = text.trim()

    return text
}
