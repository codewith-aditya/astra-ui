const mongoose = require('mongoose')
const { v4: uuidv4 } = require('uuid')

const FileSchema = new mongoose.Schema({
    fileId:      { type: String, default: () => uuidv4(), unique: true, index: true },
    userId:      { type: String, required: true, index: true },
    filename:    { type: String, required: true },
    contentType: { type: String, default: 'application/octet-stream' },
    size:        { type: Number, default: 0 },
    hash:        { type: String, default: '' },
    path:        { type: String, default: '' },  // disk path or S3 key
    meta: {
        extractedText:   { type: String, default: '' },
        tokenCount:      { type: Number, default: 0 },
        embeddingStatus: { type: String, enum: ['pending', 'processing', 'completed', 'failed'], default: 'pending' },
        chunkCount:      { type: Number, default: 0 },
    },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
})

FileSchema.pre('save', function () { this.updatedAt = new Date() })

module.exports = mongoose.model('File', FileSchema)
