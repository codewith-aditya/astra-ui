/**
 * AstraGPT Official Enterprise Email Templates
 * Styled in the exact clean, high-authority OpenAI / Stripe aesthetic
 * Tantra AI Labs
 */

// Public High-Speed HTTPS CDN Logo URL (prevents Gmail attachment badge/chips)
const LOGO_URL = 'https://rngczrsshweveslzuxkw.supabase.co/storage/v1/object/public/public-assets/logo.png'

// ─── Base Enterprise Layout (Clean White, High-Authority Aesthetic) ───────────
function openAiStyleWrapper({ contentHtml, footerNote = '' }) {
    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            body { margin: 0; padding: 0; background-color: #ffffff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #111827; -webkit-font-smoothing: antialiased; }
            a { color: #10a37f; text-decoration: underline; }
            p { font-size: 15px; line-height: 1.65; color: #222222; margin: 0 0 16px; }
            li { font-size: 15px; line-height: 1.65; color: #222222; margin-bottom: 6px; }
        </style>
    </head>
    <body style="margin: 0; padding: 0; background-color: #ffffff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #111827;">
        <table width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #ffffff; padding: 36px 20px;">
            <tr>
                <td align="left">
                    <table width="100%" max-width="600" style="max-width: 600px; margin: 0 auto; text-align: left;" cellpadding="0" cellspacing="0">
                        
                        <!-- Top Left Header: Official Logo + Tantra AI Labs -->
                        <tr>
                            <td style="padding-bottom: 28px; border-bottom: 1px solid #eaeaea;">
                                <table border="0" cellpadding="0" cellspacing="0">
                                    <tr>
                                        <td style="vertical-align: middle; padding-right: 12px;">
                                            <img src="${LOGO_URL}" alt="AstraGPT" width="38" height="38" style="display: block; border-radius: 8px;" />
                                        </td>
                                        <td style="vertical-align: middle;">
                                            <div style="font-size: 22px; font-weight: 800; letter-spacing: -0.5px; color: #000000; line-height: 1.1;">
                                                AstraGPT
                                            </div>
                                            <div style="font-size: 11px; font-weight: 600; color: #6b7280; letter-spacing: 0.8px; text-transform: uppercase; margin-top: 2px;">
                                                Tantra AI Labs
                                            </div>
                                        </td>
                                    </tr>
                                </table>
                            </td>
                        </tr>

                        <!-- Email Main Body Content -->
                        <tr>
                            <td style="padding-top: 30px; padding-bottom: 30px;">
                                ${contentHtml}
                            </td>
                        </tr>

                        <!-- Professional Sign-off & Footer -->
                        <tr>
                            <td style="padding-top: 22px; border-top: 1px solid #eaeaea; font-size: 13px; color: #6b7280; line-height: 1.6;">
                                <div style="font-weight: 600; color: #111827; margin-bottom: 2px;">
                                    The AstraGPT Team
                                </div>
                                <div>
                                    Tantra AI Labs · Trust & Safety Division
                                </div>
                                ${footerNote ? `
                                <div style="margin-top: 12px; font-size: 12px; color: #9ca3af;">
                                    ${footerNote}
                                </div>` : ''}
                            </td>
                        </tr>

                    </table>
                </td>
            </tr>
        </table>
    </body>
    </html>
    `
}

// ─── 1. Usage Policy Violation & Deactivation Warning (OpenAI Exact Style) ───
function violationNoticeEmail({ name = 'there', violationType = 'Cyber Abuse / Automated Exploitation', details = '' }) {
    const refCode = 'C-' + Math.random().toString(36).substring(2, 12).toUpperCase()

    const contentHtml = `
        <p>Hello${name && name !== 'there' ? ' ' + name : ''},</p>
        
        <p>
            <strong>AstraGPT</strong>'s <a href="https://astragpt.ai" style="color: #10a37f; text-decoration: underline;">terms</a> and <a href="https://astragpt.ai" style="color: #10a37f; text-decoration: underline;">policies</a> restrict the use of our services in a number of areas. We have identified activity in AstraGPT that is not permitted under our policies for:
        </p>

        <ul style="margin: 16px 0 20px 20px; padding: 0;">
            <li style="font-size: 15px; font-weight: 600; color: #111827;">${violationType}</li>
            ${details ? `<li style="font-size: 14px; color: #4b5563; font-weight: normal;">Details: ${details}</li>` : ''}
        </ul>

        <p>
            Please ensure you are using <strong>AstraGPT</strong> services in accordance with our <a href="https://astragpt.ai" style="color: #10a37f; text-decoration: underline;">Terms of Use</a> and our <a href="https://astragpt.ai" style="color: #10a37f; text-decoration: underline;">Usage Policies</a>. If you continue to violate these policies, we may take additional actions, including deactivating your access to our services.
        </p>

        <p>
            If you have questions or think there has been an error, you can reply directly to this notice or contact the Tantra AI Labs Trust & Safety team.
        </p>
    `

    return {
        subject: `AstraGPT - Usage Policy Violation & Deactivation Warning [${refCode}]`,
        html: openAiStyleWrapper({ contentHtml, footerNote: `Ref Case: ${refCode} · Tantra AI Labs Policy Enforcement` })
    }
}

// ─── 2. Account Deactivation Notice (OpenAI Style) ───────────────────────────
function suspensionNoticeEmail({ name = 'there', reason = 'Violation of AstraGPT Platform & Fair Use Policies' }) {
    const refCode = 'ACT-DEACT-' + Math.random().toString(36).substring(2, 10).toUpperCase()

    const contentHtml = `
        <p>Hello${name && name !== 'there' ? ' ' + name : ''},</p>

        <p>
            We are writing to notify you that your <strong>AstraGPT</strong> account has been <strong>deactivated</strong> due to violations of our <a href="https://astragpt.ai" style="color: #10a37f; text-decoration: underline;">Terms of Use</a> and <a href="https://astragpt.ai" style="color: #10a37f; text-decoration: underline;">Usage Policies</a>.
        </p>

        <div style="background: #fef2f2; border-left: 4px solid #ef4444; padding: 14px 18px; margin: 18px 0; border-radius: 4px;">
            <div style="font-size: 13.5px; font-weight: 700; color: #991b1b; margin-bottom: 4px;">Reason for Deactivation:</div>
            <div style="font-size: 14px; color: #111827;">${reason}</div>
        </div>

        <p>
            As a result of this action, access to your workspace, saved models, and API interactions have been terminated.
        </p>

        <p>
            If you believe this determination was made in error and wish to submit an appeal, please reply to this email with your case reference ID <strong>${refCode}</strong>.
        </p>
    `

    return {
        subject: `AstraGPT - Account Deactivation Notice [${refCode}]`,
        html: openAiStyleWrapper({ contentHtml, footerNote: `Reference ID: ${refCode} · Security & Moderation Team` })
    }
}

// ─── 3. OTP & Verification Code (Clean OpenAI / Claude Style) ────────────────
function otpEmail({ otp, purpose = 'signup' }) {
    const isReset = purpose === 'reset'
    const isLogin = purpose === 'login'
    
    let title = 'Your AstraGPT verification code'
    let message = 'Welcome to AstraGPT! Please use the following 6-digit code to complete your verification and access your workspace:'
    let subject = 'AstraGPT: Your verification code'

    if (isReset) {
        title = 'Reset your AstraGPT password'
        message = 'We received a request to reset the password for your AstraGPT account. Please use the verification code below:'
        subject = 'AstraGPT: Password Reset Code'
    } else if (isLogin) {
        title = 'Your AstraGPT Login Verification Code'
        message = 'A sign-in attempt was initiated for your AstraGPT account. Please enter the 6-digit verification code below to complete your login and secure your session:'
        subject = 'AstraGPT: Login Verification Code'
    }

    const contentHtml = `
        <h2 style="font-size: 20px; font-weight: 700; color: #000000; margin: 0 0 16px;">
            ${title}
        </h2>

        <p>
            ${message}
        </p>

        <div style="margin: 28px 0; text-align: left;">
            <div style="display: inline-block; background: #f4f4f5; border: 1px solid #e4e4e7; border-radius: 8px; padding: 16px 28px;">
                <span style="font-size: 32px; font-weight: 800; letter-spacing: 8px; color: #000000; font-family: 'SF Mono', Consolas, Monaco, monospace;">
                    ${otp}
                </span>
            </div>
        </div>

        <p style="font-size: 14px; color: #6b7280; margin-bottom: 8px;">
            ⏱️ This code will expire in <strong>5 minutes</strong>.
        </p>

        <p style="font-size: 13.5px; color: #6b7280;">
            If you did not initiate this login request, please change your password immediately.
        </p>
    `

    return {
        subject,
        html: openAiStyleWrapper({ contentHtml, footerNote: 'Tantra AI Labs · Automated Security & Identity Dispatch' })
    }
}

// ─── 4. Privacy Policy & Terms Update (Clean Memo Style) ─────────────────────
function privacyPolicyEmail({ name = 'there', summary = 'We have updated our terms to enhance user privacy, strengthen sandbox safety, and provide clearer data transparency.' }) {
    const contentHtml = `
        <h2 style="font-size: 20px; font-weight: 700; color: #000000; margin: 0 0 16px;">
            Important Updates to AstraGPT Terms & Privacy Policy
        </h2>

        <p>Hello${name && name !== 'there' ? ' ' + name : ''},</p>

        <p>
            We are writing to let you know that we have updated the <a href="https://astragpt.ai" style="color: #10a37f; text-decoration: underline;">Terms of Use</a> and <a href="https://astragpt.ai" style="color: #10a37f; text-decoration: underline;">Privacy Policy</a> for <strong>AstraGPT</strong>, effective immediately.
        </p>

        <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 18px 22px; margin: 20px 0;">
            <div style="font-size: 14px; font-weight: 700; color: #0f172a; margin-bottom: 6px;">Summary of Changes:</div>
            <p style="font-size: 14px; color: #334155; margin: 0; line-height: 1.6;">${summary}</p>
        </div>

        <p>
            These updates reflect our ongoing commitment to platform reliability, data security, and responsible AI usage across all models.
        </p>

        <p>
            You can review the full updated policies directly in your <a href="https://astragpt.ai" style="color: #10a37f; text-decoration: underline;">AstraGPT Workspace</a>.
        </p>
    `

    return {
        subject: 'Important: AstraGPT Terms of Use & Privacy Policy Update',
        html: openAiStyleWrapper({ contentHtml, footerNote: 'Tantra AI Labs · Official Policy Notice' })
    }
}

// ─── 5. Custom Announcement / Direct Notice (Clean Memo Style) ───────────────
function customNoticeEmail({ name = 'there', subject = 'Message from AstraGPT', message = '' }) {
    const contentHtml = `
        <h2 style="font-size: 20px; font-weight: 700; color: #000000; margin: 0 0 16px;">
            ${subject}
        </h2>

        <p>Hello${name && name !== 'there' ? ' ' + name : ''},</p>

        <div style="font-size: 15px; color: #222222; line-height: 1.7; margin: 20px 0; white-space: pre-wrap;">
${message}
        </div>

        <p>
            If you have any questions, feel free to reply to this email directly.
        </p>
    `

    return {
        subject,
        html: openAiStyleWrapper({ contentHtml, footerNote: 'Tantra AI Labs · Official Dispatch' })
    }
}

module.exports = {
    otpEmail,
    violationNoticeEmail,
    suspensionNoticeEmail,
    privacyPolicyEmail,
    customNoticeEmail,
}
