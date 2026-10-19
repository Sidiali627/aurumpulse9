/**
 * AurumPulse ICT - Universal Database Adapter (Dual Mode: PostgreSQL & Atomic JSON)
 * 
 * Verifies:
 * 1. Reads process.env.DATABASE_URL dynamically on connect.
 * 2. Connects to PostgreSQL, safely initializes schema (idempotent, zero data loss).
 * 3. Loads persistent licenses, config, active trades, and stats from PostgreSQL on boot.
 * 4. Serializes all mutations through mutex queue and syncs to PostgreSQL and local JSON.
 * 5. Provides safe fallback to local JSON storage when DATABASE_URL is unconfigured.
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

let pgPool = null;

function getDatabaseUrl() {
    return process.env.DATABASE_URL ? process.env.DATABASE_URL.trim() : '';
}

function isPostgresConfigured() {
    const url = getDatabaseUrl();
    return Boolean(url && url.startsWith('postgres'));
}

function getPostgresPool() {
    if (!isPostgresConfigured()) return null;
    if (!pg) {
        console.warn('[DB WARNING] DATABASE_URL is set but "pg" package is not loaded. Falling back to JSON storage.');
        return null;
    }
    const currentUrl = getDatabaseUrl();
    if (!pgPool || pgPool._connectionString !== currentUrl) {
        if (pgPool) {
            try { pgPool.end(); } catch (_) {}
        }
        pgPool = new pg.Pool({
            connectionString: currentUrl,
            ssl: currentUrl.includes('localhost') || currentUrl.includes('127.0.0.1') ? false : { rejectUnauthorized: false },
            max: 10,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 8000
        });
        pgPool._connectionString = currentUrl;
        pgPool.on('error', (err) => {
            console.error('[POSTGRES POOL ERROR]:', err.message);
        });
    }
    return pgPool;
}

async function closePool() {
    if (pgPool) {
        await pgPool.end();
        pgPool = null;
    }
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
        const backupPath = path.join(__dirname, '.backup', 'phase2_before_phase3', 'database.json');
        if (fs.existsSync(backupPath)) {
            console.log('[DB NOTICE] Restoring database.json from backup...');
            fs.copyFileSync(backupPath, DB_FILE);
            return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        }
        // Fallback to demo template on fresh clones
        const demoData = getSanitizedDefaultDB();
        atomicWriteFileSync(DB_FILE, JSON.stringify(demoData, null, 2));
        return demoData;
    }
    try {
        const raw = fs.readFileSync(DB_FILE, 'utf8');
        return JSON.parse(raw);
    } catch (e) {
        console.error('[DB LOAD ERROR]: Corrupt database.json. Attempting recovery from backup or demo template:', e.message);
        return getSanitizedDefaultDB();
    }
}

function saveDBToJSON(data) {
    atomicWriteFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// In-memory synced state for fast synchronous reads
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
    return Promise.resolve(data);
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

// ============================================================================
// 2. عمليات PostgreSQL المباشرة وتأمين المخطط
// ============================================================================
async function initSchema(client) {
    const schemaPath = path.join(__dirname, 'scripts', 'schema.sql');
    if (fs.existsSync(schemaPath)) {
        const sql = fs.readFileSync(schemaPath, 'utf8');
        await client.query(sql);
    } else {
        // Fallback inline idempotent DDL
        await client.query(`
            CREATE TABLE IF NOT EXISTS aurumpulse_licenses (
                key VARCHAR(64) PRIMARY KEY,
                key_hash VARCHAR(64),
                plan VARCHAR(64) NOT NULL,
                client_name VARCHAR(255) NOT NULL,
                days INT NOT NULL DEFAULT 30,
                created_at DATE NOT NULL DEFAULT CURRENT_DATE,
                expires_at DATE NOT NULL,
                telegram_chat_id VARCHAR(64),
                installation_id VARCHAR(128),
                status VARCHAR(32) NOT NULL DEFAULT 'active',
                active BOOLEAN NOT NULL DEFAULT TRUE
            );
            ALTER TABLE aurumpulse_licenses ADD COLUMN IF NOT EXISTS key_hash VARCHAR(64);
            ALTER TABLE aurumpulse_licenses ADD COLUMN IF NOT EXISTS status VARCHAR(32) DEFAULT 'active';
            ALTER TABLE aurumpulse_licenses ADD COLUMN IF NOT EXISTS installation_id VARCHAR(128);
            CREATE INDEX IF NOT EXISTS idx_licenses_chat_id ON aurumpulse_licenses(telegram_chat_id);
            CREATE INDEX IF NOT EXISTS idx_licenses_key_hash ON aurumpulse_licenses(key_hash);

            CREATE TABLE IF NOT EXISTS aurumpulse_config (
                key VARCHAR(64) PRIMARY KEY,
                value JSONB NOT NULL,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS aurumpulse_stats (
                id INT PRIMARY KEY DEFAULT 1,
                total_signals INT NOT NULL DEFAULT 0,
                wins INT NOT NULL DEFAULT 0,
                losses INT NOT NULL DEFAULT 0,
                breakevens INT NOT NULL DEFAULT 0,
                net_r NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
                history JSONB NOT NULL DEFAULT '[]'::jsonb,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);
    }
}

async function loadFromPostgres(client) {
    const data = {
        adminChatId: null,
        licenses: {},
        stats: { totalSignals: 0, wins: 0, losses: 0, breakevens: 0, netR: 0, history: [] },
        sessionTrades: {},
        activeTrades: []
    };

    // 1. Licenses
    const licRes = await client.query('SELECT * FROM aurumpulse_licenses');
    for (const row of licRes.rows) {
        data.licenses[row.key] = {
            keyHash: row.key_hash,
            plan: row.plan,
            clientName: row.client_name,
            days: row.days,
            createdAt: row.created_at ? (typeof row.created_at === 'string' ? row.created_at : row.created_at.toISOString().split('T')[0]) : null,
            expiresAt: row.expires_at ? (typeof row.expires_at === 'string' ? row.expires_at : row.expires_at.toISOString().split('T')[0]) : null,
            telegramChatId: row.telegram_chat_id ? (Number(row.telegram_chat_id) || row.telegram_chat_id) : null,
            installationId: row.installation_id || null,
            status: row.status || 'active',
            active: Boolean(row.active)
        };
    }

    // 2. Config items
    const confRes = await client.query('SELECT * FROM aurumpulse_config');
    for (const row of confRes.rows) {
        const val = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
        if (row.key === 'adminChatId') data.adminChatId = val;
        if (row.key === 'sessionTrades') data.sessionTrades = val;
        if (row.key === 'activeTrades') data.activeTrades = val;
    }

    // 3. Stats
    const statsRes = await client.query('SELECT * FROM aurumpulse_stats WHERE id = 1');
    if (statsRes.rows.length > 0) {
        const s = statsRes.rows[0];
        data.stats = {
            totalSignals: s.total_signals,
            wins: s.wins,
            losses: s.losses,
            breakevens: s.breakevens,
            netR: Number(s.net_r),
            history: typeof s.history === 'string' ? JSON.parse(s.history) : (s.history || [])
        };
    }

    return data;
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
                // Skip demo licenses from syncing into production postgres
                if (key.startsWith('DEMO-') || (lic.plan && String(lic.plan).toLowerCase().includes('demo'))) {
                    continue;
                }
                const crypto = require('crypto');
                const keyHash = lic.keyHash || crypto.createHash('sha256').update(key.trim().toUpperCase()).digest('hex');
                const status = lic.status || (lic.active ? 'active' : 'revoked');
                const installationId = lic.installationId || null;

                await client.query(
                    `INSERT INTO aurumpulse_licenses (key, key_hash, plan, client_name, days, created_at, expires_at, telegram_chat_id, installation_id, status, active)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                     ON CONFLICT (key) DO UPDATE SET
                         key_hash = EXCLUDED.key_hash,
                         plan = EXCLUDED.plan,
                         client_name = EXCLUDED.client_name,
                         days = EXCLUDED.days,
                         expires_at = EXCLUDED.expires_at,
                         telegram_chat_id = EXCLUDED.telegram_chat_id,
                         installation_id = EXCLUDED.installation_id,
                         status = EXCLUDED.status,
                         active = EXCLUDED.active;`,
                    [
                        key,
                        keyHash,
                        lic.plan || 'Standard',
                        lic.clientName || 'User',
                        lic.days || 30,
                        lic.createdAt || new Date().toISOString().split('T')[0],
                        lic.expiresAt || new Date().toISOString().split('T')[0],
                        lic.telegramChatId ? String(lic.telegramChatId) : null,
                        installationId,
                        status,
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

/**
 * Boot-time Storage Initializer
 * Connects to PostgreSQL if configured, verifies/creates schema safely, loads data into cache.
 */
async function initStorage() {
    if (process.env.REQUIRE_POSTGRES === 'true') {
        if (!isPostgresConfigured()) {
            throw new Error('[FATAL DB ERROR] REQUIRE_POSTGRES=true is configured, but DATABASE_URL environment variable is missing or does not start with postgres:// or postgresql://.');
        }
        if (!pg) {
            throw new Error('[FATAL DB ERROR] REQUIRE_POSTGRES=true is configured, but the "pg" driver package is not loaded.');
        }
    }

    if (isPostgresConfigured() && pg) {
        try {
            const pool = getPostgresPool();
            const client = await pool.connect();
            try {
                // 1. Idempotent schema initialization
                await initSchema(client);

                // 2. Load existing persistent data from PostgreSQL
                const pgData = await loadFromPostgres(client);
                const licCount = Object.keys(pgData.licenses).length;

                if (licCount > 0) {
                    console.log(`[POSTGRES READY] Connected to PostgreSQL (${licCount} persistent licenses loaded).`);
                    memoryCache = pgData;
                    // Keep JSON in sync as a local offline snapshot
                    saveDBToJSON(pgData);
                } else {
                    // Fresh PostgreSQL database: seed existing local records safely without overwriting
                    console.log('[POSTGRES INIT] Database tables initialized. Syncing initial verified records...');
                    const initialData = loadDBFromJSON();
                    memoryCache = initialData;
                    await syncToPostgresAsync(initialData);
                }
                return { storage: 'postgres', success: true };
            } finally {
                client.release();
            }
        } catch (err) {
            console.error('[POSTGRES INIT ERROR]: Failed to initialize PostgreSQL:', err.message);
            if (process.env.REQUIRE_POSTGRES === 'true') {
                throw err;
            }
            console.warn('[POSTGRES FALLBACK] Falling back to local atomic JSON storage.');
        }
    }

    // Default JSON initialization
    memoryCache = loadDBFromJSON();
    console.log('[DB READY] Operating with Atomic JSON storage (database.json).');
    return { storage: 'json', success: true };
}

/**
 * Safe database connectivity check
 * Probes the active database connection without exposing credentials, connection strings, or private records.
 */
async function checkDatabaseConnection() {
    if (!isPostgresConfigured()) {
        return {
            connected: false,
            configured: false,
            storage: 'json',
            message: 'PostgreSQL is not configured (DATABASE_URL unset). Operating with local storage.'
        };
    }
    if (!pg) {
        return {
            connected: false,
            configured: true,
            storage: 'json',
            message: 'DATABASE_URL is configured but "pg" driver package is not loaded.'
        };
    }
    const pool = getPostgresPool();
    if (!pool) {
        return {
            connected: false,
            configured: true,
            storage: 'json',
            message: 'Failed to initialize PostgreSQL connection pool.'
        };
    }
    try {
        const client = await pool.connect();
        try {
            await client.query('SELECT 1 AS probe;');
            return {
                connected: true,
                configured: true,
                storage: 'postgres',
                message: 'PostgreSQL connection probe succeeded.'
            };
        } finally {
            client.release();
        }
    } catch (err) {
        return {
            connected: false,
            configured: true,
            storage: 'json',
            message: `PostgreSQL connection probe failed: ${err.code || 'CONNECTION_FAILED'}`
        };
    }
}

module.exports = {
    initStorage,
    initSchema,
    loadDB,
    saveDB,
    updateDB,
    atomicWriteFileSync,
    isPostgresConfigured,
    getPostgresPool,
    syncToPostgresAsync,
    closePool,
    checkDatabaseConnection,
    DB_FILE,
    DEMO_DB_FILE
};
