// ═══════════════════════════════════════════════════════════════════════════
//  File upload parsing.
//
//  Fixes applied here:
//    • fs.readFileSync replaced with async reads — a 20MB sync read blocked
//      the event loop for every other request in the process.
//    • File type is decided by magic bytes, not the client-supplied mimetype.
//    • ZIP extraction now enforces a total uncompressed budget, an entry-count
//      cap and a compression-ratio check (zip-bomb protection).
//    • Secret-bearing files inside archives (.env, keys, credentials) are
//      listed but never echoed back — previously `.env` was in the inline
//      text-extension allowlist, so uploading an archive returned its secrets.
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('fs/promises')
const path = require('path')

if (typeof global.DOMMatrix === 'undefined') {
    global.DOMMatrix = class DOMMatrix {}
}

const pdf = require('pdf-parse')
const mammoth = require('mammoth')
const AdmZip = require('adm-zip')
const { parse } = require('csv-parse/sync')

const logger = require('../utils/logger')
const { asyncHandler } = require('../utils/asyncHandler')
const { detect } = require('../utils/fileType')
const { BadRequestError } = require('../utils/errors')

const MAX_CONTENT_CHARS = 50_000

// ─── ZIP limits ─────────────────────────────────────────────────────────────
const ZIP_MAX_ENTRIES = 1_000
const ZIP_MAX_TOTAL_UNCOMPRESSED = 100 * 1024 * 1024   // 100MB across all entries
const ZIP_MAX_ENTRY_SIZE = 5 * 1024 * 1024             // 5MB per inlined file
const ZIP_MAX_RATIO = 200                              // uncompressed:compressed

// Extensions whose contents we are willing to inline from an archive.
// Deliberately excludes .env and anything credential-shaped.
const ZIP_TEXT_EXTS = new Set([
    '.txt', '.md', '.markdown', '.rst',
    '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
    '.py', '.rb', '.go', '.rs', '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.cs',
    '.json', '.html', '.htm', '.css', '.scss', '.yml', '.yaml', '.toml', '.xml',
    '.sh', '.bash', '.sql', '.csv',
])

// Files whose contents must never be returned, even if the extension matches.
const SECRET_NAME = /(^|[/\\])(\.env(\..*)?|\.npmrc|\.netrc|\.pgpass|\.htpasswd|id_rsa|id_dsa|id_ecdsa|id_ed25519|.*\.pem|.*\.key|.*\.pfx|.*\.p12|.*\.keystore|credentials|secrets?\.(json|ya?ml|txt))$/i

function isSecretPath(entryName) {
    return SECRET_NAME.test(entryName)
}

// ─── Parsers ────────────────────────────────────────────────────────────────

async function parsePdf(buf, name) {
    const data = await pdf(buf)
    return { type: 'pdf', name, content: (data.text || '').slice(0, MAX_CONTENT_CHARS), pages: data.numpages }
}

async function parseDocx(buf, name) {
    const result = await mammoth.extractRawText({ buffer: buf })
    return { type: 'docx', name, content: (result.value || '').slice(0, MAX_CONTENT_CHARS) }
}

function parseCsv(buf, name) {
    const text = buf.toString('utf-8')
    let rows
    try {
        rows = parse(text, { skip_empty_lines: true, relax_quotes: true, relax_column_count: true })
    } catch (err) {
        throw new BadRequestError(`Could not parse CSV: ${err.message}`, 'invalid_csv')
    }
    const preview = rows.slice(0, 100).map(r => r.join(', ')).join('\n')
    return { type: 'csv', name, content: preview.slice(0, MAX_CONTENT_CHARS), rows: rows.length }
}

function parseZip(buf, name) {
    let zip
    try {
        zip = new AdmZip(buf)
    } catch (err) {
        throw new BadRequestError(`Could not read archive: ${err.message}`, 'invalid_zip')
    }

    const entries = zip.getEntries()
    if (entries.length > ZIP_MAX_ENTRIES) {
        throw new BadRequestError(
            `Archive contains too many entries (${entries.length}, max ${ZIP_MAX_ENTRIES})`,
            'zip_too_many_entries'
        )
    }

    // Budget check before reading any content: refuse declared-size bombs.
    let declaredTotal = 0
    for (const entry of entries) {
        declaredTotal += entry.header.size || 0
        if (declaredTotal > ZIP_MAX_TOTAL_UNCOMPRESSED) {
            throw new BadRequestError('Archive expands to too much data', 'zip_bomb_suspected')
        }
        const compressed = entry.header.compressedSize || 0
        if (compressed > 0 && (entry.header.size / compressed) > ZIP_MAX_RATIO) {
            throw new BadRequestError('Archive compression ratio is implausible', 'zip_bomb_suspected')
        }
    }

    const listing = []
    const bodies = []
    let inlinedBytes = 0
    let skippedSecrets = 0

    for (const entry of entries) {
        if (entry.isDirectory) continue
        listing.push(`- ${entry.entryName} (${entry.header.size} bytes)`)
    }

    for (const entry of entries) {
        if (entry.isDirectory) continue
        if (inlinedBytes >= MAX_CONTENT_CHARS) break

        const entryExt = path.extname(entry.entryName).toLowerCase()

        if (isSecretPath(entry.entryName)) {
            skippedSecrets++
            continue
        }
        if (!ZIP_TEXT_EXTS.has(entryExt)) continue
        if ((entry.header.size || 0) > ZIP_MAX_ENTRY_SIZE) continue

        let text
        try {
            text = zip.readAsText(entry)
        } catch {
            continue   // binary or corrupt entry
        }
        if (!text) continue

        const slice = text.slice(0, 5_000)
        inlinedBytes += slice.length
        bodies.push(`\n### ${entry.entryName}\n\`\`\`\n${slice}\n\`\`\`\n`)
    }

    let content = `ZIP Archive: ${name}\nFiles inside:\n${listing.join('\n')}\n`
    if (skippedSecrets > 0) {
        content += `\n(${skippedSecrets} credential-bearing file(s) listed but not shown.)\n`
    }
    content += `\n--- File Contents ---\n${bodies.join('')}`

    return {
        type: 'zip',
        name,
        content: content.slice(0, MAX_CONTENT_CHARS),
        fileCount: entries.length,
    }
}

function parseText(buf, name, type = 'text') {
    return { type, name, content: buf.toString('utf-8').slice(0, MAX_CONTENT_CHARS) }
}

/**
 * Parse an uploaded file. Routes on verified content, falling back to the
 * declared extension only to disambiguate ZIP containers (docx vs plain zip).
 * Always removes the temp file.
 */
async function parseFile(filePath, originalName) {
    const ext = path.extname(originalName).toLowerCase()

    try {
        const kind = await detect(filePath)

        if (kind === 'empty') throw new BadRequestError('File is empty', 'empty_file')
        if (kind === 'binary') {
            throw new BadRequestError(
                'File appears to be binary and is not a supported document type',
                'unsupported_content'
            )
        }
        if (['png', 'jpeg', 'gif', 'webp'].includes(kind)) {
            throw new BadRequestError(
                'Image files should be sent to the image upload endpoint',
                'wrong_endpoint'
            )
        }

        const buf = await fs.readFile(filePath)

        if (kind === 'pdf') return await parsePdf(buf, originalName)

        if (kind === 'zip') {
            // A .docx is a ZIP container; anything else ZIP-shaped is an archive.
            if (ext === '.docx') return await parseDocx(buf, originalName)
            return parseZip(buf, originalName)
        }

        // Verified text content from here on.
        if (ext === '.csv') return parseCsv(buf, originalName)
        if (ext === '.md' || ext === '.markdown') return parseText(buf, originalName, 'markdown')
        return parseText(buf, originalName, 'text')
    } finally {
        await fs.unlink(filePath).catch(() => {})
    }
}

// ─── POST /api/upload ───────────────────────────────────────────────────────
exports.uploadFile = asyncHandler(async (req, res) => {
    if (!req.file) throw new BadRequestError('No file uploaded', 'no_file')

    try {
        const parsed = await parseFile(req.file.path, req.file.originalname)

        logger.info('file.parsed', {
            userId: req.userId,
            type: parsed.type,
            bytes: req.file.size,
            chars: parsed.content.length,
        })

        res.json({
            ok: true,
            file: {
                name: parsed.name,
                type: parsed.type,
                content: parsed.content,
                meta: { pages: parsed.pages, rows: parsed.rows, fileCount: parsed.fileCount },
            },
        })
    } catch (err) {
        // parseFile already unlinks; this covers a throw before that point.
        await fs.unlink(req.file.path).catch(() => {})
        throw err
    }
})

exports.parseFile = parseFile
