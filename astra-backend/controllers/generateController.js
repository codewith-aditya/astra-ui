const PDFDocument = require('pdfkit')
const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx')
const archiver = require('archiver')
const path = require('path')
const fs = require('fs')
const os = require('os')
const logger = require('../utils/logger')

// Content-Disposition must not carry raw user input: a quote or newline in the
// filename lets the caller inject additional header content.
function safeFilename(name, fallback = 'document') {
    const cleaned = String(name || '')
        .replace(/[\r\n"]/g, '')
        .replace(/[^A-Za-z0-9_\-. ]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 100)
    return cleaned || fallback
}

// Normalise an archive entry path so it can never escape the archive root.
//
// Resolved with an explicit segment stack rather than by string replacement.
// A regex that strips "../" is order-dependent and misses layered forms such as
// "....//" (which becomes "../" after one pass), so traversal is resolved here
// the same way a filesystem would: walk the segments and pop on "..", clamping
// at the root so a leading ".." cannot rise above it.
function sanitizeArchivePath(raw) {
    if (typeof raw !== 'string' || !raw.trim()) return null

    const normalized = raw
        .replace(/\\/g, '/')        // Windows separators
        .replace(/^[A-Za-z]:/, '')  // drive letter
        .trim()

    const stack = []
    for (const segment of normalized.split('/')) {
        if (!segment || segment === '.') continue
        if (segment === '..') {
            stack.pop()             // clamped: popping an empty stack is a no-op
            continue
        }
        // Reject NUL and control characters outright.
        if (/[\u0000-\u001f]/.test(segment)) return null
        // A segment of only dots ("...", "....") is never a real filename, and
        // some extractors normalise it back into traversal. Drop it.
        if (/^\.+$/.test(segment)) continue
        stack.push(segment)
    }

    return stack.length ? stack.join('/') : null
}

// ─── Helper: parse markdown-like text into lines ─────────────────────────────
function parseLines(content) {
    return (content || '').split('\n')
}

// ─── 1. PDF Generator ─────────────────────────────────────────────────────────
function generatePDF(res, filename, content) {
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`)

    const doc = new PDFDocument({ margin: 50 })
    doc.pipe(res)

    const lines = parseLines(content)
    let first = true

    for (const line of lines) {
        if (line.startsWith('# ')) {
            if (!first) doc.moveDown(0.5)
            doc.fontSize(22).font('Helvetica-Bold').text(line.replace(/^# /, ''), { underline: false })
            doc.moveDown(0.3)
            first = false
        } else if (line.startsWith('## ')) {
            doc.moveDown(0.4)
            doc.fontSize(16).font('Helvetica-Bold').text(line.replace(/^## /, ''))
            doc.moveDown(0.2)
        } else if (line.startsWith('### ')) {
            doc.moveDown(0.3)
            doc.fontSize(13).font('Helvetica-Bold').text(line.replace(/^### /, ''))
            doc.moveDown(0.1)
        } else if (line.startsWith('- ') || line.startsWith('* ')) {
            doc.fontSize(11).font('Helvetica').text(`  • ${line.replace(/^[-*] /, '')}`)
        } else if (line.startsWith('```')) {
            // skip code fence markers
        } else if (line.trim() === '') {
            doc.moveDown(0.3)
        } else {
            // Bold (**text**) inline support
            const boldRegex = /\*\*(.+?)\*\*/g
            let lastIndex = 0
            let match
            let hasInline = false

            const parts = []
            while ((match = boldRegex.exec(line)) !== null) {
                if (match.index > lastIndex) parts.push({ text: line.slice(lastIndex, match.index), bold: false })
                parts.push({ text: match[1], bold: true })
                lastIndex = match.index + match[0].length
                hasInline = true
            }
            if (lastIndex < line.length) parts.push({ text: line.slice(lastIndex), bold: false })

            if (hasInline) {
                let x = doc.x
                let y = doc.y
                for (const part of parts) {
                    doc.fontSize(11).font(part.bold ? 'Helvetica-Bold' : 'Helvetica').text(part.text, { continued: true })
                }
                doc.text('') // end continued
            } else {
                doc.fontSize(11).font('Helvetica').text(line)
            }
        }
    }

    doc.end()
}

// ─── 2. DOCX Generator ───────────────────────────────────────────────────────
async function generateDOCX(res, filename, content) {
    const lines = parseLines(content)
    const children = []

    for (const line of lines) {
        if (line.startsWith('# ')) {
            children.push(new Paragraph({ text: line.replace(/^# /, ''), heading: HeadingLevel.HEADING_1 }))
        } else if (line.startsWith('## ')) {
            children.push(new Paragraph({ text: line.replace(/^## /, ''), heading: HeadingLevel.HEADING_2 }))
        } else if (line.startsWith('### ')) {
            children.push(new Paragraph({ text: line.replace(/^### /, ''), heading: HeadingLevel.HEADING_3 }))
        } else if (line.startsWith('- ') || line.startsWith('* ')) {
            children.push(new Paragraph({
                children: [new TextRun({ text: `• ${line.replace(/^[-*] /, '')}` })],
            }))
        } else if (line.trim() === '') {
            children.push(new Paragraph({ text: '' }))
        } else {
            // Handle **bold** inline
            const boldRegex = /\*\*(.+?)\*\*/g
            const runs = []
            let lastIndex = 0
            let match
            while ((match = boldRegex.exec(line)) !== null) {
                if (match.index > lastIndex) runs.push(new TextRun({ text: line.slice(lastIndex, match.index) }))
                runs.push(new TextRun({ text: match[1], bold: true }))
                lastIndex = match.index + match[0].length
            }
            if (lastIndex < line.length) runs.push(new TextRun({ text: line.slice(lastIndex) }))
            children.push(new Paragraph({ children: runs.length ? runs : [new TextRun({ text: line })] }))
        }
    }

    const doc = new Document({ sections: [{ properties: {}, children }] })
    const buffer = await Packer.toBuffer(doc)

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.docx"`)
    res.send(buffer)
}

// ─── 3. TXT Generator ────────────────────────────────────────────────────────
function generateTXT(res, filename, content) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.txt"`)
    res.send(content)
}

// ─── 4. Markdown Generator ───────────────────────────────────────────────────
function generateMD(res, filename, content) {
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.md"`)
    res.send(content)
}

// ─── 5. CSV Generator ────────────────────────────────────────────────────────
function generateCSV(res, filename, content) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`)
    res.send(content)
}

// ─── 6. ZIP Generator (multiple files) ───────────────────────────────────────
function generateZIP(res, filename, files) {
    // files: [{ name: 'foo.txt', content: '...' }, ...]
    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.zip"`)

    const archive = archiver('zip', { zlib: { level: 9 } })
    archive.pipe(res)

    for (const f of files) {
        archive.append(Buffer.from(f.content, 'utf-8'), { name: f.name })
    }

    archive.finalize()
}

// ─── 7. Project ZIP Generator (folder structure) ─────────────────────────────
// POST /generate-project
// Body: { project_name: string, files: [{ path: string, content: string }] }
// Returns: ZIP file as stream download
exports.generateProject = (req, res) => {
    try {
        const { project_name, files } = req.body

        if (!project_name || typeof project_name !== 'string') {
            return res.status(400).json({ error: 'project_name is required' })
        }
        if (!Array.isArray(files) || files.length === 0) {
            return res.status(400).json({ error: 'files array is required and must not be empty' })
        }

        const safeName = project_name.replace(/[^a-zA-Z0-9_\-]/g, '-').toLowerCase()

        res.setHeader('Content-Type', 'application/zip')
        res.setHeader('Content-Disposition', `attachment; filename="${safeName}.zip"`)

        const archive = archiver('zip', { zlib: { level: 9 } })
        archive.on('error', (err) => {
            logger.error('[generate-project] archiver error', err)
            if (!res.headersSent) {
                res.status(500).json({ error: { message: 'Failed to build archive', code: 'archive_failed' } })
            } else {
                res.destroy()
            }
        })

        archive.pipe(res)

        let count = 0
        for (const file of files) {
            if (!file.path || typeof file.content !== 'string') continue
            // Prevent path traversal. A single non-global-loop replace was
            // insufficient: '....//' collapses to '../' after one pass, so the
            // sanitiser has to run until the string stops changing.
            const safePath = sanitizeArchivePath(file.path)
            if (!safePath) continue
            // Put all files inside project_name/ folder in zip
            archive.append(Buffer.from(file.content, 'utf-8'), { name: `${safeName}/${safePath}` })
            count++
        }

        if (count === 0) {
            archive.abort()
            return res.status(400).json({ error: 'No valid files provided' })
        }

        archive.finalize()
        console.log(`[generate-project] Zipped ${count} files for "${safeName}"`)

    } catch (err) {
        logger.error('[generate-project] failed', err)
        if (!res.headersSent) {
            res.status(500).json({ error: { message: 'Failed to generate project', code: 'generate_failed' } })
        } else {
            res.destroy()
        }
    }
}
// POST /api/generate
// Body: { format: 'pdf'|'docx'|'txt'|'md'|'csv'|'zip', filename: string, content: string, files?: [{name,content}] }
exports.generateFile = async (req, res) => {
    try {
        const { format, filename = 'document', content = '', files = [] } = req.body

        if (!format) return res.status(400).json({ error: 'format is required' })

        const safeName = filename.replace(/[^a-zA-Z0-9_\-. ]/g, '_').trim() || 'document'

        switch (format.toLowerCase()) {
            case 'pdf':
                return generatePDF(res, safeName, content)
            case 'docx':
                return await generateDOCX(res, safeName, content)
            case 'txt':
                return generateTXT(res, safeName, content)
            case 'md':
            case 'markdown':
                return generateMD(res, safeName, content)
            case 'csv':
                return generateCSV(res, safeName, content)
            case 'zip':
                // If files array provided use it, else wrap content as single file
                const zipFiles = files.length > 0 ? files : [{ name: `${safeName}.txt`, content }]
                return generateZIP(res, safeName, zipFiles)
            default:
                return res.status(400).json({ error: `Unsupported format: ${format}` })
        }
    } catch (err) {
        logger.error('[/api/generate] failed', err)
        if (!res.headersSent) {
            return res.status(500).json({ error: { message: 'Failed to generate file', code: 'generate_failed' } })
        }
        res.destroy()
    }
}

// Exported for unit tests only: these two sanitizers are the zip-slip and
// header-injection boundaries, so they are asserted directly.
exports.__test = { safeFilename, sanitizeArchivePath }
