const mongoose = require('mongoose')

const ConfigSchema = new mongoose.Schema({
    userId:    { type: String, required: true, index: true },
    key:       { type: String, required: true },
    value:     { type: mongoose.Schema.Types.Mixed, default: null },
    updatedAt: { type: Date, default: Date.now },
})

ConfigSchema.index({ userId: 1, key: 1 }, { unique: true })
ConfigSchema.pre('save', function () { this.updatedAt = new Date() })

module.exports = mongoose.model('Config', ConfigSchema)
