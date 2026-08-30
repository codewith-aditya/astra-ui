const mongoose = require('mongoose')
const { v4: uuidv4 } = require('uuid')

const ChannelMessageSchema = new mongoose.Schema({
    messageId: { type: String, default: () => uuidv4(), unique: true, index: true },
    channelId: { type: String, required: true, index: true },
    userId:    { type: String, required: true, index: true },
    content:   { type: String, required: true },
    parentId:  { type: String, default: null },  // for threaded replies
    reactions: { type: mongoose.Schema.Types.Mixed, default: {} },  // { "👍": ["userId1", ...] }
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
})

ChannelMessageSchema.index({ channelId: 1, createdAt: -1 })
ChannelMessageSchema.pre('save', function () { this.updatedAt = new Date() })

module.exports = mongoose.model('ChannelMessage', ChannelMessageSchema)
