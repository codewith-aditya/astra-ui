const express = require('express')
const router = express.Router()
const auth = require('../middleware/auth')
const Group = require('../models/Group')
const AccessGrant = require('../models/AccessGrant')

// ─── All routes require authentication ──────────────────────────────────────────
router.use(auth)

// ─── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Check if userId is the group owner.
 */
function isOwner(group, userId) {
    return group.userId === userId
}

/**
 * Check if userId is a member (or owner) of the group.
 */
function isMemberOrOwner(group, userId) {
    return group.userId === userId || group.members.includes(userId)
}

// ─── GET /api/groups — List groups (user is owner or member) ────────────────────
router.get('/', async (req, res) => {
    try {
        const groups = await Group.find({
            $or: [
                { userId: req.userId },
                { members: req.userId },
            ],
        }).sort({ updatedAt: -1 })

        return res.json({
            success: true,
            groups: groups.map(g => ({
                groupId:     g.groupId,
                name:        g.name,
                description: g.description,
                owner:       g.userId,
                memberCount: g.members.length,
                isOwner:     g.userId === req.userId,
                createdAt:   g.createdAt,
                updatedAt:   g.updatedAt,
            })),
        })
    } catch (err) {
        console.error('[Groups] list error:', err)
        return res.status(500).json({
            success: false,
            error: { message: 'Failed to list groups', code: 'server_error' },
        })
    }
})

// ─── POST /api/groups — Create group ────────────────────────────────────────────
router.post('/', async (req, res) => {
    try {
        const { name, description } = req.body

        if (!name || typeof name !== 'string' || !name.trim()) {
            return res.status(400).json({
                success: false,
                error: { message: 'Group name is required', code: 'invalid_input' },
            })
        }

        if (name.trim().length > 100) {
            return res.status(400).json({
                success: false,
                error: { message: 'Group name must be 100 characters or fewer', code: 'invalid_input' },
            })
        }

        const group = new Group({
            userId:      req.userId,
            name:        name.trim(),
            description: (description || '').trim().slice(0, 500),
            members:     [],
        })

        await group.save()

        return res.status(201).json({
            success: true,
            group: {
                groupId:     group.groupId,
                name:        group.name,
                description: group.description,
                owner:       group.userId,
                members:     group.members,
                permissions: group.permissions,
                createdAt:   group.createdAt,
                updatedAt:   group.updatedAt,
            },
        })
    } catch (err) {
        console.error('[Groups] create error:', err)
        return res.status(500).json({
            success: false,
            error: { message: 'Failed to create group', code: 'server_error' },
        })
    }
})

// ─── GET /api/groups/:id — Get group by groupId ─────────────────────────────────
router.get('/:id', async (req, res) => {
    try {
        const group = await Group.findOne({ groupId: req.params.id })

        if (!group) {
            return res.status(404).json({
                success: false,
                error: { message: 'Group not found', code: 'not_found' },
            })
        }

        if (!isMemberOrOwner(group, req.userId)) {
            return res.status(403).json({
                success: false,
                error: { message: 'You do not have access to this group', code: 'forbidden' },
            })
        }

        return res.json({
            success: true,
            group: {
                groupId:     group.groupId,
                name:        group.name,
                description: group.description,
                owner:       group.userId,
                members:     group.members,
                permissions: group.permissions,
                isOwner:     group.userId === req.userId,
                createdAt:   group.createdAt,
                updatedAt:   group.updatedAt,
            },
        })
    } catch (err) {
        console.error('[Groups] get error:', err)
        return res.status(500).json({
            success: false,
            error: { message: 'Failed to get group', code: 'server_error' },
        })
    }
})

// ─── PUT /api/groups/:id — Update group (owner only) ────────────────────────────
router.put('/:id', async (req, res) => {
    try {
        const group = await Group.findOne({ groupId: req.params.id })

        if (!group) {
            return res.status(404).json({
                success: false,
                error: { message: 'Group not found', code: 'not_found' },
            })
        }

        if (!isOwner(group, req.userId)) {
            return res.status(403).json({
                success: false,
                error: { message: 'Only the group owner can update this group', code: 'forbidden' },
            })
        }

        const { name, description } = req.body

        if (name !== undefined) {
            if (typeof name !== 'string' || !name.trim()) {
                return res.status(400).json({
                    success: false,
                    error: { message: 'Group name cannot be empty', code: 'invalid_input' },
                })
            }
            if (name.trim().length > 100) {
                return res.status(400).json({
                    success: false,
                    error: { message: 'Group name must be 100 characters or fewer', code: 'invalid_input' },
                })
            }
            group.name = name.trim()
        }

        if (description !== undefined) {
            group.description = String(description).trim().slice(0, 500)
        }

        await group.save()

        return res.json({
            success: true,
            group: {
                groupId:     group.groupId,
                name:        group.name,
                description: group.description,
                owner:       group.userId,
                members:     group.members,
                permissions: group.permissions,
                updatedAt:   group.updatedAt,
            },
        })
    } catch (err) {
        console.error('[Groups] update error:', err)
        return res.status(500).json({
            success: false,
            error: { message: 'Failed to update group', code: 'server_error' },
        })
    }
})

// ─── DELETE /api/groups/:id — Delete group (owner only) ─────────────────────────
router.delete('/:id', async (req, res) => {
    try {
        const group = await Group.findOne({ groupId: req.params.id })

        if (!group) {
            return res.status(404).json({
                success: false,
                error: { message: 'Group not found', code: 'not_found' },
            })
        }

        if (!isOwner(group, req.userId)) {
            return res.status(403).json({
                success: false,
                error: { message: 'Only the group owner can delete this group', code: 'forbidden' },
            })
        }

        // Remove all access grants associated with this group
        await AccessGrant.deleteMany({ granteeType: 'group', granteeId: group.groupId })

        await Group.deleteOne({ groupId: group.groupId })

        return res.json({
            success: true,
            message: 'Group deleted successfully',
        })
    } catch (err) {
        console.error('[Groups] delete error:', err)
        return res.status(500).json({
            success: false,
            error: { message: 'Failed to delete group', code: 'server_error' },
        })
    }
})

// ─── POST /api/groups/:id/members — Add member ─────────────────────────────────
router.post('/:id/members', async (req, res) => {
    try {
        const group = await Group.findOne({ groupId: req.params.id })

        if (!group) {
            return res.status(404).json({
                success: false,
                error: { message: 'Group not found', code: 'not_found' },
            })
        }

        if (!isOwner(group, req.userId)) {
            return res.status(403).json({
                success: false,
                error: { message: 'Only the group owner can add members', code: 'forbidden' },
            })
        }

        const { userId } = req.body

        if (!userId || typeof userId !== 'string' || !userId.trim()) {
            return res.status(400).json({
                success: false,
                error: { message: 'userId is required', code: 'invalid_input' },
            })
        }

        const targetUserId = userId.trim()

        // Cannot add the owner as a member (they already have full access)
        if (targetUserId === group.userId) {
            return res.status(400).json({
                success: false,
                error: { message: 'The group owner is already implicitly a member', code: 'already_owner' },
            })
        }

        // Check if already a member
        if (group.members.includes(targetUserId)) {
            return res.status(409).json({
                success: false,
                error: { message: 'User is already a member of this group', code: 'already_member' },
            })
        }

        group.members.push(targetUserId)
        await group.save()

        return res.status(201).json({
            success: true,
            message: 'Member added successfully',
            members: group.members,
        })
    } catch (err) {
        console.error('[Groups] add member error:', err)
        return res.status(500).json({
            success: false,
            error: { message: 'Failed to add member', code: 'server_error' },
        })
    }
})

// ─── DELETE /api/groups/:id/members/:userId — Remove member ─────────────────────
router.delete('/:id/members/:userId', async (req, res) => {
    try {
        const group = await Group.findOne({ groupId: req.params.id })

        if (!group) {
            return res.status(404).json({
                success: false,
                error: { message: 'Group not found', code: 'not_found' },
            })
        }

        // Owner or the member themselves can remove
        const targetUserId = req.params.userId
        if (!isOwner(group, req.userId) && req.userId !== targetUserId) {
            return res.status(403).json({
                success: false,
                error: { message: 'Only the group owner or the member themselves can remove membership', code: 'forbidden' },
            })
        }

        const memberIndex = group.members.indexOf(targetUserId)
        if (memberIndex === -1) {
            return res.status(404).json({
                success: false,
                error: { message: 'User is not a member of this group', code: 'not_member' },
            })
        }

        group.members.splice(memberIndex, 1)
        await group.save()

        // Remove any user-level access grants for this member via the group
        // (Group-level grants remain — they just won't apply to this user anymore)

        return res.json({
            success: true,
            message: 'Member removed successfully',
            members: group.members,
        })
    } catch (err) {
        console.error('[Groups] remove member error:', err)
        return res.status(500).json({
            success: false,
            error: { message: 'Failed to remove member', code: 'server_error' },
        })
    }
})

// ─── GET /api/groups/:id/permissions — Get group permissions ────────────────────
router.get('/:id/permissions', async (req, res) => {
    try {
        const group = await Group.findOne({ groupId: req.params.id })

        if (!group) {
            return res.status(404).json({
                success: false,
                error: { message: 'Group not found', code: 'not_found' },
            })
        }

        if (!isMemberOrOwner(group, req.userId)) {
            return res.status(403).json({
                success: false,
                error: { message: 'You do not have access to this group', code: 'forbidden' },
            })
        }

        // Fetch access grants linked to this group
        const accessGrants = await AccessGrant.find({
            granteeType: 'group',
            granteeId: group.groupId,
        }).sort({ createdAt: -1 })

        return res.json({
            success: true,
            permissions: group.permissions,
            accessGrants: accessGrants.map(g => ({
                grantId:      g.grantId,
                resourceType: g.resourceType,
                resourceId:   g.resourceId,
                permission:   g.permission,
                grantedBy:    g.grantedBy,
                createdAt:    g.createdAt,
            })),
        })
    } catch (err) {
        console.error('[Groups] get permissions error:', err)
        return res.status(500).json({
            success: false,
            error: { message: 'Failed to get group permissions', code: 'server_error' },
        })
    }
})

// ─── PUT /api/groups/:id/permissions — Update group permissions (owner only) ────
router.put('/:id/permissions', async (req, res) => {
    try {
        const group = await Group.findOne({ groupId: req.params.id })

        if (!group) {
            return res.status(404).json({
                success: false,
                error: { message: 'Group not found', code: 'not_found' },
            })
        }

        if (!isOwner(group, req.userId)) {
            return res.status(403).json({
                success: false,
                error: { message: 'Only the group owner can update permissions', code: 'forbidden' },
            })
        }

        const { workspace, chat, accessGrants } = req.body

        // ── Update workspace permissions ────────────────────────────────────
        if (workspace && typeof workspace === 'object') {
            const allowed = ['models', 'knowledge', 'prompts', 'tools']
            for (const key of allowed) {
                if (typeof workspace[key] === 'boolean') {
                    group.permissions.workspace[key] = workspace[key]
                }
            }
        }

        // ── Update chat permissions ─────────────────────────────────────────
        if (chat && typeof chat === 'object') {
            const allowed = ['fileUpload', 'delete', 'edit', 'temporary']
            for (const key of allowed) {
                if (typeof chat[key] === 'boolean') {
                    group.permissions.chat[key] = chat[key]
                }
            }
        }

        group.markModified('permissions')
        await group.save()

        // ── Upsert access grants if provided ────────────────────────────────
        const grantResults = []
        if (Array.isArray(accessGrants)) {
            for (const grant of accessGrants) {
                if (!grant.resourceType || !grant.resourceId) continue

                const validTypes = ['knowledge', 'tool', 'function', 'channel']
                const validPerms = ['read', 'write', 'execute', 'admin']

                if (!validTypes.includes(grant.resourceType)) continue
                if (grant.permission && !validPerms.includes(grant.permission)) continue

                // Remove existing grant for same resource if present
                if (grant._delete) {
                    await AccessGrant.deleteOne({
                        granteeType:  'group',
                        granteeId:    group.groupId,
                        resourceType: grant.resourceType,
                        resourceId:   grant.resourceId,
                    })
                    grantResults.push({ action: 'deleted', resourceType: grant.resourceType, resourceId: grant.resourceId })
                    continue
                }

                const upserted = await AccessGrant.findOneAndUpdate(
                    {
                        granteeType:  'group',
                        granteeId:    group.groupId,
                        resourceType: grant.resourceType,
                        resourceId:   grant.resourceId,
                    },
                    {
                        $set: {
                            permission: grant.permission || 'read',
                            grantedBy:  req.userId,
                        },
                        $setOnInsert: {
                            granteeType:  'group',
                            granteeId:    group.groupId,
                            resourceType: grant.resourceType,
                            resourceId:   grant.resourceId,
                        },
                    },
                    { upsert: true, new: true }
                )
                grantResults.push({
                    action:       'upserted',
                    grantId:      upserted.grantId,
                    resourceType: upserted.resourceType,
                    resourceId:   upserted.resourceId,
                    permission:   upserted.permission,
                })
            }
        }

        return res.json({
            success: true,
            message: 'Group permissions updated',
            permissions: group.permissions,
            accessGrantResults: grantResults,
        })
    } catch (err) {
        console.error('[Groups] update permissions error:', err)
        return res.status(500).json({
            success: false,
            error: { message: 'Failed to update group permissions', code: 'server_error' },
        })
    }
})

module.exports = router
