/**
 * AurumPulse ICT — PostgreSQL Rollback & Data Export Tool
 * Safely exports PostgreSQL tables back to a timestamped JSON file and provides clean rollback.
 */
const fs = require('fs');
const path = require('path');

const DATABASE_URL = process.env.DATABASE_URL ? process.env.DATABASE_URL.trim() : '';

async function runRollback() {
    console.log('========================================================================');
    console.log('   AURUMPULSE ICT — POSTGRESQL ROLLBACK & BACKUP EXPORTER');
    console.log('========================================================================\n');

    if (!DATABASE_URL) {
        console.error('[ROLLBACK ERROR] DATABASE_URL environment variable is not defined.');
        process.exit(1);
    }

    let pg;
    try {
        pg = require('pg');
    } catch (e) {
        console.error('[ROLLBACK ERROR] "pg" package is required.');
        process.exit(1);
    }

    const pool = new pg.Pool({
        connectionString: DATABASE_URL,
        ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
    });

    const client = await pool.connect();

    try {
        console.log('>>> Exporting current PostgreSQL tables to JSON snapshot...');

        // 1. Export Licenses
        const licRes = await client.query('SELECT * FROM aurumpulse_licenses;');
        const licenses = {};
        for (const row of licRes.rows) {
            licenses[row.key] = {
                plan: row.plan,
                clientName: row.client_name,
                days: row.days,
                createdAt: row.created_at ? row.created_at.toISOString().split('T')[0] : null,
                expiresAt: row.expires_at ? row.expires_at.toISOString().split('T')[0] : null,
                telegramChatId: row.telegram_chat_id ? Number(row.telegram_chat_id) || row.telegram_chat_id : null,
                active: row.active
            };
        }

        // 2. Export Config
        const confRes = await client.query('SELECT * FROM aurumpulse_config;');
        let adminChatId = null;
        let sessionTrades = {};
        let activeTrades = [];
        for (const row of confRes.rows) {
            if (row.key === 'adminChatId') adminChatId = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
            if (row.key === 'sessionTrades') sessionTrades = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
            if (row.key === 'activeTrades') activeTrades = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
        }

        // 3. Export Stats
        const statsRes = await client.query('SELECT * FROM aurumpulse_stats WHERE id = 1;');
        let stats = { totalSignals: 0, wins: 0, losses: 0, breakevens: 0, netR: 0, history: [] };
        if (statsRes.rows.length > 0) {
            const s = statsRes.rows[0];
            stats = {
                totalSignals: s.total_signals,
                wins: s.wins,
                losses: s.losses,
                breakevens: s.breakevens,
                netR: Number(s.net_r),
                history: typeof s.history === 'string' ? JSON.parse(s.history) : s.history
            };
        }

        const exportedData = {
            adminChatId,
            licenses,
            stats,
            sessionTrades,
            activeTrades
        };

        const projectRoot = path.resolve(__dirname, '..');
        const backupFileName = `database.rollback.${Date.now()}.json`;
        const backupFilePath = path.join(projectRoot, backupFileName);

        fs.writeFileSync(backupFilePath, JSON.stringify(exportedData, null, 2), 'utf8');
        console.log(`  [PASS] Backup snapshot written to: ${backupFileName} (${licRes.rows.length} licenses)\n`);

        // Check if --drop-tables was explicitly requested
        if (process.argv.includes('--drop-tables')) {
            console.log('>>> [WARNING] --drop-tables specified. Dropping AurumPulse tables...');
            await client.query('DROP TABLE IF EXISTS aurumpulse_licenses CASCADE;');
            await client.query('DROP TABLE IF EXISTS aurumpulse_config CASCADE;');
            await client.query('DROP TABLE IF EXISTS aurumpulse_stats CASCADE;');
            console.log('  [PASS] PostgreSQL tables dropped successfully.');
        } else {
            console.log('>>> PostgreSQL tables left intact. (To drop tables, pass --drop-tables flag).');
        }

        console.log('\n========================================================================');
        console.log('   ROLLBACK EXPORT COMPLETE');
        console.log('========================================================================\n');
    } catch (err) {
        console.error('[ROLLBACK ERROR]:', err.message);
        process.exit(1);
    } finally {
        client.release();
        await pool.end();
    }
}

if (require.main === module) {
    runRollback().catch(err => {
        console.error('Fatal error:', err);
        process.exit(1);
    });
}

module.exports = { runRollback };
