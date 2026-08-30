const mongoose = require('mongoose')
const { v4: uuidv4 } = require('uuid')

const FolderSchema = new mongoose.Schema({
    folderId:  { type: String, default: () => uuidv4(), unique: true, index: true },
    userId:    { type: String, required: true, index: true },
    name:      { type: String, required: true },
    parentId:  { type: String, default: null },  // for nested folders
    isExpanded: { type: Boolean, default: false },
    meta:      { type: mongoose.Schema.Types.Mixed, default: {} },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
})

FolderSchema.index({ userId: 1, parentId: 1 })
FolderSchema.pre('save', function () { this.updatedAt = new Date() })

module.exports = mongoose.model('Folder', FolderSchema)
