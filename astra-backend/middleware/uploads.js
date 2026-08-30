// ═══════════════════════════════════════════════════════════════════════════
//  Multer configurations.
//
//  The previous document upload passed `dest:` to multer, which is not a
//  recognised option in multer 2.x. With neither `dest` nor `storage`, multer
//  falls back to its default and files were written to the OS temp directory
//  instead of ./uploads — outside the path the cleanup code expected.
//
//  Both configurations here use an explicit diskStorage with generated
//  filenames, so a caller cannot influence the path on disk.
// ═══════════════════════════════════════════════════════════════════════════

const multer = require('multer')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')

const { PayloadTooLargeError, BadRequestError } = require('../utils/errors')

const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads')
const TMP_DIR = path.join(UPLOAD_ROOT, 'tmp')
const IMAGE_DIR = path.join(UPLOAD_ROOT, 'images')

for (const dir of [UPLOAD_ROOT, TMP_DIR, IMAGE_DIR]) {
    fs.mkdirSync(dir, { recursive: true })
}

const DOCUMENT_MAX_BYTES = 20 * 1024 * 1024
const IMAGE_MAX_BYTES = 10 * 1024 * 1024

// Extension allow-list. Note that the MIME type reported by the client is
// advisory only — see utils/fileType.js for magic-byte verification, which is
// what actually decides how a file is parsed.
const DOCUMENT_EXTS = new Set(['.pdf', '.docx', '.zip', '.txt', '.md', '.markdown', '.csv'])
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/** Random, caller-independent filename preserving only a vetted extension. */
function safeName(originalName, allowedExts) {
    const ext = path.extname(String(originalName || '')).toLowerCase()
    const finalExt = allowedExts.has(ext) ? ext : ''
    return `${Date.now()}_${crypto.randomBytes(8).toString('hex')}${finalExt}`
}

const documentStorage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, TMP_DIR),
    filename: (_req, file, cb) => cb(null, safeName(file.originalname, DOCUMENT_EXTS)),
})

const imageStorage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, IMAGE_DIR),
    filename: (_req, file, cb) => cb(null, `img_${safeName(file.originalname, IMAGE_EXTS)}`),
})

const documentUpload = multer({
    storage: documentStorage,
    limits: { fileSize: DOCUMENT_MAX_BYTES, files: 1 },
    fileFilter: (_req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase()
        if (!DOCUMENT_EXTS.has(ext)) {
            return cb(new BadRequestError(
                `Unsupported file type: ${ext || 'unknown'}`,
                'unsupported_file_type'
            ))
        }
        cb(null, true)
    },
})

const imageUpload = multer({
    storage: imageStorage,
    limits: { fileSize: IMAGE_MAX_BYTES, files: 1 },
    fileFilter: (_req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase()
        // Both the extension and the declared MIME type must be plausible.
        // Content is still verified by magic bytes after the write completes.
        if (!IMAGE_EXTS.has(ext) || !IMAGE_MIMES.has(file.mimetype)) {
            return cb(new BadRequestError('Only PNG, JPEG, GIF and WebP images are accepted', 'unsupported_image_type'))
        }
        cb(null, true)
    },
})

/**
 * Translate multer's own errors into the shared error shape so the global
 * handler reports a correct status instead of a generic 500.
 */
function multerErrorHandler(err, _req, _res, next) {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return next(new PayloadTooLargeError('File exceeds the maximum allowed size', 'file_too_large'))
        }
        if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
            return next(new BadRequestError('Unexpected file upload', 'unexpected_file'))
        }
        return next(new BadRequestError(err.message, 'upload_failed'))
    }
    return next(err)
}

module.exports = {
    documentUpload,
    imageUpload,
    multerErrorHandler,
    UPLOAD_ROOT,
    TMP_DIR,
    IMAGE_DIR,
    DOCUMENT_MAX_BYTES,
    IMAGE_MAX_BYTES,
}
