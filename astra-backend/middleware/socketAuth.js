// ═══════════════════════════════════════════════════════════════════════════
//  Socket.IO authentication + room authorisation.
//
//  Previously every socket event trusted client-supplied identifiers: a client
//  emitted `register` with any userId string and was joined to `user:<id>`, and
//  `join-chat` / `channel:join` joined any room by id. Any connected socket
//  could therefore subscribe to another user's private stream.
//
//  Now: the handshake must carry a valid access token, identity comes from the
//  verified token only, and every room join is checked against ownership or
//  membership in MongoDB.
// ═══════════════════════════════════════════════════════════════════════════

const { verifyToken } = require('../utils/tokens')
const logger = require('../utils/logger')
const User = require('../models/User')
const Chat = require('../models/Chat')
const Channel = require('../models/Channel')

/**
 * io.use() handshake guard. Rejects the connection unless a valid access token
 * is present. Identity is attached to the socket, never taken from an event.
 */
async function socketAuth(socket, next) {
    try {
        const raw =
            socket.handshake.auth?.token ||
            socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '') ||
            null

        if (!raw) return next(new Error('unauthorized'))

        const payload = verifyToken(raw, 'access')

        // Honour global revocation (password change / "sign out everywhere").
        const user = await User.findOne({ userId: payload.sub })
            .select('userId tokenVersion banned')
            .lean()
        if (!user) return next(new Error('unauthorized'))
        if (user.banned) return next(new Error('forbidden'))
        if ((payload.tv || 0) !== (user.tokenVersion || 0)) return next(new Error('unauthorized'))

        socket.userId = payload.sub
        socket.sessionId = payload.sid || null
        return next()
    } catch {
        return next(new Error('unauthorized'))
    }
}

/** True when `userId` owns the chat. */
async function canAccessChat(userId, chatId) {
    if (typeof chatId !== 'string' || !chatId) return false
    const chat = await Chat.findOne({ chatId }).select('userId').lean()
    return Boolean(chat && chat.userId === userId)
}

/** True when `userId` is a member of the channel. */
async function canAccessChannel(userId, channelId) {
    if (typeof channelId !== 'string' || !channelId) return false
    const channel = await Channel.findOne({ channelId }).select('userId members').lean()
    if (!channel) return false
    if (channel.userId === userId) return true
    const members = Array.isArray(channel.members) ? channel.members : []
    return members.some(m => (typeof m === 'string' ? m : m?.userId) === userId)
}

/**
 * Wire authenticated handlers. `onlineUsers` maps userId -> Set<socketId> so
 * multiple tabs do not evict each other on disconnect (the previous single-value
 * Map deleted a user's presence when any one tab closed).
 */
function registerSocketHandlers(io, onlineUsers) {
    io.use(socketAuth)

    io.on('connection', (socket) => {
        const userId = socket.userId

        // Identity comes from the verified token; there is no `register` event
        // to spoof any more. The personal room is joined automatically.
        socket.join(`user:${userId}`)
        if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set())
        onlineUsers.get(userId).add(socket.id)

        logger.debug('ws.connected', { userId, socketId: socket.id })

        socket.on('join-chat', async (chatId, ack) => {
            if (!(await canAccessChat(userId, chatId))) {
                logger.warn('ws.join_chat.denied', { userId, chatId: String(chatId).slice(0, 64) })
                if (typeof ack === 'function') ack({ ok: false, error: 'forbidden' })
                return
            }
            socket.join(`chat:${chatId}`)
            if (typeof ack === 'function') ack({ ok: true })
        })

        socket.on('leave-chat', (chatId) => {
            if (typeof chatId === 'string' && chatId) socket.leave(`chat:${chatId}`)
        })

        socket.on('typing', ({ chatId, isTyping } = {}) => {
            // Only broadcast into a room this socket has already been authorised
            // into — membership in socket.rooms is the authorisation record.
            if (typeof chatId !== 'string' || !socket.rooms.has(`chat:${chatId}`)) return
            socket.to(`chat:${chatId}`).emit('typing', { userId, isTyping: Boolean(isTyping) })
        })

        socket.on('channel:join', async (channelId, ack) => {
            if (!(await canAccessChannel(userId, channelId))) {
                logger.warn('ws.join_channel.denied', { userId, channelId: String(channelId).slice(0, 64) })
                if (typeof ack === 'function') ack({ ok: false, error: 'forbidden' })
                return
            }
            socket.join(`channel:${channelId}`)
            if (typeof ack === 'function') ack({ ok: true })
        })

        socket.on('channel:leave', (channelId) => {
            if (typeof channelId === 'string' && channelId) socket.leave(`channel:${channelId}`)
        })

        socket.on('channel:typing', ({ channelId, isTyping } = {}) => {
            if (typeof channelId !== 'string' || !socket.rooms.has(`channel:${channelId}`)) return
            socket.to(`channel:${channelId}`).emit('channel:typing', {
                userId, channelId, isTyping: Boolean(isTyping),
            })
        })

        socket.on('disconnect', () => {
            const sockets = onlineUsers.get(userId)
            if (sockets) {
                sockets.delete(socket.id)
                if (sockets.size === 0) onlineUsers.delete(userId)
            }
            logger.debug('ws.disconnected', { userId, socketId: socket.id })
        })
    })
}

module.exports = { socketAuth, registerSocketHandlers, canAccessChat, canAccessChannel }
