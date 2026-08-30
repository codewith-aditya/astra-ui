// ─── Canonical date-key helpers ───────────────────────────────────────────────
// Every daily/monthly usage counter in the codebase MUST use these functions.
//
// History: multiple implementations existed and disagreed. `models/User.js`
// produced `2026-8-30` (unpadded, local time) while `db.js` produced
// `2026-08-30` (padded, UTC). Any read that crossed implementations compared a
// stale key against a current one and silently reported usage as 0, resetting
// the user's quota.
//
// UTC is the reference so a counter cannot reset twice (or skip a reset) when
// the host timezone changes or DST shifts.
// ─────────────────────────────────────────────────────────────────────────────

/** @returns {string} `YYYY-MM-DD` in UTC */
function todayKey(date = new Date()) {
    return date.toISOString().slice(0, 10)
}

/** @returns {string} `YYYY-MM` in UTC */
function monthKey(date = new Date()) {
    return date.toISOString().slice(0, 7)
}

module.exports = {
    todayKey,
    monthKey,
    // Aliases matching the Mongoose instance-method names, so call sites can
    // use one import regardless of whether they hold a document.
    getTodayKey: todayKey,
    getMonthKey: monthKey,
}
