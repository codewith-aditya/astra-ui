const express = require('express')
const router = express.Router()
const auth = require('../middleware/auth')
const ragCtrl = require('../controllers/ragController')

// ═══════════════════════════════════════════════════════════════════════════════
//  RAG Routes — Retrieval Augmented Generation
//  All routes require auth: Authorization: Bearer <userId>
//  AstraGPT · Tantra AI Labs · 2025
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Embedding & Querying ────────────────────────────────────────────────────
router.post('/api/rag/embed',   auth, ragCtrl.embedFile)   // Chunk + store file text
router.post('/api/rag/query',   auth, ragCtrl.queryRAG)    // Search knowledge base

// ─── RAG Configuration ──────────────────────────────────────────────────────
router.get('/api/rag/config',   auth, ragCtrl.getConfig)       // Get user's RAG config
router.post('/api/rag/config',  auth, ragCtrl.updateConfig)    // Update RAG config

// ─── File Processing ────────────────────────────────────────────────────────
router.post('/api/rag/process',       auth, ragCtrl.processFile)    // Process single file
router.post('/api/rag/process/batch', auth, ragCtrl.batchProcess)   // Process multiple files

// ─── Embedding Config (alias) ───────────────────────────────────────────────
router.get('/api/rag/embedding/config', auth, ragCtrl.getConfig)   // Reuse same handler

// ─── Web Search & Load ──────────────────────────────────────────────────────
router.post('/api/rag/web/search', auth, ragCtrl.webSearch)   // Proxy to search engine
router.post('/api/rag/web/load',   auth, ragCtrl.webLoad)     // Load webpage content

module.exports = router
