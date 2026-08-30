// ═══════════════════════════════════════════════════════════════════════════
//  MongoDB connection management.
//
//  Previously this module opened TWO extra connections (`atlasConn`,
//  `localConn`) on top of the default connection that every model in models/
//  actually uses, and defined a `dualSave`/`dualRead` failover layer plus
//  duplicate User/Chat/Message schemas. Nothing imported any of it except the
//  connect function, so ~100 lines were dead while still holding two idle
//  connection pools open for the process lifetime. Worse, the duplicate
//  schemas had *different* fields (no email/passwordHash/banned/mfaSecret) and
//  an incompatible getTodayKey format, so any code that reached them would
//  read and write subtly wrong data.
//
//  There is now exactly one connection — the default one, which is what
//  mongoose.model() in models/*.js binds to.
// ═══════════════════════════════════════════════════════════════════════════

const mongoose = require('mongoose')
const env = require('./config/env')
const logger = require('./utils/logger')

let connected = false

/**
 * Open the single application connection. Rejects on failure so the caller can
 * decide whether to abort startup — the previous version only logged a warning,
 * so the server would happily start with no database and 500 on every request.
 */
async function connectDatabase() {
    mongoose.set('strictQuery', true)

    // Reject unknown/operator-shaped keys rather than silently stripping them,
    // so a validation gap surfaces as an error instead of a wrong query.
    mongoose.set('sanitizeFilter', true)

    mongoose.connection.on('connected', () => {
        connected = true
        logger.info('MongoDB connected')
    })
    mongoose.connection.on('disconnected', () => {
        connected = false
        logger.warn('MongoDB disconnected')
    })
    mongoose.connection.on('error', err => {
        logger.error('MongoDB error', { error: err.message })
    })

    await mongoose.connect(env.MONGO_URI, {
        serverSelectionTimeoutMS: env.MONGO_TIMEOUT_MS,
        maxPoolSize: env.MONGO_MAX_POOL,
        minPoolSize: 0,
        socketTimeoutMS: 45_000,
        retryWrites: true,
    })

    connected = true

    // Build indexes declared in the schemas. In production this is usually a
    // deploy-time step, but the collections here are small enough that doing it
    // at boot is safe and keeps environments consistent.
    if (env.MONGO_AUTO_INDEX) {
        await Promise.allSettled(
            Object.values(mongoose.models).map(m => m.createIndexes())
        )
    }

    return mongoose.connection
}

async function disconnectDatabase() {
    if (mongoose.connection.readyState === 0) return
    await mongoose.connection.close(false)
    connected = false
    logger.info('MongoDB connection closed')
}

/** readyState: 0 disconnected, 1 connected, 2 connecting, 3 disconnecting. */
function getDbStatus() {
    return {
        connected,
        readyState: mongoose.connection.readyState,
        name: mongoose.connection.name || null,
    }
}

function isHealthy() {
    return mongoose.connection.readyState === 1
}

module.exports = { connectDatabase, disconnectDatabase, getDbStatus, isHealthy }
