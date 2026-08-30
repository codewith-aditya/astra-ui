const mongoose = require('mongoose')
const { v4: uuidv4 } = require('uuid')

const FunctionSchema = new mongoose.Schema({
    functionId: { type: String, default: () => uuidv4(), unique: true, index: true },
    userId:     { type: String, required: true, index: true },
    name:       { type: String, required: true },
    type:       { type: String, enum: ['filter', 'action', 'pipe'], default: 'filter' },
    content:    { type: String, default: '' },  // Function code
    meta:       { type: mongoose.Schema.Types.Mixed, default: {} },
    valves:     { type: mongoose.Schema.Types.Mixed, default: {} },
    isActive:   { type: Boolean, default: false },
    isGlobal:   { type: Boolean, default: false },
    createdAt:  { type: Date, default: Date.now },
    updatedAt:  { type: Date, default: Date.now },
})

FunctionSchema.pre('save', function () { this.updatedAt = new Date() })

module.exports = mongoose.model('Function', FunctionSchema)
