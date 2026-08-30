const mongoose = require('mongoose')
const { v4: uuidv4 } = require('uuid')

const KnowledgeSchema = new mongoose.Schema({
    knowledgeId: { type: String, default: () => uuidv4(), unique: true, index: true },
    userId:      { type: String, required: true, index: true },
    name:        { type: String, required: true },
    description: { type: String, default: '' },
    meta:        { type: mongoose.Schema.Types.Mixed, default: {} },
    fileCount:   { type: Number, default: 0 },
    createdAt:   { type: Date, default: Date.now },
    updatedAt:   { type: Date, default: Date.now },
})

KnowledgeSchema.pre('save', function () { this.updatedAt = new Date() })

module.exports = mongoose.model('Knowledge', KnowledgeSchema)
