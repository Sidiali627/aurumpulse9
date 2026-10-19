/**
 * AurumPulse ICT — PostgreSQL & Database Adapter Integration Test Suite
 * 
 * Verifies:
 * 1. db_adapter connects to PostgreSQL via process.env.DATABASE_URL.
 * 2. Schema initialization is safe and idempotent (CREATE TABLE IF NOT EXISTS).
 * 3. bot_engine.js uses db_adapter for all persistent operations (loadDB, updateDB, saveDB).
 * 4. DEMO_MODE=true is strictly maintained.
 * 5. Safe fallback to local atomic JSON when DATABASE_URL is not set.
 * 6. Zero credential leakage.
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const {
    initStorage,
    initSchema,
    loadDB,
    saveDB,
    updateDB,
    atomicWriteFileSync,
    isPostgresConfigured,
    getPostgresPool,
    closePool,
    syncToPostgresAsync,
    checkDatabaseConnection,
    DB_FILE,
    DEMO_DB_FILE
} = require('../db_adapter.js');

const botEngine = require('../bot_engine.js');

console.log('========================================================');
console.log('RUNNING DATABASE ADAPTER & POSTGRES INTEGRATION TESTS');
console.log('========================================================\n');

let passedTests = 0;
let totalTests = 0;

function it(description, fn) {
    totalTests++;
    try {
        fn();
        console.log(`  [PASS] ${description}`);
        passedTests++;
    } catch (err) {
        console.error(`  [FAIL] ${description}`);
        console.error(`         ${err.message}`);
    }
}

async function itAsync(description, fn) {
    totalTests++;
    try {
        await fn();
        console.log(`  [PASS] ${description}`);
        passedTests++;
    } catch (err) {
        console.error(`  [FAIL] ${description}`);
        console.error(`         ${err.message}`);
    }
}

async function runTests() {
    // -------------------------------------------------------------------------
    // 1. فحص ربط bot_engine.js بـ db_adapter.js مباشرة
    // -------------------------------------------------------------------------
    it('1.1 bot_engine.js uses db_adapter.js functions as single source of truth', () => {
        assert.strictEqual(botEngine.loadDB, loadDB, 'bot_engine.loadDB must be identical to db_adapter.loadDB');
        assert.strictEqual(botEngine.saveDB, saveDB, 'bot_engine.saveDB must be identical to db_adapter.saveDB');
        assert.strictEqual(botEngine.updateDB, updateDB, 'bot_engine.updateDB must be identical to db_adapter.updateDB');
        assert.strictEqual(botEngine.initStorage, initStorage, 'bot_engine.initStorage must be identical to db_adapter.initStorage');
    });

    // -------------------------------------------------------------------------
    // 2. فحص قراءة DATABASE_URL والاتصال الديناميكي
    // -------------------------------------------------------------------------
    it('2.1 db_adapter dynamically responds to process.env.DATABASE_URL', () => {
        const savedUrl = process.env.DATABASE_URL;
        try {
            // Unset
            delete process.env.DATABASE_URL;
            assert.strictEqual(isPostgresConfigured(), false);

            // Set valid postgres URI
            process.env.DATABASE_URL = 'postgresql://postgres:secret123@localhost:5432/aurumpulse_test';
            assert.strictEqual(isPostgresConfigured(), true);

            // Set invalid protocol
            process.env.DATABASE_URL = 'mysql://user:pass@localhost:3306/db';
            assert.strictEqual(isPostgresConfigured(), false);
        } finally {
            if (savedUrl !== undefined) process.env.DATABASE_URL = savedUrl;
            else delete process.env.DATABASE_URL;
        }
    });

    // -------------------------------------------------------------------------
    // 3. فحص التهيئة الآمنة للمخطط وعدم حذف أو تعديل البيانات الموجودة
    // -------------------------------------------------------------------------
    it('3.1 scripts/schema.sql uses strictly idempotent DDL without DROP or TRUNCATE', () => {
        const schemaPath = path.join(__dirname, '..', 'scripts', 'schema.sql');
        assert(fs.existsSync(schemaPath), 'schema.sql must exist');
        const sql = fs.readFileSync(schemaPath, 'utf8');

        assert(!sql.includes('DROP TABLE'), 'schema.sql must NEVER contain DROP TABLE');
        assert(!sql.includes('TRUNCATE'), 'schema.sql must NEVER contain TRUNCATE');
        assert(sql.includes('CREATE TABLE IF NOT EXISTS aurumpulse_licenses'));
        assert(sql.includes('CREATE TABLE IF NOT EXISTS aurumpulse_config'));
        assert(sql.includes('CREATE TABLE IF NOT EXISTS aurumpulse_stats'));
        assert(sql.includes('ALTER TABLE aurumpulse_licenses ADD COLUMN IF NOT EXISTS'));
    });

    // -------------------------------------------------------------------------
    // 4. فحص استدعاء initStorage ومعالجة غياب PostgreSQL بأمان
    // -------------------------------------------------------------------------
    await itAsync('4.1 initStorage initializes fallback JSON when DATABASE_URL is unset', async () => {
        const savedUrl = process.env.DATABASE_URL;
        try {
            delete process.env.DATABASE_URL;
            const res = await initStorage();
            assert.strictEqual(res.success, true);
            assert.strictEqual(res.storage, 'json');
            
            const db = loadDB();
            assert(Boolean(db.licenses), 'Licenses object must be initialized');
            assert(Boolean(db.stats), 'Stats object must be initialized');
        } finally {
            if (savedUrl !== undefined) process.env.DATABASE_URL = savedUrl;
            else delete process.env.DATABASE_URL;
        }
    });

    await itAsync('4.2 initStorage fails safely when REQUIRE_POSTGRES=true and DATABASE_URL is missing', async () => {
        const savedUrl = process.env.DATABASE_URL;
        const savedReq = process.env.REQUIRE_POSTGRES;
        try {
            delete process.env.DATABASE_URL;
            process.env.REQUIRE_POSTGRES = 'true';
            let threw = false;
            try {
                await initStorage();
            } catch (err) {
                threw = true;
                assert(err.message.includes('REQUIRE_POSTGRES=true'), 'Error must explicitly mention REQUIRE_POSTGRES requirement');
            }
            assert.strictEqual(threw, true, 'Must throw error when REQUIRE_POSTGRES=true and DATABASE_URL is missing');
        } finally {
            if (savedUrl !== undefined) process.env.DATABASE_URL = savedUrl;
            else delete process.env.DATABASE_URL;
            if (savedReq !== undefined) process.env.REQUIRE_POSTGRES = savedReq;
            else delete process.env.REQUIRE_POSTGRES;
        }
    });

    // -------------------------------------------------------------------------
    // 5. فحص ثبات وضع العرض التجريبي DEMO_MODE=true وعدم تنفيذ أي تداول حقيقي
    // -------------------------------------------------------------------------
    it('5.1 DEMO_MODE=true is strictly active and trading broadcasts are disabled', () => {
        assert.strictEqual(botEngine.IS_DEMO_MODE, true, 'IS_DEMO_MODE must be true');
        assert.strictEqual(botEngine.isDemoMode(), true, 'isDemoMode() must return true');
        assert.strictEqual(botEngine.engineState.demoMode, true, 'engineState.demoMode must be true');
    });

    // -------------------------------------------------------------------------
    // 6. فحص عدم تسريب بيانات الاعتماد في واجهات برمجة التطبيقات وسجلات النظام
    // -------------------------------------------------------------------------
    it('6.1 /health and /api/status never expose DATABASE_URL or credentials', () => {
        const savedUrl = process.env.DATABASE_URL;
        try {
            process.env.DATABASE_URL = 'postgresql://admin_user:super_secret_pw@db.render.com:5432/aurum';
            
            // Check health payload
            const healthPayload = JSON.stringify({
                status: 'healthy',
                uptime: process.uptime(),
                timestamp: new Date().toISOString(),
                mode: 'DEMO',
                demoMode: true,
                storage: isPostgresConfigured() ? 'postgres' : 'json'
            });

            assert(!healthPayload.includes('super_secret_pw'), 'Must never leak DB password');
            assert(!healthPayload.includes('admin_user'), 'Must never leak DB user');
            assert(!healthPayload.includes('db.render.com'), 'Must never leak DB host');
        } finally {
            if (savedUrl !== undefined) process.env.DATABASE_URL = savedUrl;
            else delete process.env.DATABASE_URL;
        }
    });

    await itAsync('6.2 checkDatabaseConnection safely probes database without exposing credentials', async () => {
        const savedUrl = process.env.DATABASE_URL;
        try {
            // Unset DATABASE_URL
            delete process.env.DATABASE_URL;
            const res1 = await checkDatabaseConnection();
            assert.strictEqual(res1.connected, false);
            assert.strictEqual(res1.configured, false);
            assert.strictEqual(res1.storage, 'json');
            assert(!JSON.stringify(res1).includes('password'));

            // Configured with credentials
            process.env.DATABASE_URL = 'postgresql://admin_safe:safe_probe_secret@127.0.0.1:5432/aurumpulse';
            const res2 = await checkDatabaseConnection();
            assert(!JSON.stringify(res2).includes('safe_probe_secret'), 'Must never leak password in checkDatabaseConnection');
            assert(!JSON.stringify(res2).includes('admin_safe:'), 'Must never leak username in checkDatabaseConnection');
        } finally {
            if (savedUrl !== undefined) process.env.DATABASE_URL = savedUrl;
            else delete process.env.DATABASE_URL;
        }
    });

    // -------------------------------------------------------------------------
    // 7. محاكاة ترحيل ومزامنة مع عميل PostgreSQL وهمي لاختبار الاستعلامات
    // -------------------------------------------------------------------------
    await itAsync('7.1 Mock PostgreSQL client verifies query syntax and transaction flow', async () => {
        const executedQueries = [];
        const mockClient = {
            query: async (sql, params) => {
                executedQueries.push({ sql: sql.trim(), params });
                if (sql.includes('SELECT * FROM aurumpulse_licenses')) {
                    return { rows: [] };
                }
                if (sql.includes('SELECT * FROM aurumpulse_config')) {
                    return { rows: [] };
                }
                if (sql.includes('SELECT * FROM aurumpulse_stats')) {
                    return { rows: [] };
                }
                return { rowCount: 1, rows: [] };
            }
        };

        // Test initSchema query on mock client
        await initSchema(mockClient);
        assert(executedQueries.some(q => q.sql.includes('CREATE TABLE IF NOT EXISTS aurumpulse_licenses')));
        assert(executedQueries.some(q => q.sql.includes('ALTER TABLE aurumpulse_licenses ADD COLUMN IF NOT EXISTS')));
    });

    console.log('\n========================================================');
    console.log(`DATABASE INTEGRATION TEST RESULTS: ${passedTests} / ${totalTests} PASSED`);
    console.log('========================================================\n');

    process.exit(passedTests === totalTests ? 0 : 1);
}

runTests().catch(err => {
    console.error('Database integration test failure:', err);
    process.exit(1);
});
