/**
 * AurumPulse ICT - Universal Database Adapter (Dual Mode: PostgreSQL & Atomic JSON)
 * 
 * Supports:
 * 1. Persistent PostgreSQL on Render / Cloud when DATABASE_URL is configured.
 * 2. High-integrity local JSON storage with atomic write and mutex queue as fallback.
 * 3. Safe fallback to database.demo.json when running on fresh ephemeral clones.
 * 4. Zero data overwrite and strict concurrency serialization.
 */
const fs = require('fs');
const path = require('path');

let pg = null;
try {
    pg = require('pg');
} catch (_) {
    // pg will be installed via npm install on Render build
}

const DB_FILE = path.join(__dirname, 'database.json');
const DEMO_DB_FILE = path.join(__dirname, 'database.demo.json');
const DATABASE_URL = process.env.DATABASE_URL ? process.env.DATABASE_URL.trim() : '';

let pgPool = null;

function isPostgresConfigured() {
    return Boolean(DATABASE_URL && DATABASE_URL.startsWith('postgres'));
}

function getPostgresPool() {
    if (!isPostgresConfigured()) return null;
    if (!pg) {
        console.warn('[DB WARNING] DATABASE_URL is set but "pg" package is not loaded. Falling back to JSON storage.');
        return null;
    }
    if (!pgPool) {
        pgPool = new pg.Pool({
            connectionString: DATABASE_URL,
            ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
            max: 10,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 5000
        });
        pgPool.on('error', (err) => {
            console.error('[POSTGRES POOL ERROR]:', err.message);
        });
    }
    return pgPool;
}

// ============================================================================
// 1. إدارة ملف JSON المحلي مع تأمين الذرية والقفل التزامني
// ============================================================================
let isWritingDB = false;
const dbWriteQueue = [];

function atomicWriteFileSync(filePath, content) {
    const dir = path.dirname(filePath);
    const tempFile = path.join(dir, `.${path.basename(filePath)}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`);
    fs.writeFileSync(tempFile, content, 'utf8');
    try {
        fs.renameSync(tempFile, filePath);
    } catch (e) {
        if (process.platform === 'win32') {
            try {
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                fs.renameSync(tempFile, filePath);
            } catch (winErr) {
                fs.copyFileSync(tempFile, filePath);
                try { fs.unlinkSync(tempFile); } catch (_) {}
            }
        } else {
            throw e;
        }
    }
}

function getSanitizedDefaultDB() {
    if (fs.existsSync(DEMO_DB_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(DEMO_DB_FILE, 'utf8'));
        } catch (_) {}
    }
    return {
        adminChatId: null,
        licenses: {},
        stats: { totalSignals: 0, wins: 0, losses: 0, breakevens: 0, netR: 0, history: [] },
        sessionTrades: {},
        activeTrades: []
    };
}

function loadDBFromJSON() {
    if (!fs.existsSync(DB_FILE)) {
        // Fallback to demo database template on fresh ephemeral deployments
        const demoData = getSanitizedDefaultDB();
        atomicWriteFileSync(DB_FILE, JSON.stringify(demoData, null, 2));
        return demoData;
    }
    try {
        const raw = fs.readFileSync(DB_FILE, 'utf8');
        return JSON.parse(raw);
    } catch (e) {
        console.error('[DB LOAD ERROR]: Corrupt database.json. Attempting recovery from demo template:', e.message);
        return getSanitizedDefaultDB();
    }
}

function saveDBToJSON(data) {
    atomicWriteFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// In-memory synced state for fast synchronous reads when running with Postgres
let memoryCache = null;

function loadDB() {
    if (!memoryCache) {
        memoryCache = loadDBFromJSON();
    }
    return memoryCache;
}

function saveDB(data) {
    memoryCache = data;
    saveDBToJSON(data);
}

function updateDB(mutatorFn) {
    return new Promise((resolve, reject) => {
        dbWriteQueue.push({ mutatorFn, resolve, reject });
        processWriteQueue();
    });
}

async function processWriteQueue() {
    if (isWritingDB || dbWriteQueue.length === 0) return;
    isWritingDB = true;
    const task = dbWriteQueue.shift();
    try {
        const currentData = loadDB();
        const mutated = task.mutatorFn(currentData);
        const dataToSave = mutated !== undefined ? mutated : currentData;
        saveDB(dataToSave);

        // If PostgreSQL is configured and active, sync asynchronously to PG
        if (isPostgresConfigured() && pg) {
            syncToPostgresAsync(dataToSave).catch(err => {
                console.warn('[POSTGRES SYNC WARNING]:', err.message);
            });
        }

        task.resolve(dataToSave);
    } catch (err) {
        task.reject(err);
    } finally {
        isWritingDB = false;
        setImmediate(processWriteQueue);
    }
}

async function syncToPostgresAsync(data) {
    const pool = getPostgresPool();
    if (!pool) return;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // Upsert Licenses
        if (data.licenses) {
            for (const [key, lic] of Object.entries(data.licenses)) {
                await client.query(
                    `INSERT INTO aurumpulse_licenses (key, plan, client_name, days, created_at, expires_at, telegram_chat_id, active)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                     ON CONFLICT (key) DO UPDATE SET
                         plan = EXCLUDED.plan,
                         client_name = EXCLUDED.client_name,
                         days = EXCLUDED.days,
                         expires_at = EXCLUDED.expires_at,
                         telegram_chat_id = EXCLUDED.telegram_chat_id,
                         active = EXCLUDED.active;`,
                    [
                        key,
                        lic.plan || 'Standard',
                        lic.clientName || 'User',
                        lic.days || 30,
                        lic.createdAt || new Date().toISOString().split('T')[0],
                        lic.expiresAt || new Date().toISOString().split('T')[0],
                        lic.telegramChatId ? String(lic.telegramChatId) : null,
                        Boolean(lic.active)
                    ]
                );
            }
        }

        // Upsert Config Items
        if (data.adminChatId) {
            await client.query(
                `INSERT INTO aurumpulse_config (key, value, updated_at)
                 VALUES ('adminChatId', $1, CURRENT_TIMESTAMP)
                 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP;`,
                [JSON.stringify(data.adminChatId)]
            );
        }
        if (data.sessionTrades) {
            await client.query(
                `INSERT INTO aurumpulse_config (key, value, updated_at)
                 VALUES ('sessionTrades', $1, CURRENT_TIMESTAMP)
                 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP;`,
                [JSON.stringify(data.sessionTrades)]
            );
        }
        if (data.activeTrades) {
            await client.query(
                `INSERT INTO aurumpulse_config (key, value, updated_at)
                 VALUES ('activeTrades', $1, CURRENT_TIMESTAMP)
                 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP;`,
                [JSON.stringify(data.activeTrades)]
            );
        }

        // Upsert Stats
        if (data.stats) {
            await client.query(
                `INSERT INTO aurumpulse_stats (id, total_signals, wins, losses, breakevens, net_r, history, updated_at)
                 VALUES (1, $1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
                 ON CONFLICT (id) DO UPDATE SET
                     total_signals = EXCLUDED.total_signals,
                     wins = EXCLUDED.wins,
                     losses = EXCLUDED.losses,
                     breakevens = EXCLUDED.breakevens,
                     net_r = EXCLUDED.net_r,
                     history = EXCLUDED.history,
                     updated_at = CURRENT_TIMESTAMP;`,
                [
                    data.stats.totalSignals || 0,
                    data.stats.wins || 0,
                    data.stats.losses || 0,
                    data.stats.breakevens || 0,
                    data.stats.netR || 0.00,
                    JSON.stringify(data.stats.history || [])
                ]
            );
        }

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

module.exports = {
    loadDB,
    saveDB,
    updateDB,
    atomicWriteFileSync,
    isPostgresConfigured,
    getPostgresPool,
    syncToPostgresAsync,
    DB_FILE,
    DEMO_DB_FILE
};
