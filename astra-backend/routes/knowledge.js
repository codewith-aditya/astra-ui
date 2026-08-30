const express = require('express')
const router = express.Router()
const auth = require('../middleware/auth')
const Knowledge = require('../models/Knowledge')
const KnowledgeFile = require('../models/KnowledgeFile')
const File = require('../models/File')

// ─── GET /api/knowledge — List user's knowledge bases ────────────────────────
router.get('/api/knowledge', auth, async (req, res) => {
    try {
        const knowledgeBases = await Knowledge.find({ userId: req.userId })
            .sort({ updatedAt: -1 })
        res.json({ success: true, data: knowledgeBases })
    } catch (err) {
        console.error('[knowledge GET]', err.message)
        res.status(500).json({ error: 'Failed to fetch knowledge bases' })
    }
})

// ─── POST /api/knowledge — Create a new knowledge base ──────────────────────
router.post('/api/knowledge', auth, async (req, res) => {
    try {
        const { name, description } = req.body
        if (!name?.trim()) {
            return res.status(400).json({ error: 'name is required' })
        }
        const kb = await Knowledge.create({
            userId: req.userId,
            name: name.trim(),
            description: description?.trim() || '',
        })
        res.status(201).json({ success: true, data: kb })
    } catch (err) {
        console.error('[knowledge POST]', err.message)
        res.status(500).json({ error: 'Failed to create knowledge base' })
    }
})

// ─── GET /api/knowledge/:id — Get single knowledge base ─────────────────────
router.get('/api/knowledge/:id', auth, async (req, res) => {
    try {
        const kb = await Knowledge.findOne({
            knowledgeId: req.params.id,
            userId: req.userId,
        })
        if (!kb) return res.status(404).json({ error: 'Knowledge base not found' })
        res.json({ success: true, data: kb })
    } catch (err) {
        console.error('[knowledge GET :id]', err.message)
        res.status(500).json({ error: 'Failed to fetch knowledge base' })
    }
})

// ─── PUT /api/knowledge/:id — Update knowledge base ─────────────────────────
router.put('/api/knowledge/:id', auth, async (req, res) => {
    try {
        const { name, description } = req.body
        const kb = await Knowledge.findOne({
            knowledgeId: req.params.id,
            userId: req.userId,
        })
        if (!kb) return res.status(404).json({ error: 'Knowledge base not found' })

        if (name !== undefined) {
            if (!name.trim()) return res.status(400).json({ error: 'name cannot be empty' })
            kb.name = name.trim()
        }
        if (description !== undefined) {
            kb.description = description.trim()
        }
        await kb.save()
        res.json({ success: true, data: kb })
    } catch (err) {
        console.error('[knowledge PUT]', err.message)
        res.status(500).json({ error: 'Failed to update knowledge base' })
    }
})

// ─── DELETE /api/knowledge/:id — Delete KB + associated KnowledgeFile records ─
router.delete('/api/knowledge/:id', auth, async (req, res) => {
    try {
        const kb = await Knowledge.findOne({
            knowledgeId: req.params.id,
            userId: req.userId,
        })
        if (!kb) return res.status(404).json({ error: 'Knowledge base not found' })

        // Remove all associated KnowledgeFile records
        await KnowledgeFile.deleteMany({ knowledgeId: kb.knowledgeId })
        await kb.deleteOne()

        res.json({ success: true, data: { deleted: true } })
    } catch (err) {
        console.error('[knowledge DELETE]', err.message)
        res.status(500).json({ error: 'Failed to delete knowledge base' })
    }
})

// ─── POST /api/knowledge/:id/files — Add file to KB ─────────────────────────
router.post('/api/knowledge/:id/files', auth, async (req, res) => {
    try {
        const { fileId } = req.body
        if (!fileId) return res.status(400).json({ error: 'fileId is required' })

        const kb = await Knowledge.findOne({
            knowledgeId: req.params.id,
            userId: req.userId,
        })
        if (!kb) return res.status(404).json({ error: 'Knowledge base not found' })

        // Verify the file exists and belongs to this user
        const file = await File.findOne({ fileId, userId: req.userId })
        if (!file) return res.status(404).json({ error: 'File not found' })

        // Check for duplicate
        const existing = await KnowledgeFile.findOne({
            knowledgeId: kb.knowledgeId,
            fileId,
        })
        if (existing) {
            return res.status(409).json({ error: 'File already exists in this knowledge base' })
        }

        // Create the KnowledgeFile record
        const kf = await KnowledgeFile.create({
            knowledgeId: kb.knowledgeId,
            fileId,
            userId: req.userId,
        })

        // Increment fileCount
        kb.fileCount += 1
        await kb.save()

        res.status(201).json({ success: true, data: kf })
    } catch (err) {
        console.error('[knowledge POST files]', err.message)
        res.status(500).json({ error: 'Failed to add file to knowledge base' })
    }
})

// ─── DELETE /api/knowledge/:id/files/:fileId — Remove file from KB ───────────
router.delete('/api/knowledge/:id/files/:fileId', auth, async (req, res) => {
    try {
        const kb = await Knowledge.findOne({
            knowledgeId: req.params.id,
            userId: req.userId,
        })
        if (!kb) return res.status(404).json({ error: 'Knowledge base not found' })

        const kf = await KnowledgeFile.findOne({
            knowledgeId: kb.knowledgeId,
            fileId: req.params.fileId,
        })
        if (!kf) return res.status(404).json({ error: 'File not found in this knowledge base' })

        await kf.deleteOne()

        // Decrement fileCount (floor at 0)
        kb.fileCount = Math.max(0, kb.fileCount - 1)
        await kb.save()

        res.json({ success: true, data: { removed: true } })
    } catch (err) {
        console.error('[knowledge DELETE file]', err.message)
        res.status(500).json({ error: 'Failed to remove file from knowledge base' })
    }
})

// ─── GET /api/knowledge/:id/files — List files in KB (joined with File) ──────
router.get('/api/knowledge/:id/files', auth, async (req, res) => {
    try {
        const kb = await Knowledge.findOne({
            knowledgeId: req.params.id,
            userId: req.userId,
        })
        if (!kb) return res.status(404).json({ error: 'Knowledge base not found' })

        // Get all KnowledgeFile records for this KB
        const knowledgeFiles = await KnowledgeFile.find({ knowledgeId: kb.knowledgeId })
            .sort({ createdAt: -1 })

        // Extract fileIds and fetch the corresponding File documents
        const fileIds = knowledgeFiles.map(kf => kf.fileId)
        const files = await File.find({ fileId: { $in: fileIds } })

        // Build a lookup map for quick access
        const fileMap = {}
        for (const f of files) {
            fileMap[f.fileId] = f
        }

        // Merge KnowledgeFile metadata with File data
        const result = knowledgeFiles.map(kf => ({
            id: kf.id,
            knowledgeId: kf.knowledgeId,
            fileId: kf.fileId,
            addedAt: kf.createdAt,
            file: fileMap[kf.fileId] || null,
        }))

        res.json({ success: true, data: result })
    } catch (err) {
        console.error('[knowledge GET files]', err.message)
        res.status(500).json({ error: 'Failed to fetch files' })
    }
})

// ─── POST /api/knowledge/:id/reset — Remove all files, reset fileCount ───────
router.post('/api/knowledge/:id/reset', auth, async (req, res) => {
    try {
        const kb = await Knowledge.findOne({
            knowledgeId: req.params.id,
            userId: req.userId,
        })
        if (!kb) return res.status(404).json({ error: 'Knowledge base not found' })

        const result = await KnowledgeFile.deleteMany({ knowledgeId: kb.knowledgeId })

        kb.fileCount = 0
        await kb.save()

        res.json({ success: true, data: { filesRemoved: result.deletedCount } })
    } catch (err) {
        console.error('[knowledge POST reset]', err.message)
        res.status(500).json({ error: 'Failed to reset knowledge base' })
    }
})

module.exports = router
