const mongoose = require('mongoose')
const { v4: uuidv4 } = require('uuid')

const ToolSchema = new mongoose.Schema({
    toolId:      { type: String, default: () => uuidv4(), unique: true, index: true },
    userId:      { type: String, required: true, index: true },
    name:        { type: String, required: true },
    description: { type: String, default: '' },
    content:     { type: String, default: '' },  // Tool code (JS/Python)
    specs:       [{ type: mongoose.Schema.Types.Mixed }],  // OpenAI function spec array
    meta:        { type: mongoose.Schema.Types.Mixed, default: {} },
    valves:      { type: mongoose.Schema.Types.Mixed, default: {} },  // Configurable parameters
    isActive:    { type: Boolean, default: true },
    createdAt:   { type: Date, default: Date.now },
    updatedAt:   { type: Date, default: Date.now },
})

ToolSchema.pre('save', function () { this.updatedAt = new Date() })

module.exports = mongoose.model('Tool', ToolSchema)
