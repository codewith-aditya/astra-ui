// ═══════════════════════════════════════════════════════════════════════════
//  Mail transport — single shared nodemailer instance.
//
//  Replaces two near-identical transporter factories that each disabled TLS
//  certificate verification.
// ═══════════════════════════════════════════════════════════════════════════

const nodemailer = require('nodemailer')
const env = require('../config/env')
const logger = require('../utils/logger')

let transporter = null

function getTransporter() {
    if (transporter) return transporter

    if (!env.SMTP_USER || !env.SMTP_PASS) {
        logger.warn('mailer.not_configured', { detail: 'SMTP_USER/SMTP_PASS unset; mail delivery disabled' })
        return null
    }

    transporter = nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_PORT === 465,
        auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
        // Certificate verification stays on. The previous code set
        // rejectUnauthorized:false, which silently accepted any certificate and
        // exposed SMTP credentials to interception.
        requireTLS: env.SMTP_PORT !== 465,
        pool: true,
        maxConnections: 5,
        maxMessages: 100,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
    })

    return transporter
}

/**
 * Send a mail. Resolves even when SMTP is unconfigured so that a delivery
 * outage cannot block a signup flow; callers that require delivery should
 * check the returned `delivered` flag.
 */
async function sendMail({ to, subject, html, text }) {
    const tx = getTransporter()
    if (!tx) return { delivered: false, reason: 'smtp_not_configured' }

    try {
        const info = await tx.sendMail({
            from: `"AstraGPT" <${env.SMTP_FROM || env.SMTP_USER}>`,
            to,
            subject,
            html,
            text,
        })
        logger.info('mailer.sent', { messageId: info.messageId })
        return { delivered: true, messageId: info.messageId }
    } catch (err) {
        // Never surface SMTP internals to the caller.
        logger.error('mailer.failed', { error: err.message })
        return { delivered: false, reason: 'send_failed' }
    }
}

async function verifyTransport() {
    const tx = getTransporter()
    if (!tx) return { ok: false, reason: 'smtp_not_configured' }
    try {
        await tx.verify()
        return { ok: true }
    } catch (err) {
        return { ok: false, reason: err.message }
    }
}

module.exports = { sendMail, verifyTransport }
