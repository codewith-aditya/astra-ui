// ─── Supabase token verification ──────────────────────────────────────────────
// Used only to prove identity for tokens issued by Supabase. Plan always comes
// from MongoDB (the coupon system owns it) — never overwritten from Supabase.
//
// This module NEVER falls back to trusting a raw bearer value. If Supabase is
// unreachable or unconfigured, verification fails closed.
// ─────────────────────────────────────────────────────────────────────────────
const env = require('../config/env')
const logger = require('../utils/logger')

let supabaseClient = null
let initAttempted = false

function getSupabase() {
    if (supabaseClient) return supabaseClient
    if (initAttempted) return null
    initAttempted = true

    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
        logger.info('Supabase not configured — Supabase token verification disabled')
        return null
    }
    try {
        const { createClient } = require('@supabase/supabase-js')
        supabaseClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
            auth: { autoRefreshToken: false, persistSession: false },
        })
        logger.info('Supabase client initialized — token identity verification active')
        return supabaseClient
    } catch (err) {
        // Missing dependency is a deployment fault, not something to paper over.
        logger.error('@supabase/supabase-js is required but not installed', { err: err.message })
        return null
    }
}

// Returns { userId } for a valid token, or null. Never throws.
async function verifySupabaseJWT(token) {
    const supabase = getSupabase()
    if (!supabase || !token) return null

    try {
        const { data, error } = await supabase.auth.getUser(token)
        if (error || !data?.user) return null
        return { userId: data.user.id, email: data.user.email || '' }
    } catch (err) {
        logger.warn('Supabase token verification failed', { err: err.message })
        return null
    }
}

function isSupabaseConfigured() {
    return Boolean(getSupabase())
}

module.exports = { verifySupabaseJWT, isSupabaseConfigured }
