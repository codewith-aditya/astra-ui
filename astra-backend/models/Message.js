const mongoose = require('mongoose')

const MessageSchema = new mongoose.Schema({
    chatId:    { type: String, required: true, index: true },
    role:      { type: String, enum: ['user', 'assistant', 'system'], required: true },
    content:   { type: String, required: true },
    imageUrl:  { type: String, default: null },   // VPS image URL — persists across reloads
    imageName: { type: String, default: null },   // original filename
    reaction:  { type: String, enum: ['like', 'dislike', null], default: null },
    tokenCount:{ type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now }
})

module.exports = mongoose.model('Message', MessageSchema)
