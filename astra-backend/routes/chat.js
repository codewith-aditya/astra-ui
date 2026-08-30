// ═══════════════════════════════════════════════════════════════════════════
//  Chat, inference, memory, upload and account routes.
//
//  Changes from the previous revision:
//    • /v1/chat/completions and /v1/responses now require authentication and
//      pass through plan + rate limits. They previously allowed unauthenticated
//      calls straight through to paid upstream providers.
//    • GET /api/messages/:chatId now requires auth and verifies chat ownership.
//    • DELETE /api/chats/all is registered BEFORE /api/chats/:chatId. The
//      previous order meant "all" was captured as a chatId and the bulk delete
//      was unreachable.
//    • Upload uses a real multer diskStorage. `dest:` is not a multer 2.x
//      option, so files were silently landing in the OS temp directory.
//    • Every identifier is validated before it reaches a Mongo query.
// ═══════════════════════════════════════════════════════════════════════════

const express = require('express')
const router = express.Router()

const ctrl = require('../controllers/chatController')
const fileCtrl = require('../controllers/fileController')
const generateCtrl = require('../controllers/generateController')
const adminCtrl = require('../controllers/adminController')

const auth = require('../middleware/auth')
const { adminGuard } = require('../middleware/adminGuard')
const { planGuard, getUsageStats, updatePlan } = require('../middleware/planGuard')
const { limiters } = require('../middleware/rateLimit')
const { documentUpload } = require('../middleware/uploads')

const { asyncHandler } = require('../utils/asyncHandler')
const logger = require('../utils/logger')
const v = require('../utils/validate')
const { NotFoundError, ForbiddenError } = require('../utils/errors')

const Memory = require('../models/Memory')
const Chat = require('../models/Chat')
const Message = require('../models/Message')
const User = require('../models/User')

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Throw unless the authenticated caller owns `chatId`. */
async function assertChatOwner(chatId, userId) {
    const chat = await Chat.findOne({ chatId }).select('userId').lean()
    if (!chat) throw new NotFoundError('Chat not found', 'chat_not_found')
    if (chat.userId !== userId) throw new ForbiddenError('You do not have access to this chat', 'not_chat_owner')
    return chat
}

// ─── File upload / generation ───────────────────────────────────────────────
// Authenticated + throttled: parsing and document generation are CPU and
// memory heavy, and were previously reachable anonymously.

router.post(
    '/api/upload',
    auth,
    limiters.heavy,
    documentUpload.single('file'),
    asyncHandler(fileCtrl.uploadFile)
)

router.post('/api/generate', auth, limiters.heavy, asyncHandler(generateCtrl.generateFile))
router.post('/generate-project', auth, limiters.heavy, asyncHandler(generateCtrl.generateProject))

// ─── OpenAI-compatible inference ────────────────────────────────────────────
// These spend money upstream. Auth + plan + rate limit are all mandatory.

router.post('/v1/chat/completions', auth, planGuard, limiters.inference, asyncHandler(ctrl.openaiCompletions))
router.post('/v1/responses', auth, planGuard, limiters.inference, asyncHandler(ctrl.openaiCompletions))

// Model catalogue is not sensitive and costs nothing to serve.
router.get('/v1/models', asyncHandler(ctrl.listModels))
router.get('/v1/me', auth, asyncHandler(ctrl.getMe))

// ─── Persistent chat ────────────────────────────────────────────────────────

router.post('/api/chat', auth, planGuard, limiters.inference, asyncHandler(ctrl.sendMessage))
router.post('/api/message', auth, limiters.write, asyncHandler(ctrl.saveMessage))

router.get('/api/chats/:userId', auth, asyncHandler(async (req, res, next) => {
    const target = v.id(req.params.userId, 'userId')
    if (target !== req.userId) {
        throw new ForbiddenError('You can only list your own chats', 'not_owner')
    }
    return ctrl.getUserChats(req, res, next)
}))

// Auth + ownership. Previously public: any chatId returned its full history.
router.get('/api/messages/:chatId', auth, asyncHandler(async (req, res, next) => {
    const chatId = v.id(req.params.chatId, 'chatId')
    await assertChatOwner(chatId, req.userId)
    return ctrl.getChatMessages(req, res, next)
}))

// NOTE: registered before '/api/chats/:chatId' so that the literal path "all"
// is not swallowed by the parameterised route.
router.delete('/api/chats/all', auth, asyncHandler(async (req, res) => {
    const userId = req.userId

    const chats = await Chat.find({ userId }).select('chatId').lean()
    const chatIds = chats.map(c => c.chatId)

    if (chatIds.length > 0) {
        await Message.deleteMany({ chatId: { $in: chatIds } })
    }
    const result = await Chat.deleteMany({ userId })

    logger.info('chats.deleteAll', { userId, deleted: result.deletedCount })
    res.json({ success: true, deleted: result.deletedCount })
}))

router.delete('/api/chats/:chatId', auth, asyncHandler(async (req, res, next) => {
    const chatId = v.id(req.params.chatId, 'chatId')
    await assertChatOwner(chatId, req.userId)
    return ctrl.deleteChat(req, res, next)
}))

// ─── Usage & plan ───────────────────────────────────────────────────────────
// getUsageStats derives the user from the verified token rather than a header.

router.get('/api/usage/:userId', auth, asyncHandler(getUsageStats))
router.post('/api/plan', adminGuard, limiters.admin, asyncHandler(updatePlan))

// ─── Coupons ────────────────────────────────────────────────────────────────
// Authenticated so redemption is attributable, and throttled so codes cannot
// be brute-forced.

router.post('/api/coupon/validate', auth, limiters.coupon, asyncHandler(adminCtrl.validateCoupon))
router.post('/api/coupon/redeem', auth, limiters.coupon, asyncHandler(adminCtrl.redeemCoupon))

// ─── Memory ─────────────────────────────────────────────────────────────────
// Scoped to the authenticated user. The :userId segment is retained for
// backwards compatibility but must match the token subject.

const MAX_MEMORY_LENGTH = 500

function assertSelf(req) {
    const target = v.id(req.params.userId, 'userId')
    if (target !== req.userId) {
        throw new ForbiddenError('You can only access your own memories', 'not_owner')
    }
    return target
}

router.get('/api/memory/:userId', auth, asyncHandler(async (req, res) => {
    const userId = assertSelf(req)
    const memories = await Memory.find({ userId })
        .sort({ createdAt: -1 })
        .limit(200)
        .lean()
    res.json({ memories })
}))

router.post('/api/memory/:userId', auth, limiters.write, asyncHandler(async (req, res) => {
    const userId = assertSelf(req)
    const content = v.str(req.body.content, 'content', { max: MAX_MEMORY_LENGTH })
    const source = v.oneOf(req.body.source ?? 'manual', ['manual', 'auto'], 'source')
    const tags = v.stringArray(req.body.tags, 'tags', { max: 20, maxLength: 50 })

    const existing = await Memory.findOne({ userId, content }).lean()
    if (existing) return res.json({ memory: existing, duplicate: true })

    const memory = await Memory.create({ userId, content, source, tags })
    res.status(201).json({ memory })
}))

router.delete('/api/memory/:userId/all', auth, asyncHandler(async (req, res) => {
    const userId = assertSelf(req)
    const result = await Memory.deleteMany({ userId })
    res.json({ deleted: result.deletedCount })
}))

router.delete('/api/memory/item/:memoryId', auth, asyncHandler(async (req, res) => {
    // Validated as an ObjectId first: findById on a malformed value throws a
    // CastError that would otherwise surface as an opaque 500.
    const memoryId = v.objectId(req.params.memoryId, 'memoryId')

    const memory = await Memory.findById(memoryId)
    if (!memory) throw new NotFoundError('Memory not found', 'memory_not_found')
    if (memory.userId !== req.userId) {
        throw new ForbiddenError('You do not own this memory', 'not_owner')
    }

    await memory.deleteOne()
    res.json({ deleted: true })
}))

// ─── Account deletion ───────────────────────────────────────────────────────

router.delete('/api/user/account', auth, asyncHandler(async (req, res) => {
    const userId = req.userId

    const chats = await Chat.find({ userId }).select('chatId').lean()
    const chatIds = chats.map(c => c.chatId)

    if (chatIds.length > 0) {
        await Message.deleteMany({ chatId: { $in: chatIds } })
    }
    await Chat.deleteMany({ userId })
    await Memory.deleteMany({ userId })
    await User.deleteOne({ userId })

    logger.info('account.deleted', { userId, chats: chatIds.length })
    res.json({ success: true, message: 'Account and all data permanently deleted' })
}))

// ─── Contact form ───────────────────────────────────────────────────────────
// Public by necessity, so throttled hard. Message bodies are not logged.

router.post('/api/contact', limiters.publicForm, asyncHandler(async (req, res) => {
    const name = v.str(req.body.name, 'name', { max: 100 })
    const email = v.email(req.body.email, 'email')
    const subject = v.str(req.body.subject, 'subject', { max: 200 })
    const message = v.str(req.body.message, 'message', { max: 5000 })

    logger.info('contact.received', { email, subject })
    adminCtrl.addLog('info', `Contact from ${name} <${email}> | ${subject}`, email)

    const webhook = process.env.DISCORD_CONTACT_WEBHOOK
    if (webhook) {
        try {
            await fetch(webhook, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    embeds: [{
                        title: `New contact: ${subject}`,
                        description: message.slice(0, 2000),
                        color: 0x7c3aed,
                        fields: [
                            { name: 'Name', value: name, inline: true },
                            { name: 'Email', value: email, inline: true },
                        ],
                        timestamp: new Date().toISOString(),
                    }],
                }),
                signal: AbortSignal.timeout(5000),
            })
        } catch (err) {
            logger.warn('contact.webhook_failed', { err: err.message })
        }
    }

    res.json({ success: true, message: 'Message received. We will get back to you soon!' })
}))

module.exports = router
