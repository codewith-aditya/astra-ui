const User = require('../models/User')
const Chat = require('../models/Chat')
const Message = require('../models/Message')
const Coupon = require('../models/Coupon')
const { getTodayKey } = require('../utils/dateKeys')

// ─── Coupon helpers ─────────────────────────────────────────────────────────

// Coerce to an upper-case string. Rejects objects, so a body of
// {"code":{"$ne":null}} cannot turn the lookup into an operator query that
// matches the first coupon in the collection.
function normalizeCouponCode(value) {
    if (typeof value !== 'string') return ''
    return value.trim().toUpperCase()
}

// `plans` is declared as [String] in the schema, but older documents may hold a
// single comma-separated string. The previous code called .split(',') on the
// field unconditionally, which throws on a real array.
function couponAllowsPlan(coupon, planId) {
    const raw = coupon?.plans
    const list = Array.isArray(raw)
        ? raw
        : typeof raw === 'string' ? raw.split(',') : []
    const allowed = list.map(p => String(p).trim()).filter(Boolean)
    if (allowed.length === 0) return false
    if (allowed.includes('any')) return true
    return allowed.includes(planId)
}


async function getDashboardStats(req, res) {
    try {
        const totalUsers = await User.countDocuments()
        const proUsers = await User.countDocuments({ plan: 'pro' })
        const proPlusUsers = await User.countDocuments({ plan: 'pro+' })
        const totalChats = await Chat.countDocuments()

        // Active Now: Users updated in the last 15 mins
        const fifteenMinsAgo = new Date(Date.now() - 15 * 60 * 1000)
        const activeNow = await User.countDocuments({ lastActive: { $gte: fifteenMinsAgo } })

        // Today's messages
        const todayStart = new Date()
        todayStart.setHours(0, 0, 0, 0)
        const todayMessages = await Message.countDocuments({ createdAt: { $gte: todayStart } })

        // ── Weekly chart: real message counts for last 7 days (Mon→Sun order) ──
        const weeklyChart = []
        for (let i = 6; i >= 0; i--) {
            const dayStart = new Date()
            dayStart.setHours(0, 0, 0, 0)
            dayStart.setDate(dayStart.getDate() - i)
            const dayEnd = new Date(dayStart)
            dayEnd.setDate(dayEnd.getDate() + 1)
            const count = await Message.countDocuments({
                createdAt: { $gte: dayStart, $lt: dayEnd },
                role: 'user',  // count user messages only (one per user turn)
            })
            weeklyChart.push(count)
        }

        res.json({
            stats: {
                totalUsers,
                proUsers,
                proPlusUsers,
                totalChats,
                todayMessages,
                activeNow,
                weeklyChart,  // [Mon, Tue, Wed, Thu, Fri, Sat, Sun] real counts
                revenue: `₹${(proUsers * 299) + (proPlusUsers * 799)}`
            }
        })
    } catch (err) {
        console.error('[Admin] getDashboardStats error:', err)
        res.status(500).json({ error: 'Failed to load stats' })
    }
}

async function getUsers(req, res) {
    try {
        // Fetch users, sorted by most recently active
        const users = await User.find().sort({ lastActive: -1 }).limit(100)

        // Must match User.getTodayKey() exactly or stored usage reads as stale.
        const todayKey = getTodayKey()

        const formattedUsers = users.map(u => {
            // Determine online status based on 15 min window
            const isOnline = u.lastActive > new Date(Date.now() - 15 * 60 * 1000)

            // Format "lastActive" to string for UI
            let timeAgo = 'Never'
            if (u.lastActive) {
                const diffMins = Math.floor((Date.now() - u.lastActive.getTime()) / 60000)
                if (diffMins < 60) timeAgo = `${diffMins} min ago`
                else if (diffMins < 1440) timeAgo = `${Math.floor(diffMins/60)}h ago`
                else timeAgo = `${Math.floor(diffMins/1440)}d ago`
            }

            // Requests today — auto-reset if stored day is stale
            const requestsToday = u.dailyUsageDate === todayKey ? (u.dailyUsage || 0) : 0

            // Joined date (short) — e.g. "12 Aug 2026"
            const joined = u.createdAt
                ? u.createdAt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
                : '—'

            return {
                id: u.userId,
                email: u.email || String(u.userId).slice(0, 8) + '...', // Fallback if no email
                plan: u.plan,
                banned: u.banned || false,
                chats: u.chatCount || 0,
                requests: requestsToday,          // requests made today
                joined,                            // formatted join date
                planExpiresAt: u.planExpiresAt || null,
                lastActive: timeAgo,
                status: isOnline ? 'online' : 'offline'
            }
        })

        res.json({ users: formattedUsers })
    } catch (err) {
        console.error('[Admin] getUsers error:', err)
        res.status(500).json({ error: 'Failed to load users' })
    }
}

async function updateUserPlan(req, res) {
    try {
        const { userId } = req.params
        const { plan } = req.body
        
        const validPlans = ['free', 'pro', 'pro+', 'ultra']
        if (!validPlans.includes(plan)) {
            return res.status(400).json({ error: 'Invalid plan' })
        }

        const user = await User.findOneAndUpdate(
            { userId },
            { plan },
            { new: true }
        )

        if (!user) return res.status(404).json({ error: 'User not found' })

        addLog('info', `Plan changed to "${plan}" for ${user.email || userId}`, userId)
        res.json({ success: true, user })
    } catch (err) {
        console.error('[Admin] updateUserPlan error:', err)
        res.status(500).json({ error: 'Failed to update plan' })
    }
}

async function deleteUser(req, res) {
    try {
        const { userId } = req.params
        await User.deleteOne({ userId })
        await Chat.deleteMany({ userId })
        res.json({ success: true })
    } catch (err) {
        console.error('[Admin] deleteUser error:', err)
        res.status(500).json({ error: 'Failed to delete user' })
    }
}

const nodemailer = require('nodemailer')
const {
    violationNoticeEmail,
    suspensionNoticeEmail,
    privacyPolicyEmail,
    customNoticeEmail,
} = require('../utils/emailTemplates')

function getAdminTransporter() {
    const host = process.env.SMTP_HOST || 'smtp.gmail.com'
    const port = parseInt(process.env.SMTP_PORT || '587', 10)
    const user = process.env.SMTP_USER || ''
    const pass = process.env.SMTP_PASS || ''

    return nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass },
        tls: { rejectUnauthorized: false }
    })
}

async function banUser(req, res) {
    try {
        const { userId } = req.params
        const { reason = 'Violation of platform security and fair use policies', sendEmail = true } = req.body

        const user = await User.findOneAndUpdate(
            { userId },
            { banned: true, banReason: reason },
            { new: true }
        )

        if (!user) return res.status(404).json({ error: 'User not found' })

        addLog('warn', `Banned user ${user.email || userId}. Reason: ${reason}`, userId)

        // Automatically dispatch suspension notice email if user has email
        if (sendEmail && user.email && (process.env.SMTP_USER || process.env.SMTP_PASS)) {
            try {
                const transporter = getAdminTransporter()
                const fromEmail = process.env.SMTP_FROM || process.env.SMTP_USER || 'adityawakharkar99@gmail.com'
                const mailData = suspensionNoticeEmail({
                    name: user.email.split('@')[0],
                    reason,
                })
                const path = require('path')
                const LOGO_PATH = path.join(__dirname, '../public/logo.png')
                await transporter.sendMail({
                    from: `"AstraGPT Trust & Safety" <${fromEmail}>`,
                    to: user.email,
                    subject: mailData.subject,
                    html: mailData.html,
                })
                addLog('info', `Suspension notice email sent to ${user.email}`, userId)
            } catch (mailErr) {
                console.error('[Admin] Failed to send suspension email:', mailErr)
            }
        }

        res.json({ success: true, user })
    } catch (err) {
        console.error('[Admin] banUser error:', err)
        res.status(500).json({ error: 'Failed to ban user' })
    }
}

async function sendNoticeToUser(req, res) {
    try {
        const { targetEmail, type = 'violation', subject, message, details, name } = req.body
        if (!targetEmail || !targetEmail.includes('@')) {
            return res.status(400).json({ error: 'Valid target email is required' })
        }

        const recipientName = name || targetEmail.split('@')[0]
        let mailData

        if (type === 'violation') {
            mailData = violationNoticeEmail({ name: recipientName, details: message || details })
            if (subject) mailData.subject = subject
        } else if (type === 'suspension') {
            mailData = suspensionNoticeEmail({ name: recipientName, reason: message || details })
            if (subject) mailData.subject = subject
        } else if (type === 'privacy_update') {
            mailData = privacyPolicyEmail({ name: recipientName, summary: message })
            if (subject) mailData.subject = subject
        } else {
            mailData = customNoticeEmail({ name: recipientName, subject: subject || 'Official Message from AstraGPT', message })
        }

        const transporter = getAdminTransporter()
        const fromEmail = process.env.SMTP_FROM || process.env.SMTP_USER || 'adityawakharkar99@gmail.com'

        await transporter.sendMail({
            from: `"AstraGPT by Tantra AI Labs" <${fromEmail}>`,
            to: targetEmail.trim(),
            subject: mailData.subject,
            html: mailData.html,
        })

        addLog('info', `Dispatched "${type}" notice email to ${targetEmail}`, 'admin')
        return res.json({ success: true, message: `Branded ${type} notice sent to ${targetEmail}` })
    } catch (err) {
        console.error('[Admin] sendNoticeToUser error:', err)
        return res.status(500).json({ error: 'Failed to dispatch email notice' })
    }
}

// ─── Coupons ───

async function getCoupons(req, res) {
    try {
        const coupons = await Coupon.find().sort({ createdAt: -1 })
        res.json({ coupons })
    } catch (err) {
        console.error('[Admin] getCoupons error:', err)
        res.status(500).json({ error: 'Failed to fetch coupons' })
    }
}

async function createCoupon(req, res) {
    try {
        const {
            code, discount, plans, maxUses, label,
            validityDays, dailyLimit, credits, grantPlan,
            expiresAt, maxUsesPerUser
        } = req.body

        const newCoupon = await Coupon.create({
            code: code.toUpperCase(),
            label: label || '',
            discount: discount ?? 100,
            plans: Array.isArray(plans) ? plans : (plans || 'pro').split(',').map(p => p.trim()),
            grantPlan: grantPlan || null,
            validityDays: validityDays ? parseInt(validityDays) : null,
            expiresAt: expiresAt ? new Date(expiresAt) : null,
            dailyLimit: dailyLimit ? parseInt(dailyLimit) : null,
            credits: credits ? parseInt(credits) : 0,
            maxUses: parseInt(maxUses) || 100,
            maxUsesPerUser: parseInt(maxUsesPerUser) || 1,
        })
        addLog('info', `Coupon "${code.toUpperCase()}" created (${discount}% off, ${validityDays ? validityDays + 'd validity' : 'permanent'}, max ${maxUses} uses)`, '-')
        res.json({ coupon: newCoupon })
    } catch (err) {
        console.error('[Admin] createCoupon error:', err)
        res.status(500).json({ error: 'Failed to create coupon' })
    }
}

async function toggleCoupon(req, res) {
    try {
        const { code } = req.params
        const coupon = await Coupon.findOne({ code })
        if (!coupon) return res.status(404).json({ error: 'Coupon not found' })
        
        coupon.active = !coupon.active
        await coupon.save()
        res.json({ coupon })
    } catch (err) {
        console.error('[Admin] toggleCoupon error:', err)
        res.status(500).json({ error: 'Failed to toggle coupon' })
    }
}

async function deleteCoupon(req, res) {
    try {
        const { code } = req.params
        await Coupon.deleteOne({ code })
        res.json({ success: true })
    } catch (err) {
        console.error('[Admin] deleteCoupon error:', err)
        res.status(500).json({ error: 'Failed to delete coupon' })
    }
}

// ─── Public: Validate Coupon (no admin auth needed) ───

async function validateCoupon(req, res) {
    try {
        const code = normalizeCouponCode(req.body?.code)
        if (!code) return res.status(400).json({ error: 'Coupon code required' })

        const coupon = await Coupon.findOne({ code })
        if (!coupon) return res.status(404).json({ error: 'Invalid or expired coupon code' })
        if (!coupon.active) return res.status(400).json({ error: 'This coupon is no longer active' })
        if (coupon.expiresAt && new Date() > coupon.expiresAt) {
            return res.status(400).json({ error: 'This coupon has expired' })
        }
        if (coupon.uses >= coupon.maxUses) return res.status(400).json({ error: 'This coupon has reached its usage limit' })

        res.json({
            valid: true,
            code: coupon.code,
            discount: coupon.discount,
            plans: coupon.plans,
        })
    } catch (err) {
        console.error('[Coupon] validateCoupon error:', err)
        res.status(500).json({ error: 'Failed to validate coupon' })
    }
}

// ─── Public: Redeem Coupon (upgrades user plan) ───

// The redeeming user is taken from the verified token, never from the request
// body. Previously `userId` came from the body, so any caller could grant a
// paid plan to an arbitrary account.
async function redeemCoupon(req, res) {
    try {
        const userId = req.userId
        if (!userId) return res.status(401).json({ error: 'Authentication required' })

        const code = normalizeCouponCode(req.body?.code)
        const planId = typeof req.body?.planId === 'string' ? req.body.planId.trim() : ''
        if (!code || !planId) {
            return res.status(400).json({ error: 'code and planId are required' })
        }

        const coupon = await Coupon.findOne({ code })
        if (!coupon) return res.status(404).json({ error: 'Invalid or expired coupon code' })
        if (!coupon.active) return res.status(400).json({ error: 'This coupon is no longer active' })
        if (coupon.expiresAt && new Date() > coupon.expiresAt) {
            return res.status(400).json({ error: 'This coupon has expired' })
        }
        if (coupon.uses >= coupon.maxUses) return res.status(400).json({ error: 'This coupon has reached its usage limit' })
        if (Array.isArray(coupon.usedBy) && coupon.usedBy.includes(userId)) {
            return res.status(400).json({ error: 'You have already used this coupon' })
        }

        if (!couponAllowsPlan(coupon, planId)) {
            return res.status(400).json({ error: 'This coupon is not valid for this plan' })
        }

        // Only 100% discount coupons grant free upgrade
        if (coupon.discount < 100) {
            return res.status(400).json({ error: 'Partial discount coupons are not supported yet. Use a 100% coupon.' })
        }

        // Claim the coupon FIRST, conditionally. Incrementing after granting the
        // plan allowed concurrent requests to redeem a single-use coupon many
        // times; this update only matches while the coupon is still claimable,
        // so exactly one racing request wins.
        const claimed = await Coupon.findOneAndUpdate(
            {
                code: coupon.code,
                active: true,
                usedBy: { $ne: userId },
                $expr: { $lt: ['$uses', '$maxUses'] },
            },
            { $inc: { uses: 1 }, $push: { usedBy: userId } },
            { new: true }
        )
        if (!claimed) {
            return res.status(409).json({ error: 'This coupon is no longer available' })
        }

        const planExpiresAt = coupon.validityDays
            ? new Date(Date.now() + coupon.validityDays * 86_400_000)
            : null

        const user = await User.findOneAndUpdate(
            { userId },
            { plan: planId, planExpiresAt },
            { upsert: true, new: true }
        )

        addLog('info', `Coupon "${coupon.code}" redeemed → plan upgraded to "${planId}"`, userId)

        res.json({
            success: true,
            plan: planId,
            planExpiresAt: user.planExpiresAt,
            message: `Plan upgraded to ${planId} successfully!`
        })
    } catch (err) {
        console.error('[Coupon] redeemCoupon error:', err)
        res.status(500).json({ error: 'Failed to redeem coupon' })
    }
}

async function banUser(req, res) {
    try {
        const { userId } = req.params
        const { banned = true, reason = 'Violation of platform security and fair use policies', sendEmail = true } = req.body

        const user = await User.findOneAndUpdate(
            { userId },
            { banned: !!banned, banReason: banned ? reason : '' },
            { new: true }
        )

        if (!user) return res.status(404).json({ error: 'User not found' })

        addLog(banned ? 'warn' : 'info', `User ${user.email || userId} ${banned ? 'BANNED' : 'UNBANNED'}. Reason: ${reason}`, userId)

        // Automatically dispatch suspension notice email if user banned
        if (banned && sendEmail && user.email) {
            try {
                const transporter = getAdminTransporter()
                const fromEmail = process.env.SMTP_FROM || process.env.SMTP_USER || 'security@astragpt.ai'
                await transporter.sendMail({
                    from: `"AstraGPT Security · Aditya Wakharkar" <${fromEmail}>`,
                    to: user.email,
                    subject: 'AstraGPT Account Suspension Notice',
                    html: suspensionNoticeEmail({
                        name: user.email.split('@')[0],
                        reason,
                    })
                })
                addLog('info', `Suspension notice email dispatched to ${user.email}`, userId)
            } catch (mailErr) {
                console.error('[Admin] Failed to send suspension email:', mailErr)
            }
        }

        res.json({ success: true, user: { id: user.userId, banned: user.banned, email: user.email } })
    } catch (err) {
        console.error('[Admin] banUser error:', err)
        res.status(500).json({ error: 'Failed to update ban status' })
    }
}

// ─── In-Memory Logs (captures admin actions + errors) ───

const MAX_LOGS = 200
const adminLogs = []

function addLog(level, msg, user = '-') {
    const now = new Date()
    const time = now.toTimeString().slice(0, 8)
    adminLogs.unshift({ time, level, msg, user, timestamp: now.getTime() })
    if (adminLogs.length > MAX_LOGS) adminLogs.length = MAX_LOGS
}

// Expose addLog so other parts of the app can push logs
module.exports.addLog = addLog

async function getLogs(req, res) {
    try {
        const { level } = req.query
        let filtered = adminLogs
        if (level && level !== 'all') {
            filtered = adminLogs.filter(l => l.level === level)
        }
        res.json({ logs: filtered.slice(0, 100) })
    } catch (err) {
        console.error('[Admin] getLogs error:', err)
        res.status(500).json({ error: 'Failed to fetch logs' })
    }
}

module.exports = {
    getDashboardStats,
    getUsers,
    updateUserPlan,
    deleteUser,
    banUser,
    sendNoticeToUser,
    getCoupons,
    createCoupon,
    toggleCoupon,
    deleteCoupon,
    validateCoupon,
    redeemCoupon,
    getLogs,
    addLog
}
