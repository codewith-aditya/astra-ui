// ═══════════════════════════════════════════════════════════════════════════
//  Audio — speech-to-text (Whisper) and text-to-speech.
//
//  Both endpoints spend money at OpenAI per call, so both are authenticated
//  and rate limited. Upstream failures are reported as 502/503 rather than
//  surfacing the provider's message, which can contain account details.
// ═══════════════════════════════════════════════════════════════════════════

const express = require('express')
const router = express.Router()
const multer = require('multer')
const OpenAI = require('openai')

const auth = require('../middleware/auth')
const Config = require('../models/Config')
const { asyncHandler } = require('../utils/asyncHandler')
const logger = require('../utils/logger')
const v = require('../utils/validate')
const env = require('../config/env')
const { limiters } = require('../middleware/rateLimit')
const {
    BadRequestError,
    ServiceUnavailableError,
    UpstreamError,
} = require('../utils/errors')

const MAX_AUDIO_BYTES = 25 * 1024 * 1024   // OpenAI's own limit
const MAX_TTS_CHARS = 4096

const VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']
const TTS_MODELS = ['tts-1', 'tts-1-hd']
const STT_MODELS = ['whisper-1']

// ISO-639-1, optionally with a region suffix. Passed to the provider, so it
// must not be free-form text.
const LANGUAGE_PATTERN = /^[a-z]{2}(-[A-Za-z]{2,8})?$/

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_AUDIO_BYTES, files: 1 },
    fileFilter: (_req, file, cb) => {
        const allowedMimes = new Set([
            'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/m4a', 'audio/x-m4a',
            'audio/wav', 'audio/x-wav', 'audio/webm', 'audio/ogg',
            'audio/flac', 'audio/x-flac', 'video/webm',
            'application/octet-stream',   // some browsers omit a real type
        ])
        const allowedExts = new Set(['.mp3', '.mp4', '.m4a', '.wav', '.webm', '.ogg', '.flac'])
        const ext = (file.originalname || '').toLowerCase().match(/\.[^.]+$/)?.[0] || ''
        if (allowedMimes.has(file.mimetype) || allowedExts.has(ext)) return cb(null, true)
        cb(new BadRequestError('Audio format not supported', 'unsupported_audio'))
    },
})

let openaiClient = null
function getOpenAI() {
    if (!env.OPENAI_API_KEY) {
        throw new ServiceUnavailableError('Audio features are not configured', 'audio_unavailable')
    }
    if (!openaiClient) openaiClient = new OpenAI({ apiKey: env.OPENAI_API_KEY })
    return openaiClient
}

const DEFAULT_AUDIO_CONFIG = {
    voice: 'alloy',
    model: 'tts-1',
    speed: 1.0,
    sttModel: 'whisper-1',
    language: null,
}

// Merge stored settings over the defaults, but only for keys we recognise and
// only when the stored value is still valid — a config written before a
// validation rule tightened must not be able to reach the provider.
async function getAudioConfig(userId) {
    const config = { ...DEFAULT_AUDIO_CONFIG }
    try {
        const doc = await Config.findOne({ userId, key: 'audio' }).lean()
        const stored = doc?.value
        if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return config

        if (VOICES.includes(stored.voice)) config.voice = stored.voice
        if (TTS_MODELS.includes(stored.model)) config.model = stored.model
        if (STT_MODELS.includes(stored.sttModel)) config.sttModel = stored.sttModel

        const speed = Number(stored.speed)
        if (Number.isFinite(speed) && speed >= 0.25 && speed <= 4) config.speed = speed

        if (typeof stored.language === 'string' && LANGUAGE_PATTERN.test(stored.language)) {
            config.language = stored.language
        }
    } catch (err) {
        logger.warn('audio.config.read_failed', { userId, error: err.message })
    }
    return config
}

// Translate a provider failure into our own error, without echoing its message.
function upstreamFailure(err, operation) {
    logger.error(`audio.${operation}.upstream_failed`, err)
    if (err.status === 429) {
        throw new UpstreamError('Audio provider is rate limiting requests', 'upstream_rate_limit', 429)
    }
    throw new UpstreamError('Audio provider request failed', 'upstream_error', 502)
}

// ─── POST /api/audio/transcribe ─────────────────────────────────────────────
router.post(
    '/api/audio/transcribe',
    auth,
    limiters.heavy,
    upload.single('file'),
    asyncHandler(async (req, res) => {
        if (!req.file) {
            throw new BadRequestError('No audio file uploaded. Use field name "file".', 'no_file')
        }

        const config = await getAudioConfig(req.userId)
        const openai = getOpenAI()

        const audioFile = new File(
            [req.file.buffer],
            req.file.originalname || 'audio.webm',
            { type: req.file.mimetype || 'audio/webm' },
        )

        let transcription
        try {
            transcription = await openai.audio.transcriptions.create({
                file: audioFile,
                model: config.sttModel,
                ...(config.language ? { language: config.language } : {}),
            })
        } catch (err) {
            upstreamFailure(err, 'transcribe')
        }

        logger.info('audio.transcribed', { userId: req.userId, bytes: req.file.size })

        res.json({
            text: transcription.text || '',
            language: transcription.language || null,
            duration: transcription.duration || null,
        })
    }),
)

// ─── POST /api/audio/synthesize ─────────────────────────────────────────────
router.post(
    '/api/audio/synthesize',
    auth,
    limiters.heavy,
    asyncHandler(async (req, res) => {
        const text = v.str(req.body?.text, 'text', { max: MAX_TTS_CHARS })
        const config = await getAudioConfig(req.userId)

        const voice = req.body?.voice === undefined
            ? config.voice
            : v.oneOf(req.body.voice, VOICES, 'voice')
        const model = req.body?.model === undefined
            ? config.model
            : v.oneOf(req.body.model, TTS_MODELS, 'model')

        let speed = config.speed
        if (req.body?.speed !== undefined) {
            speed = Number(req.body.speed)
            if (!Number.isFinite(speed) || speed < 0.25 || speed > 4) {
                throw new BadRequestError('speed must be between 0.25 and 4.0', 'invalid_speed', { field: 'speed' })
            }
        }

        const openai = getOpenAI()

        let response
        try {
            response = await openai.audio.speech.create({
                model,
                voice,
                input: text,
                speed,
                response_format: 'mp3',
            })
        } catch (err) {
            upstreamFailure(err, 'synthesize')
        }

        const buffer = Buffer.from(await response.arrayBuffer())
        logger.info('audio.synthesized', { userId: req.userId, chars: text.length })

        res.setHeader('Content-Type', 'audio/mpeg')
        res.setHeader('Content-Length', buffer.length)
        res.setHeader('Content-Disposition', 'inline; filename="speech.mp3"')
        res.send(buffer)
    }),
)

// ─── GET /api/audio/config ──────────────────────────────────────────────────
router.get(
    '/api/audio/config',
    auth,
    asyncHandler(async (req, res) => {
        res.json({ config: await getAudioConfig(req.userId) })
    }),
)

// ─── POST /api/audio/config ─────────────────────────────────────────────────
router.post(
    '/api/audio/config',
    auth,
    limiters.write,
    asyncHandler(async (req, res) => {
        const update = { ...(await getAudioConfig(req.userId)) }

        if (req.body?.voice !== undefined) update.voice = v.oneOf(req.body.voice, VOICES, 'voice')
        if (req.body?.model !== undefined) update.model = v.oneOf(req.body.model, TTS_MODELS, 'model')
        if (req.body?.sttModel !== undefined) update.sttModel = v.oneOf(req.body.sttModel, STT_MODELS, 'sttModel')

        if (req.body?.speed !== undefined) {
            const speed = Number(req.body.speed)
            if (!Number.isFinite(speed) || speed < 0.25 || speed > 4) {
                throw new BadRequestError('speed must be between 0.25 and 4.0', 'invalid_speed', { field: 'speed' })
            }
            update.speed = speed
        }

        if (req.body?.language !== undefined) {
            const language = req.body.language
            if (language === null || language === '') {
                update.language = null
            } else if (typeof language === 'string' && LANGUAGE_PATTERN.test(language)) {
                update.language = language
            } else {
                throw new BadRequestError(
                    'language must be an ISO-639-1 code such as "en" or "en-US"',
                    'invalid_language',
                    { field: 'language' },
                )
            }
        }

        await Config.findOneAndUpdate(
            { userId: req.userId, key: 'audio' },
            { $set: { value: update, updatedAt: new Date() } },
            { upsert: true },
        )

        res.json({ success: true, config: update })
    }),
)

module.exports = router
