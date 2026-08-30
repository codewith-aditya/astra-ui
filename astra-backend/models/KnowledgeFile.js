const mongoose = require('mongoose')
const { v4: uuidv4 } = require('uuid')

const KnowledgeFileSchema = new mongoose.Schema({
    id:          { type: String, default: () => uuidv4(), unique: true },
    knowledgeId: { type: String, required: true, index: true },
    fileId:      { type: String, required: true, index: true },
    userId:      { type: String, required: true },
    createdAt:   { type: Date, default: Date.now },
})

KnowledgeFileSchema.index({ knowledgeId: 1, fileId: 1 }, { unique: true })

module.exports = mongoose.model('KnowledgeFile', KnowledgeFileSchema)
