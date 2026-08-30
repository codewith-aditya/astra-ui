// ═══════════════════════════════════════════════════════════════════════════
//  Magic-byte file type detection.
//
//  A client-declared MIME type is attacker-controlled. Anything that decides
//  how a file is parsed — or whether it is served back to a browser — must be
//  based on the actual bytes.
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('fs/promises')

/** Read just enough of the head of a file to identify it. */
async function readHead(filePath, length = 4100) {
    const handle = await fs.open(filePath, 'r')
    try {
        const buf = Buffer.alloc(length)
        const { bytesRead } = await handle.read(buf, 0, length, 0)
        return buf.subarray(0, bytesRead)
    } finally {
        await handle.close()
    }
}

function startsWith(buf, bytes) {
    if (buf.length < bytes.length) return false
    for (let i = 0; i < bytes.length; i++) {
        if (buf[i] !== bytes[i]) return false
    }
    return true
}

/**
 * Identify a buffer by signature. Returns a coarse kind rather than a MIME
 * type, because the callers only need to route to a parser.
 *
 * Note: docx/xlsx/pptx are ZIP containers, so both report 'zip' here. The
 * distinction is made by the caller using the declared extension, which is
 * safe once we know the container really is a ZIP.
 */
function sniff(buf) {
    if (buf.length === 0) return 'empty'

    // %PDF-
    if (startsWith(buf, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf'

    // ZIP local file header: PK\x03\x04 (also PK\x05\x06 empty, PK\x07\x08 spanned)
    if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) return 'zip'
    if (startsWith(buf, [0x50, 0x4b, 0x05, 0x06])) return 'zip'
    if (startsWith(buf, [0x50, 0x4b, 0x07, 0x08])) return 'zip'

    if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png'
    if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'jpeg'
    if (startsWith(buf, [0x47, 0x49, 0x46, 0x38])) return 'gif'
    // RIFF....WEBP
    if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) &&
        buf.length >= 12 && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp'

    // Reject anything containing a NUL byte in its head as binary. Real text
    // formats (txt/md/csv) never do, and this blocks binaries renamed to .txt.
    if (buf.includes(0x00)) return 'binary'

    return 'text'
}

async function detect(filePath) {
    const head = await readHead(filePath)
    return sniff(head)
}

const IMAGE_KINDS = new Set(['png', 'jpeg', 'gif', 'webp'])

function isImageKind(kind) {
    return IMAGE_KINDS.has(kind)
}

const IMAGE_MIME = {
    png: 'image/png',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
}

/**
 * Identify an image by its actual bytes.
 *
 * Returns { kind, mime } for a recognised raster image, or null for anything
 * else. Callers use null to reject and delete the upload: a declared
 * Content-Type of image/png proves nothing, so an SVG carrying script or a
 * polyglot payload would otherwise be stored and later served from /uploads.
 */
async function detectImageType(filePath) {
    const kind = await detect(filePath)
    if (!isImageKind(kind)) return null
    return { kind, mime: IMAGE_MIME[kind] }
}

module.exports = { detect, sniff, readHead, isImageKind, detectImageType, IMAGE_MIME }
