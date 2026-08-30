// ═══════════════════════════════════════════════════════════════════════════
//  Test harness.
//
//  Boots an in-memory MongoDB so the suite never touches the real database,
//  and installs a complete, valid environment before any application module is
//  required (config/env.js validates at load time and throws on bad config).
// ═══════════════════════════════════════════════════════════════════════════

const path = require('path')

let mongod = null

/**
 * Install a deterministic test environment.
 *
 * MUST be called before requiring anything under the application root: env
 * validation runs at module load, and several modules capture config values in
 * module scope.
 */
function applyTestEnv() {
    // Prevent the developer's real .env from bleeding into the suite. dotenv
    // never overwrites an existing value, so setting these first wins.
    process.env.NODE_ENV = 'test'
    process.env.DOTENV_CONFIG_PATH = path.join(__dirname, 'nonexistent.env')

    // Deliberately not the committed value the env validator rejects.
    process.env.JWT_SECRET = 'test-jwt-secret-value-at-least-32-chars-long'
    process.env.ADMIN_SECRET = 'test-admin-secret-16plus'
    process.env.MONGO_URI = 'mongodb://127.0.0.1:27017/astragpt-test-placeholder'
    process.env.ALLOWED_ORIGINS = 'http://localhost:5173'
    process.env.PORT = '0'

    // Keep outbound calls and mail out of the suite.
    delete process.env.SMTP_HOST
    delete process.env.SMTP_USER
    delete process.env.SMTP_PASS
    delete process.env.UPSTASH_REDIS_REST_URL
    delete process.env.UPSTASH_REDIS_REST_TOKEN
    delete process.env.SUPABASE_URL
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    delete process.env.NEXUSIFY_API_KEY
    delete process.env.AISUBSCRIPTION_API_KEY
    delete process.env.ENABLE_TOOLS

    // Rate limits would otherwise reject the repeated calls a suite makes.
    process.env.RATE_LIMIT_DISABLED = '1'
}

/** Start an in-memory mongod and point mongoose at it. */
async function startMemoryMongo() {
    const { MongoMemoryServer } = require('mongodb-memory-server')
    const mongoose = require('mongoose')

    mongod = await MongoMemoryServer.create()
    const uri = mongod.getUri('astragpt-test')
    process.env.MONGO_URI = uri

    await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 })
    return uri
}

async function stopMemoryMongo() {
    const mongoose = require('mongoose')
    try {
        await mongoose.connection.dropDatabase()
    } catch { /* database may already be gone */ }
    await mongoose.disconnect()
    if (mongod) {
        await mongod.stop()
        mongod = null
    }
}

/** Remove all documents between tests without tearing down the connection. */
async function clearCollections() {
    const mongoose = require('mongoose')
    const { collections } = mongoose.connection
    await Promise.all(
        Object.values(collections).map(c => c.deleteMany({}))
    )
}

module.exports = {
    applyTestEnv,
    startMemoryMongo,
    stopMemoryMongo,
    clearCollections,
}
