const mongoose = require('mongoose')
const { v4: uuidv4 } = require('uuid')

const SkillSchema = new mongoose.Schema({
    skillId:     { type: String, default: () => uuidv4(), unique: true, index: true },
    userId:      { type: String, required: true, index: true },
    name:        { type: String, required: true },
    description: { type: String, default: '' },
    content:     { type: String, default: '' },  // Skill code or definition
    meta:        { type: mongoose.Schema.Types.Mixed, default: {} },
    isActive:    { type: Boolean, default: true },
    createdAt:   { type: Date, default: Date.now },
    updatedAt:   { type: Date, default: Date.now },
})

SkillSchema.pre('save', function () { this.updatedAt = new Date() })

module.exports = mongoose.model('Skill', SkillSchema)
