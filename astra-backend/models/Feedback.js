const mongoose = require('mongoose')
const { v4: uuidv4 } = require('uuid')

const FeedbackSchema = new mongoose.Schema({
    feedbackId: { type: String, default: () => uuidv4(), unique: true, index: true },
    userId:     { type: String, required: true, index: true },
    type:       { type: String, enum: ['rating', 'comparison', 'comment'], default: 'rating' },
    data: {
        rating:  { type: Number, min: -1, max: 1, default: 0 },   // -1 dislike, 0 neutral, 1 like
        comment: { type: String, default: '' },
        modelA:  { type: String, default: '' },
        modelB:  { type: String, default: '' },
        winner:  { type: String, default: '' },   // modelA | modelB | tie
        tags:    [{ type: String }],
    },
    chatId:    { type: String, default: '', index: true },
    messageId: { type: String, default: '' },
    meta:      { type: mongoose.Schema.Types.Mixed, default: {} },
    createdAt: { type: Date, default: Date.now },
})

module.exports = mongoose.model('Feedback', FeedbackSchema)
