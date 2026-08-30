const express = require('express')
const router = express.Router()
const auth = require('../middleware/auth')
const Folder = require('../models/Folder')
const Chat = require('../models/Chat')

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/folders — List user's folders (build tree structure)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/api/folders', auth, async (req, res) => {
    try {
        const folders = await Folder.find({ userId: req.userId }).sort({ name: 1 })

        // Build tree: group children under their parent
        const folderMap = new Map()
        const roots = []

        // First pass: index all folders by folderId
        for (const f of folders) {
            folderMap.set(f.folderId, {
                _id: f._id,
                folderId: f.folderId,
                name: f.name,
                parentId: f.parentId,
                isExpanded: f.isExpanded,
                meta: f.meta,
                createdAt: f.createdAt,
                updatedAt: f.updatedAt,
                children: [],
            })
        }

        // Second pass: attach children to parents
        for (const f of folders) {
            const node = folderMap.get(f.folderId)
            if (f.parentId && folderMap.has(f.parentId)) {
                folderMap.get(f.parentId).children.push(node)
            } else {
                roots.push(node)
            }
        }

        res.json({ folders: roots })
    } catch (err) {
        console.error('[folders GET]', err.message)
        res.status(500).json({ error: 'Failed to fetch folders' })
    }
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/folders — Create a new folder
// ─────────────────────────────────────────────────────────────────────────────
router.post('/api/folders', auth, async (req, res) => {
    try {
        const { name, parentId } = req.body
        if (!name?.trim()) {
            return res.status(400).json({ error: 'Folder name is required' })
        }
        if (name.length > 100) {
            return res.status(400).json({ error: 'Folder name too long (max 100 chars)' })
        }

        // Limit total folders per user
        const count = await Folder.countDocuments({ userId: req.userId })
        if (count >= 100) {
            return res.status(400).json({ error: 'Maximum 100 folders allowed' })
        }

        // If parentId provided, verify it belongs to this user
        if (parentId) {
            const parent = await Folder.findOne({ folderId: parentId, userId: req.userId })
            if (!parent) {
                return res.status(404).json({ error: 'Parent folder not found' })
            }
        }

        const folder = await Folder.create({
            userId: req.userId,
            name: name.trim(),
            parentId: parentId || null,
        })

        res.json({
            folder: {
                _id: folder._id,
                folderId: folder.folderId,
                name: folder.name,
                parentId: folder.parentId,
                isExpanded: folder.isExpanded,
                createdAt: folder.createdAt,
                updatedAt: folder.updatedAt,
                children: [],
            },
        })
    } catch (err) {
        console.error('[folders POST]', err.message)
        res.status(500).json({ error: 'Failed to create folder' })
    }
})

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/folders/:id — Rename a folder
// ─────────────────────────────────────────────────────────────────────────────
router.put('/api/folders/:id', auth, async (req, res) => {
    try {
        const { name } = req.body
        if (!name?.trim()) {
            return res.status(400).json({ error: 'Folder name is required' })
        }
        if (name.length > 100) {
            return res.status(400).json({ error: 'Folder name too long (max 100 chars)' })
        }

        const folder = await Folder.findOne({ folderId: req.params.id, userId: req.userId })
        if (!folder) {
            return res.status(404).json({ error: 'Folder not found' })
        }

        const updated = await Folder.findOneAndUpdate(
            { folderId: req.params.id, userId: req.userId },
            { $set: { name: name.trim(), updatedAt: new Date() } },
            { new: true }
        )

        res.json({
            success: true,
            folder: {
                _id: updated._id,
                folderId: updated.folderId,
                name: updated.name,
                parentId: updated.parentId,
                isExpanded: updated.isExpanded,
                updatedAt: updated.updatedAt,
            },
        })
    } catch (err) {
        console.error('[folders PUT]', err.message)
        res.status(500).json({ error: 'Failed to rename folder' })
    }
})

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/folders/:id — Delete a folder (moves chats out, deletes subfolders)
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/api/folders/:id', auth, async (req, res) => {
    try {
        const folder = await Folder.findOne({ folderId: req.params.id, userId: req.userId })
        if (!folder) {
            return res.status(404).json({ error: 'Folder not found' })
        }

        // Collect all descendant folder IDs (recursive)
        const allFolderIds = [folder.folderId]
        async function collectChildren(parentFolderId) {
            const children = await Folder.find({ parentId: parentFolderId, userId: req.userId })
            for (const child of children) {
                allFolderIds.push(child.folderId)
                await collectChildren(child.folderId)
            }
        }
        await collectChildren(folder.folderId)

        // Unset folderId on all chats in this folder and its subfolders
        await Chat.updateMany(
            { userId: req.userId, folderId: { $in: allFolderIds } },
            { $unset: { folderId: '' } }
        )

        // Delete this folder and all descendant folders
        const result = await Folder.deleteMany({
            folderId: { $in: allFolderIds },
            userId: req.userId,
        })

        res.json({ success: true, deleted: result.deletedCount })
    } catch (err) {
        console.error('[folders DELETE]', err.message)
        res.status(500).json({ error: 'Failed to delete folder' })
    }
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/folders/:id/chats — Move a chat into a folder
// ─────────────────────────────────────────────────────────────────────────────
router.post('/api/folders/:id/chats', auth, async (req, res) => {
    try {
        const { chatId } = req.body
        if (!chatId) {
            return res.status(400).json({ error: 'chatId is required' })
        }

        // Verify folder belongs to this user
        const folder = await Folder.findOne({ folderId: req.params.id, userId: req.userId })
        if (!folder) {
            return res.status(404).json({ error: 'Folder not found' })
        }

        // Verify chat belongs to this user
        const chat = await Chat.findOne({ chatId, userId: req.userId })
        if (!chat) {
            return res.status(404).json({ error: 'Chat not found' })
        }

        // Set folderId on the chat (schema may not have it, so use $set)
        await Chat.findOneAndUpdate(
            { chatId, userId: req.userId },
            { $set: { folderId: req.params.id } }
        )

        res.json({ success: true, chatId, folderId: req.params.id })
    } catch (err) {
        console.error('[folders/chats POST]', err.message)
        res.status(500).json({ error: 'Failed to move chat to folder' })
    }
})

module.exports = router
