/**
 * AurumPulse ICT — PostgreSQL Database Migration Tool
 * Safely migrates records from JSON to PostgreSQL without overwriting existing data.
 */
const fs = require('fs');
const path = require('path');

const DATABASE_URL = process.env.DATABASE_URL ? process.env.DATABASE_URL.trim() : '';

async function runMigration() {
    console.log('========================================================================');
    console.log('   AURUMPULSE ICT — POSTGRESQL DATABASE MIGRATION');
    console.log('========================================================================\n');

    if (!DATABASE_URL) {
        console.error('[MIGRATION ERROR] DATABASE_URL environment variable is not defined.');
        console.error('Usage: DATABASE_URL="postgresql://user:pass@host:5432/dbname" node scripts/migrate_to_postgres.js');
        process.exit(1);
    }

    let pg;
    try {
        pg = require('pg');
    } catch (e) {
        console.error('[MIGRATION ERROR] "pg" package is required for migration.');
        console.error('Run: npm install pg');
        process.exit(1);
    }

    // 1. Load Source Data
    const projectRoot = path.resolve(__dirname, '..');
    const localDbPath = path.join(projectRoot, 'database.json');
    const demoDbPath = path.join(projectRoot, 'database.demo.json');

    let sourcePath = localDbPath;
    if (!fs.existsSync(localDbPath)) {
        console.log('[INFO] database.json not found locally. Using database.demo.json as migration source.');
        sourcePath = demoDbPath;
    }

    const rawData = fs.readFileSync(sourcePath, 'utf8');
    const dbData = JSON.parse(rawData);

    // 2. Connect to PostgreSQL
    console.log(`>>> Connecting to PostgreSQL at: ${DATABASE_URL.replace(/:[^:]*@/, ':****@')}`);
    const pool = new pg.Pool({
        connectionString: DATABASE_URL,
        ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
        connectionTimeoutMillis: 10000
    });

    const client = await pool.connect();

    try {
        // 3. Apply Schema DDL
        const schemaPath = path.join(__dirname, 'schema.sql');
        const schemaSql = fs.readFileSync(schemaPath, 'utf8');
        console.log('>>> Applying idempotent schema DDL...');
        await client.query(schemaSql);
        console.log('  [PASS] Database schema and indexes verified.\n');

        // 4. Begin Migration Transaction
        await client.query('BEGIN');

        // Migrate Licenses (Never overwrite: ON CONFLICT DO NOTHING)
        const crypto = require('crypto');
        const licenses = Object.entries(dbData.licenses || {});
        let insertedLicenses = 0;
        let skippedLicenses = 0;
        let skippedDemoCount = 0;

        for (const [key, lic] of licenses) {
            // Strictly exclude demo licenses from production PostgreSQL migration
            if (key.startsWith('DEMO-') || (lic.plan && String(lic.plan).toLowerCase().includes('demo'))) {
                skippedDemoCount++;
                continue;
            }

            const keyHash = lic.keyHash || crypto.createHash('sha256').update(key.trim().toUpperCase()).digest('hex');
            const status = lic.status || (lic.active ? 'active' : 'revoked');
            const installationId = lic.installationId || null;

            const res = await client.query(
                `INSERT INTO aurumpulse_licenses (key, key_hash, plan, client_name, days, created_at, expires_at, telegram_chat_id, installation_id, status, active)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                 ON CONFLICT (key) DO NOTHING;`,
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
            if (res.rowCount > 0) insertedLicenses++;
            else skippedLicenses++;
        }
        console.log(`>>> Licenses: ${insertedLicenses} inserted, ${skippedLicenses} preserved without overwrite, ${skippedDemoCount} demo licenses excluded.`);

        // Migrate Global Config
        if (dbData.adminChatId) {
            await client.query(
                `INSERT INTO aurumpulse_config (key, value)
                 VALUES ('adminChatId', $1)
                 ON CONFLICT (key) DO NOTHING;`,
                [JSON.stringify(dbData.adminChatId)]
            );
        }
        if (dbData.sessionTrades) {
            await client.query(
                `INSERT INTO aurumpulse_config (key, value)
                 VALUES ('sessionTrades', $1)
                 ON CONFLICT (key) DO NOTHING;`,
                [JSON.stringify(dbData.sessionTrades)]
            );
        }
        if (dbData.activeTrades) {
            await client.query(
                `INSERT INTO aurumpulse_config (key, value)
                 VALUES ('activeTrades', $1)
                 ON CONFLICT (key) DO NOTHING;`,
                [JSON.stringify(dbData.activeTrades)]
            );
        }
        console.log('>>> Configuration & Active Trades: Migrated idempotently.');

        // Migrate Stats
        if (dbData.stats) {
            await client.query(
                `INSERT INTO aurumpulse_stats (id, total_signals, wins, losses, breakevens, net_r, history)
                 VALUES (1, $1, $2, $3, $4, $5, $6)
                 ON CONFLICT (id) DO NOTHING;`,
                [
                    dbData.stats.totalSignals || 0,
                    dbData.stats.wins || 0,
                    dbData.stats.losses || 0,
                    dbData.stats.breakevens || 0,
                    dbData.stats.netR || 0.00,
                    JSON.stringify(dbData.stats.history || [])
                ]
            );
            console.log('>>> Performance Statistics: Migrated successfully.');
        }

        await client.query('COMMIT');

        // 5. Verification Query
        const countRes = await client.query('SELECT COUNT(*) FROM aurumpulse_licenses;');
        console.log(`\n>>> Validation: Total licenses in PostgreSQL: ${countRes.rows[0].count}`);

        console.log('\n========================================================================');
        console.log('   MIGRATION COMPLETED SUCCESSFULLY WITH ZERO DATA OVERWRITE!');
        console.log('========================================================================\n');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[MIGRATION FAILED]:', err.message);
        process.exit(1);
    } finally {
        client.release();
        await pool.end();
    }
}

if (require.main === module) {
    runMigration().catch(err => {
        console.error('Fatal error:', err);
        process.exit(1);
    });
}

module.exports = { runMigration };
