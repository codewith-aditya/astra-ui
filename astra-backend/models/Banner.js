const mongoose = require('mongoose')

const BannerSchema = new mongoose.Schema({
    message:   { type: String, required: true, maxlength: 500 },
    type:      { type: String, enum: ['info', 'warning', 'success', 'error'], default: 'info' },
    link:      { type: String, default: '' },       // optional CTA link
    linkText:  { type: String, default: '' },       // optional CTA text
    isActive:  { type: Boolean, default: true },
    dismissible: { type: Boolean, default: true },
    expiresAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now }
})

module.exports = mongoose.model('Banner', BannerSchema)
