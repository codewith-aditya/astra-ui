const mongoose = require('mongoose')
const { v4: uuidv4 } = require('uuid')

const GroupSchema = new mongoose.Schema({
    groupId:     { type: String, default: () => uuidv4(), unique: true, index: true },
    userId:      { type: String, required: true, index: true },  // owner
    name:        { type: String, required: true },
    description: { type: String, default: '' },
    members:     [{ type: String }],  // array of userIds
    permissions: {
        workspace: {
            models:    { type: Boolean, default: true },
            knowledge: { type: Boolean, default: true },
            prompts:   { type: Boolean, default: true },
            tools:     { type: Boolean, default: true },
        },
        chat: {
            fileUpload: { type: Boolean, default: true },
            delete:     { type: Boolean, default: true },
            edit:       { type: Boolean, default: true },
            temporary:  { type: Boolean, default: true },
        },
    },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
})

GroupSchema.pre('save', function () { this.updatedAt = new Date() })

module.exports = mongoose.model('Group', GroupSchema)
