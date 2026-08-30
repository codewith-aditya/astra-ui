const mongoose = require('mongoose')

const NoteSchema = new mongoose.Schema({
    userId:    { type: String, required: true, index: true },
    title:     { type: String, default: 'Untitled Note', maxlength: 200 },
    content:   { type: String, default: '', maxlength: 50000 },
    pinned:    { type: Boolean, default: false },
    color:     { type: String, default: '' }, // optional accent color
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
})

module.exports = mongoose.model('Note', NoteSchema)
