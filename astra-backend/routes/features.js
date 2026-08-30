const express = require('express')
const router = express.Router()
const auth = require('../middleware/auth')
const ApiKey = require('../models/ApiKey')
const Message = require('../models/Message')
const Chat = require('../models/Chat')
const User = require('../models/User')
const Prompt = require('../models/Prompt')
const Note = require('../models/Note')
const Banner = require('../models/Banner')
const { getTodayKey } = require('../utils/dateKeys')

// ─────────────────────────────────────────────────────────────────────────────
// 1. API KEYS — /api/keys
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/keys', auth, async (req, res) => {
    try {
        const keys = await ApiKey.find({ userId: req.userId, isActive: true })
            .sort({ createdAt: -1 })
            .select('-key')
        res.json({ keys })
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch API keys' })
    }
})

router.post('/api/keys', auth, async (req, res) => {
    try {
        const { name } = req.body
        if (!name?.trim()) return res.status(400).json({ error: 'Key name is required' })
        if (name.length > 64) return res.status(400).json({ error: 'Name too long (max 64 chars)' })

        const count = await ApiKey.countDocuments({ userId: req.userId, isActive: true })
        if (count >= 10) return res.status(400).json({ error: 'Maximum 10 API keys allowed' })

        const key = ApiKey.generateKey()
        const keyPreview = key.slice(0, 14) + '••••••••'

        const apiKey = await ApiKey.create({ userId: req.userId, name: name.trim(), key, keyPreview })

        res.json({
            key: apiKey.key,
            keyPreview: apiKey.keyPreview,
            name: apiKey.name,
            id: apiKey._id,
            createdAt: apiKey.createdAt,
            warning: 'Copy this key now — it will not be shown again',
        })
    } catch (err) {
        res.status(500).json({ error: 'Failed to generate API key' })
    }
})

router.delete('/api/keys/:keyId', auth, async (req, res) => {
    try {
        const apiKey = await ApiKey.findOne({ _id: req.params.keyId, userId: req.userId })
        if (!apiKey) return res.status(404).json({ error: 'Key not found' })
        await ApiKey.findByIdAndUpdate(req.params.keyId, { isActive: false })
        res.json({ success: true })
    } catch (err) {
        res.status(500).json({ error: 'Failed to revoke API key' })
    }
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. MESSAGE REACTIONS — /api/messages/:messageId/reaction
// ─────────────────────────────────────────────────────────────────────────────

router.post('/api/messages/:messageId/reaction', auth, async (req, res) => {
    try {
        const { reaction } = req.body
        if (reaction !== null && !['like', 'dislike'].includes(reaction)) {
            return res.status(400).json({ error: "reaction must be 'like', 'dislike', or null" })
        }
        const message = await Message.findById(req.params.messageId)
        if (!message) return res.status(404).json({ error: 'Message not found' })
        const chat = await Chat.findOne({ chatId: message.chatId, userId: req.userId })
        if (!chat) return res.status(403).json({ error: 'Forbidden' })
        await Message.findByIdAndUpdate(req.params.messageId, { reaction })
        res.json({ success: true, reaction })
    } catch (err) {
        res.status(500).json({ error: 'Failed to save reaction' })
    }
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. USAGE ANALYTICS — /api/analytics/:userId
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/analytics/:userId', auth, async (req, res) => {
    try {
        if (req.userId !== req.params.userId) return res.status(403).json({ error: 'Forbidden' })
        const userId = req.params.userId
        const totalChats = await Chat.countDocuments({ userId })
        const userChats = await Chat.find({ userId }).select('chatId')
        const chatIds = userChats.map(c => c.chatId)
        const totalMessages = await Message.countDocuments({ chatId: { $in: chatIds }, role: 'user' })
        const totalAiMessages = await Message.countDocuments({ chatId: { $in: chatIds }, role: 'assistant' })
        const likes    = await Message.countDocuments({ chatId: { $in: chatIds }, reaction: 'like' })
        const dislikes = await Message.countDocuments({ chatId: { $in: chatIds }, reaction: 'dislike' })
        const weeklyActivity = []
        for (let i = 6; i >= 0; i--) {
            const dayStart = new Date(); dayStart.setHours(0,0,0,0); dayStart.setDate(dayStart.getDate() - i)
            const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1)
            const count = await Message.countDocuments({ chatId: { $in: chatIds }, role: 'user', createdAt: { $gte: dayStart, $lt: dayEnd } })
            const day = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dayStart.getDay()]
            weeklyActivity.push({ day, count })
        }
        const user = await User.findOne({ userId })
        const todayKey = getTodayKey()
        const dailyUsage = user?.dailyUsageDate === todayKey ? (user?.dailyUsage || 0) : 0
        res.json({ totalChats, totalMessages, totalAiMessages, reactions: { likes, dislikes }, weeklyActivity, plan: user?.getActivePlan() || 'free', dailyUsageToday: dailyUsage })
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch analytics' })
    }
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. CHAT EXPORT — /api/chats/:chatId/export
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/chats/:chatId/export', auth, async (req, res) => {
    try {
        const chat = await Chat.findOne({ chatId: req.params.chatId, userId: req.userId })
        if (!chat) return res.status(404).json({ error: 'Chat not found' })
        const messages = await Message.find({ chatId: req.params.chatId }).sort({ createdAt: 1 })
        if (messages.length === 0) return res.status(400).json({ error: 'No messages to export' })
        const lines = [`# ${chat.title || 'AstraGPT Conversation'}`, `**Exported:** ${new Date().toLocaleString()}`, `**Model:** ${chat.model || 'AstraGPT'}`, '', '---', '']
        for (const msg of messages) {
            if (msg.role === 'system') continue
            lines.push(`### ${msg.role === 'user' ? '**You**' : '**AstraGPT**'}`)
            lines.push(msg.content)
            lines.push('')
        }
        const filename = `astragpt-${chat.title?.replace(/[^a-z0-9]/gi, '-').toLowerCase() || 'chat'}.md`
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
        res.send(lines.join('\n'))
    } catch (err) {
        res.status(500).json({ error: 'Failed to export chat' })
    }
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. SYSTEM PROMPT PER CHAT
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/chats/:chatId/system-prompt', auth, async (req, res) => {
    try {
        const chat = await Chat.findOne({ chatId: req.params.chatId, userId: req.userId }).select('systemPrompt title')
        if (!chat) return res.status(404).json({ error: 'Chat not found' })
        res.json({ systemPrompt: chat.systemPrompt || '' })
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch system prompt' })
    }
})

router.post('/api/chats/:chatId/system-prompt', auth, async (req, res) => {
    try {
        const { systemPrompt = '' } = req.body
        if (systemPrompt.length > 2000) return res.status(400).json({ error: 'System prompt too long (max 2000 chars)' })
        const chat = await Chat.findOne({ chatId: req.params.chatId, userId: req.userId })
        if (!chat) return res.status(404).json({ error: 'Chat not found' })
        await Chat.findOneAndUpdate({ chatId: req.params.chatId }, { systemPrompt: systemPrompt.trim() })
        res.json({ success: true, systemPrompt: systemPrompt.trim() })
    } catch (err) {
        res.status(500).json({ error: 'Failed to update system prompt' })
    }
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. CHAT PIN / UNPIN — /api/chats/:chatId/pin
// ─────────────────────────────────────────────────────────────────────────────

router.post('/api/chats/:chatId/pin', auth, async (req, res) => {
    try {
        const { pinned } = req.body  // true | false
        const chat = await Chat.findOne({ chatId: req.params.chatId, userId: req.userId })
        if (!chat) return res.status(404).json({ error: 'Chat not found' })
        await Chat.findOneAndUpdate({ chatId: req.params.chatId }, { isPinned: !!pinned })
        res.json({ success: true, isPinned: !!pinned })
    } catch (err) {
        res.status(500).json({ error: 'Failed to pin/unpin chat' })
    }
})

// ─────────────────────────────────────────────────────────────────────────────
// 7. CHAT ARCHIVE / UNARCHIVE — /api/chats/:chatId/archive
// ─────────────────────────────────────────────────────────────────────────────

router.post('/api/chats/:chatId/archive', auth, async (req, res) => {
    try {
        const { archived } = req.body  // true | false
        const chat = await Chat.findOne({ chatId: req.params.chatId, userId: req.userId })
        if (!chat) return res.status(404).json({ error: 'Chat not found' })
        await Chat.findOneAndUpdate({ chatId: req.params.chatId }, { isArchived: !!archived })
        res.json({ success: true, isArchived: !!archived })
    } catch (err) {
        res.status(500).json({ error: 'Failed to archive/unarchive chat' })
    }
})

// GET /api/chats/archived — list all archived chats for user
router.get('/api/chats/archived', auth, async (req, res) => {
    try {
        const chats = await Chat.find({ userId: req.userId, isArchived: true }).sort({ createdAt: -1 }).select('-systemPrompt')
        res.json({ chats })
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch archived chats' })
    }
})

// ─────────────────────────────────────────────────────────────────────────────
// 8. CHAT TAGS — /api/chats/:chatId/tags
// ─────────────────────────────────────────────────────────────────────────────

router.post('/api/chats/:chatId/tags', auth, async (req, res) => {
    try {
        const { tags } = req.body  // array of strings
        if (!Array.isArray(tags)) return res.status(400).json({ error: 'tags must be an array' })
        const sanitized = tags.slice(0, 10).map(t => String(t).trim().toLowerCase().slice(0, 30)).filter(Boolean)
        const chat = await Chat.findOne({ chatId: req.params.chatId, userId: req.userId })
        if (!chat) return res.status(404).json({ error: 'Chat not found' })
        await Chat.findOneAndUpdate({ chatId: req.params.chatId }, { tags: sanitized })
        res.json({ success: true, tags: sanitized })
    } catch (err) {
        res.status(500).json({ error: 'Failed to update tags' })
    }
})

// GET /api/tags — all unique tags used by this user
router.get('/api/tags', auth, async (req, res) => {
    try {
        const chats = await Chat.find({ userId: req.userId }).select('tags')
        const allTags = [...new Set(chats.flatMap(c => c.tags || []))].sort()
        res.json({ tags: allTags })
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch tags' })
    }
})

// ─────────────────────────────────────────────────────────────────────────────
// 9. CHAT IMPORT — /api/chats/import
// ─────────────────────────────────────────────────────────────────────────────

router.post('/api/chats/import', auth, async (req, res) => {
    try {
        const { chats } = req.body  // array of { title, model, messages: [{role, content}] }
        if (!Array.isArray(chats) || chats.length === 0) return res.status(400).json({ error: 'chats array required' })
        if (chats.length > 50) return res.status(400).json({ error: 'Max 50 chats per import' })

        const { v4: uuidv4 } = require('uuid')
        const imported = []

        for (const c of chats) {
            const chatId = uuidv4()
            await Chat.create({ chatId, userId: req.userId, title: c.title || 'Imported Chat', model: c.model || 'claude-sonnet-4-6' })
            if (Array.isArray(c.messages)) {
                const msgs = c.messages.slice(0, 500).map(m => ({ chatId, role: m.role, content: m.content || '' }))
                await Message.insertMany(msgs)
            }
            imported.push(chatId)
        }

        res.json({ success: true, imported: imported.length, chatIds: imported })
    } catch (err) {
        console.error('[import]', err.message)
        res.status(500).json({ error: 'Failed to import chats' })
    }
})

// ─────────────────────────────────────────────────────────────────────────────
// 10. PROMPT LIBRARY — /api/prompts
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/prompts', auth, async (req, res) => {
    try {
        const prompts = await Prompt.find({ userId: req.userId }).sort({ createdAt: -1 })
        res.json({ prompts })
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch prompts' })
    }
})

router.post('/api/prompts', auth, async (req, res) => {
    try {
        const { title, content, tags } = req.body
        if (!title?.trim()) return res.status(400).json({ error: 'Title is required' })
        if (!content?.trim()) return res.status(400).json({ error: 'Content is required' })
        const count = await Prompt.countDocuments({ userId: req.userId })
        if (count >= 200) return res.status(400).json({ error: 'Maximum 200 prompts allowed' })
        const prompt = await Prompt.create({
            userId: req.userId,
            title: title.trim().slice(0, 100),
            content: content.trim().slice(0, 4000),
            tags: Array.isArray(tags) ? tags.slice(0, 5).map(t => t.trim().toLowerCase()) : []
        })
        res.json({ prompt })
    } catch (err) {
        res.status(500).json({ error: 'Failed to create prompt' })
    }
})

router.put('/api/prompts/:promptId', auth, async (req, res) => {
    try {
        const { title, content, tags } = req.body
        const prompt = await Prompt.findOne({ _id: req.params.promptId, userId: req.userId })
        if (!prompt) return res.status(404).json({ error: 'Prompt not found' })
        const update = { updatedAt: new Date() }
        if (title) update.title = title.trim().slice(0, 100)
        if (content) update.content = content.trim().slice(0, 4000)
        if (tags) update.tags = tags.slice(0, 5).map(t => t.trim().toLowerCase())
        const updated = await Prompt.findByIdAndUpdate(req.params.promptId, update, { new: true })
        res.json({ prompt: updated })
    } catch (err) {
        res.status(500).json({ error: 'Failed to update prompt' })
    }
})

router.delete('/api/prompts/:promptId', auth, async (req, res) => {
    try {
        const prompt = await Prompt.findOne({ _id: req.params.promptId, userId: req.userId })
        if (!prompt) return res.status(404).json({ error: 'Prompt not found' })
        await Prompt.findByIdAndDelete(req.params.promptId)
        res.json({ success: true })
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete prompt' })
    }
})

// POST /api/prompts/:promptId/use — increment usage count
router.post('/api/prompts/:promptId/use', auth, async (req, res) => {
    try {
        await Prompt.findOneAndUpdate({ _id: req.params.promptId, userId: req.userId }, { $inc: { usageCount: 1 } })
        res.json({ success: true })
    } catch (err) {
        res.status(500).json({ error: 'Failed to track usage' })
    }
})

// ─────────────────────────────────────────────────────────────────────────────
// 11. NOTES — /api/notes
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/notes', auth, async (req, res) => {
    try {
        const notes = await Note.find({ userId: req.userId }).sort({ pinned: -1, updatedAt: -1 })
        res.json({ notes })
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch notes' })
    }
})

router.post('/api/notes', auth, async (req, res) => {
    try {
        const { title, content, color } = req.body
        const count = await Note.countDocuments({ userId: req.userId })
        if (count >= 500) return res.status(400).json({ error: 'Maximum 500 notes allowed' })
        const note = await Note.create({
            userId: req.userId,
            title: (title || 'Untitled Note').slice(0, 200),
            content: (content || '').slice(0, 50000),
            color: color || ''
        })
        res.json({ note })
    } catch (err) {
        res.status(500).json({ error: 'Failed to create note' })
    }
})

router.put('/api/notes/:noteId', auth, async (req, res) => {
    try {
        const note = await Note.findOne({ _id: req.params.noteId, userId: req.userId })
        if (!note) return res.status(404).json({ error: 'Note not found' })
        const { title, content, pinned, color } = req.body
        const update = { updatedAt: new Date() }
        if (title !== undefined) update.title = title.slice(0, 200)
        if (content !== undefined) update.content = content.slice(0, 50000)
        if (pinned !== undefined) update.pinned = !!pinned
        if (color !== undefined) update.color = color
        const updated = await Note.findByIdAndUpdate(req.params.noteId, update, { new: true })
        res.json({ note: updated })
    } catch (err) {
        res.status(500).json({ error: 'Failed to update note' })
    }
})

router.delete('/api/notes/:noteId', auth, async (req, res) => {
    try {
        const note = await Note.findOne({ _id: req.params.noteId, userId: req.userId })
        if (!note) return res.status(404).json({ error: 'Note not found' })
        await Note.findByIdAndDelete(req.params.noteId)
        res.json({ success: true })
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete note' })
    }
})

// ─────────────────────────────────────────────────────────────────────────────
// 12. BANNERS — /api/banners (public read, admin write)
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/banners — public, returns active non-expired banners
router.get('/api/banners', async (req, res) => {
    try {
        const now = new Date()
        const banners = await Banner.find({
            isActive: true,
            $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }]
        }).sort({ createdAt: -1 }).limit(3)
        res.json({ banners })
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch banners' })
    }
})

// POST /api/banners — admin only
router.post('/api/banners', async (req, res) => {
    try {
        const secret = process.env.ADMIN_SECRET
        if (!secret || req.headers['x-admin-secret'] !== secret) return res.status(403).json({ error: 'Forbidden' })
        const { message, type, link, linkText, dismissible, expiresAt } = req.body
        if (!message?.trim()) return res.status(400).json({ error: 'message is required' })
        const banner = await Banner.create({ message: message.trim(), type, link, linkText, dismissible, expiresAt: expiresAt || null })
        res.json({ banner })
    } catch (err) {
        res.status(500).json({ error: 'Failed to create banner' })
    }
})

// DELETE /api/banners/:bannerId — admin only
router.delete('/api/banners/:bannerId', async (req, res) => {
    try {
        const secret = process.env.ADMIN_SECRET
        if (!secret || req.headers['x-admin-secret'] !== secret) return res.status(403).json({ error: 'Forbidden' })
        await Banner.findByIdAndUpdate(req.params.bannerId, { isActive: false })
        res.json({ success: true })
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete banner' })
    }
})

// ─────────────────────────────────────────────────────────────────────────────
// 13. CONFIG EXPORT / IMPORT — /api/config
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/config/export — export all user data (settings + prompts + notes + memories)
router.get('/api/config/export', auth, async (req, res) => {
    try {
        const Memory = require('../models/Memory')
        const [prompts, notes] = await Promise.all([
            Prompt.find({ userId: req.userId }),
            Note.find({ userId: req.userId }),
        ])
        const payload = {
            version: '1.0',
            exportedAt: new Date().toISOString(),
            userId: req.userId,
            prompts,
            notes,
        }
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Content-Disposition', `attachment; filename="astragpt-config-${Date.now()}.json"`)
        res.send(JSON.stringify(payload, null, 2))
    } catch (err) {
        res.status(500).json({ error: 'Failed to export config' })
    }
})

// POST /api/config/import — import prompts + notes from exported JSON
router.post('/api/config/import', auth, async (req, res) => {
    try {
        const { prompts = [], notes = [] } = req.body
        let importedPrompts = 0, importedNotes = 0

        for (const p of prompts.slice(0, 200)) {
            if (!p.title || !p.content) continue
            await Prompt.create({ userId: req.userId, title: p.title.slice(0, 100), content: p.content.slice(0, 4000), tags: p.tags || [] })
            importedPrompts++
        }
        for (const n of notes.slice(0, 500)) {
            await Note.create({ userId: req.userId, title: (n.title || 'Note').slice(0, 200), content: (n.content || '').slice(0, 50000), color: n.color || '' })
            importedNotes++
        }

        res.json({ success: true, importedPrompts, importedNotes })
    } catch (err) {
        res.status(500).json({ error: 'Failed to import config' })
    }
})

module.exports = router
