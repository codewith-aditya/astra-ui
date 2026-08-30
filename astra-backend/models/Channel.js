const mongoose = require('mongoose')
const { v4: uuidv4 } = require('uuid')

const ChannelSchema = new mongoose.Schema({
    channelId:   { type: String, default: () => uuidv4(), unique: true, index: true },
    userId:      { type: String, required: true, index: true },  // creator
    name:        { type: String, required: true },
    description: { type: String, default: '' },
    type:        { type: String, enum: ['public', 'private', 'direct'], default: 'public' },
    members:     [{ type: String }],  // userIds who can access (for private)
    meta:        { type: mongoose.Schema.Types.Mixed, default: {} },
    createdAt:   { type: Date, default: Date.now },
    updatedAt:   { type: Date, default: Date.now },
})

ChannelSchema.pre('save', function () { this.updatedAt = new Date() })

module.exports = mongoose.model('Channel', ChannelSchema)
