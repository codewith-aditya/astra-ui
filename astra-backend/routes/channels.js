const express = require('express')
const router = express.Router()
const auth = require('../middleware/auth')
const Channel = require('../models/Channel')
const ChannelMessage = require('../models/ChannelMessage')

// ─────────────────────────────────────────────────────────────────────────────
// TEAM MESSAGING CHANNELS — /api/channels
// Supports public & private channels with threaded messages + Socket.IO
// ─────────────────────────────────────────────────────────────────────────────

// ── GET /api/channels — List channels (public + user's private channels) ────
router.get('/api/channels', auth, async (req, res) => {
    try {
        const channels = await Channel.find({
            $or: [
                { type: 'public' },
                { type: 'private', members: req.userId },
                { type: 'direct', members: req.userId },
                { userId: req.userId },
            ]
        }).sort({ updatedAt: -1 })

        res.json({ channels })
    } catch (err) {
        console.error('[channels GET]', err.message)
        res.status(500).json({ error: 'Failed to fetch channels' })
    }
})

// ── POST /api/channels — Create channel ─────────────────────────────────────
router.post('/api/channels', auth, async (req, res) => {
    try {
        const { name, description, type } = req.body

        if (!name?.trim()) {
            return res.status(400).json({ error: 'Channel name is required' })
        }
        if (name.length > 100) {
            return res.status(400).json({ error: 'Channel name too long (max 100 chars)' })
        }
        if (description && description.length > 500) {
            return res.status(400).json({ error: 'Description too long (max 500 chars)' })
        }
        if (type && !['public', 'private', 'direct'].includes(type)) {
            return res.status(400).json({ error: 'Invalid channel type. Must be public, private, or direct' })
        }

        const channel = await Channel.create({
            userId: req.userId,
            name: name.trim(),
            description: (description || '').trim(),
            type: type || 'public',
            members: [req.userId],
        })

        res.json({ channel })
    } catch (err) {
        console.error('[channels POST]', err.message)
        res.status(500).json({ error: 'Failed to create channel' })
    }
})

// ── GET /api/channels/:id — Get channel by ID ───────────────────────────────
router.get('/api/channels/:id', auth, async (req, res) => {
    try {
        const channel = await Channel.findOne({ channelId: req.params.id })
        if (!channel) return res.status(404).json({ error: 'Channel not found' })

        // Check access: public channels are open; private/direct require membership
        if (channel.type !== 'public' && channel.userId !== req.userId && !channel.members.includes(req.userId)) {
            return res.status(403).json({ error: 'Forbidden' })
        }

        res.json({ channel })
    } catch (err) {
        console.error('[channels GET :id]', err.message)
        res.status(500).json({ error: 'Failed to fetch channel' })
    }
})

// ── PUT /api/channels/:id — Update channel (creator only) ───────────────────
router.put('/api/channels/:id', auth, async (req, res) => {
    try {
        const channel = await Channel.findOne({ channelId: req.params.id })
        if (!channel) return res.status(404).json({ error: 'Channel not found' })
        if (channel.userId !== req.userId) return res.status(403).json({ error: 'Forbidden — only the creator can update this channel' })

        const { name, description, type, members } = req.body
        const update = { updatedAt: new Date() }

        if (name !== undefined) {
            if (!name.trim()) return res.status(400).json({ error: 'Channel name cannot be empty' })
            if (name.length > 100) return res.status(400).json({ error: 'Channel name too long (max 100 chars)' })
            update.name = name.trim()
        }
        if (description !== undefined) {
            if (description.length > 500) return res.status(400).json({ error: 'Description too long (max 500 chars)' })
            update.description = description.trim()
        }
        if (type !== undefined) {
            if (!['public', 'private', 'direct'].includes(type)) {
                return res.status(400).json({ error: 'Invalid channel type' })
            }
            update.type = type
        }
        if (members !== undefined) {
            if (!Array.isArray(members)) return res.status(400).json({ error: 'members must be an array' })
            // Ensure creator is always a member
            const memberSet = new Set(members.map(m => String(m).trim()).filter(Boolean))
            memberSet.add(req.userId)
            update.members = [...memberSet]
        }

        const updated = await Channel.findOneAndUpdate(
            { channelId: req.params.id },
            update,
            { new: true }
        )

        res.json({ channel: updated })
    } catch (err) {
        console.error('[channels PUT]', err.message)
        res.status(500).json({ error: 'Failed to update channel' })
    }
})

// ── DELETE /api/channels/:id — Delete channel (creator only) ────────────────
router.delete('/api/channels/:id', auth, async (req, res) => {
    try {
        const channel = await Channel.findOne({ channelId: req.params.id })
        if (!channel) return res.status(404).json({ error: 'Channel not found' })
        if (channel.userId !== req.userId) return res.status(403).json({ error: 'Forbidden — only the creator can delete this channel' })

        // Delete all messages in this channel, then the channel itself
        await ChannelMessage.deleteMany({ channelId: req.params.id })
        await Channel.deleteOne({ channelId: req.params.id })

        console.log(`[channels DELETE] Channel "${channel.name}" deleted by ${req.userId.slice(0, 8)}`)

        res.json({ success: true, deleted: channel.channelId })
    } catch (err) {
        console.error('[channels DELETE]', err.message)
        res.status(500).json({ error: 'Failed to delete channel' })
    }
})

// ─────────────────────────────────────────────────────────────────────────────
// CHANNEL MESSAGES — /api/channels/:id/messages
// ─────────────────────────────────────────────────────────────────────────────

// ── GET /api/channels/:id/messages — Paginated messages ─────────────────────
router.get('/api/channels/:id/messages', auth, async (req, res) => {
    try {
        const channel = await Channel.findOne({ channelId: req.params.id })
        if (!channel) return res.status(404).json({ error: 'Channel not found' })

        // Check access
        if (channel.type !== 'public' && channel.userId !== req.userId && !channel.members.includes(req.userId)) {
            return res.status(403).json({ error: 'Forbidden' })
        }

        const page = Math.max(1, parseInt(req.query.page) || 1)
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50))
        const skip = (page - 1) * limit

        const [messages, total] = await Promise.all([
            ChannelMessage.find({ channelId: req.params.id })
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit),
            ChannelMessage.countDocuments({ channelId: req.params.id }),
        ])

        res.json({
            messages,
            pagination: {
                page,
                limit,
                total,
                pages: Math.ceil(total / limit),
            },
        })
    } catch (err) {
        console.error('[channel messages GET]', err.message)
        res.status(500).json({ error: 'Failed to fetch messages' })
    }
})

// ── POST /api/channels/:id/messages — Send message + Socket.IO emit ────────
router.post('/api/channels/:id/messages', auth, async (req, res) => {
    try {
        const channelId = req.params.id

        const channel = await Channel.findOne({ channelId })
        if (!channel) return res.status(404).json({ error: 'Channel not found' })

        // Check access
        if (channel.type !== 'public' && channel.userId !== req.userId && !channel.members.includes(req.userId)) {
            return res.status(403).json({ error: 'Forbidden' })
        }

        const { content, parentId } = req.body

        if (!content?.trim()) {
            return res.status(400).json({ error: 'Message content is required' })
        }
        if (content.length > 5000) {
            return res.status(400).json({ error: 'Message too long (max 5000 chars)' })
        }
        if (parentId) {
            // Validate parent message exists in the same channel
            const parent = await ChannelMessage.findOne({ messageId: parentId, channelId })
            if (!parent) {
                return res.status(400).json({ error: 'Parent message not found in this channel' })
            }
        }

        const message = await ChannelMessage.create({
            channelId,
            userId: req.userId,
            content: content.trim(),
            parentId: parentId || null,
        })

        // Update channel timestamp
        await Channel.findOneAndUpdate({ channelId }, { updatedAt: new Date() })

        // Emit Socket.IO event to channel room
        const io = req.app.get('io')
        if (io) {
            io.to('channel:' + channelId).emit('channel:message', {
                messageId: message.messageId,
                channelId: message.channelId,
                userId: message.userId,
                content: message.content,
                parentId: message.parentId,
                createdAt: message.createdAt,
            })
        }

        res.json({ message })
    } catch (err) {
        console.error('[channel messages POST]', err.message)
        res.status(500).json({ error: 'Failed to send message' })
    }
})

// ── DELETE /api/channels/:id/messages/:msgId — Delete message (author only) ─
router.delete('/api/channels/:id/messages/:msgId', auth, async (req, res) => {
    try {
        const message = await ChannelMessage.findOne({
            messageId: req.params.msgId,
            channelId: req.params.id,
        })
        if (!message) return res.status(404).json({ error: 'Message not found' })
        if (message.userId !== req.userId) return res.status(403).json({ error: 'Forbidden — only the author can delete this message' })

        await ChannelMessage.deleteOne({ messageId: req.params.msgId })

        res.json({ success: true, deleted: req.params.msgId })
    } catch (err) {
        console.error('[channel messages DELETE]', err.message)
        res.status(500).json({ error: 'Failed to delete message' })
    }
})

module.exports = router
