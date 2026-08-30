const mongoose = require('mongoose')
const { v4: uuidv4 } = require('uuid')

const AccessGrantSchema = new mongoose.Schema({
    grantId:      { type: String, default: () => uuidv4(), unique: true, index: true },
    resourceType: { type: String, enum: ['knowledge', 'tool', 'function', 'channel'], required: true },
    resourceId:   { type: String, required: true },
    granteeType:  { type: String, enum: ['user', 'group'], required: true },
    granteeId:    { type: String, required: true },
    permission:   { type: String, enum: ['read', 'write', 'execute', 'admin'], default: 'read' },
    grantedBy:    { type: String, default: '' },  // userId who granted
    createdAt:    { type: Date, default: Date.now },
})

AccessGrantSchema.index({ resourceType: 1, resourceId: 1 })
AccessGrantSchema.index({ granteeType: 1, granteeId: 1 })

module.exports = mongoose.model('AccessGrant', AccessGrantSchema)
