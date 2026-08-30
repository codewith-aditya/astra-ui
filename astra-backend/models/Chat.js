const mongoose = require('mongoose')

const ChatSchema = new mongoose.Schema({
    chatId:       { type: String, required: true, unique: true },
    userId:       { type: String, required: true, index: true },
    title:        { type: String, default: 'New Chat' },
    model:        { type: String, default: 'gpt-4o-mini' },
    systemPrompt: { type: String, default: '' },      // custom AI persona per chat (max 2000 chars)
    isPinned:     { type: Boolean, default: false },  // pinned to top
    isArchived:   { type: Boolean, default: false },  // archived (hidden from main list)
    tags:         [{ type: String }],                 // user-defined tags
    folderId:     { type: String, default: null },    // folder for organization
    knowledgeId:  { type: String, default: null },    // attached knowledge base
    createdAt:    { type: Date, default: Date.now }
})

module.exports = mongoose.model('Chat', ChatSchema)
