const express = require('express')
const router = express.Router()
const adminCtrl = require('../controllers/adminController')
const { adminGuard } = require('../middleware/adminGuard')
const { limiters } = require('../middleware/rateLimit')

// Every admin route requires the shared admin guard, which fails closed when
// ADMIN_SECRET is unset and compares in constant time. Two other route files
// previously rolled their own `if (adminSecret && ...)` variant that skipped
// the check entirely when the secret was missing or empty.
router.use(adminGuard, limiters.admin)

// ─── Dashboard Stats ───
router.get('/stats', adminCtrl.getDashboardStats)

// ─── Users Handling ───
router.get('/users', adminCtrl.getUsers)
router.post('/users/:userId/plan', adminCtrl.updateUserPlan)
router.post('/users/:userId/ban', adminCtrl.banUser)
router.delete('/users/:userId', adminCtrl.deleteUser)
router.post('/send-notice', adminCtrl.sendNoticeToUser)

// ─── Coupons Handling ───
router.get('/coupons', adminCtrl.getCoupons)
router.post('/coupons', adminCtrl.createCoupon)
router.post('/coupons/:code/toggle', adminCtrl.toggleCoupon)
router.delete('/coupons/:code', adminCtrl.deleteCoupon)

// ─── Logs ───
router.get('/logs', adminCtrl.getLogs)

module.exports = router
