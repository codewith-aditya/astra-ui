const mongoose = require('mongoose')

const PromptSchema = new mongoose.Schema({
    userId:      { type: String, required: true, index: true },
    title:       { type: String, required: true, maxlength: 100 },
    content:     { type: String, required: true, maxlength: 4000 },
    tags:        [{ type: String }],
    isPublic:    { type: Boolean, default: false },
    usageCount:  { type: Number, default: 0 },
    createdAt:   { type: Date, default: Date.now },
    updatedAt:   { type: Date, default: Date.now }
})

module.exports = mongoose.model('Prompt', PromptSchema)
