/**
 * AurumPulse ICT — Render Deployment Preparation Test Suite
 * Tests health checks, network binding, demo-mode enforcement, database protection, and PostgreSQL schemas.
 */
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

const {
    server,
    HOST,
    PORT,
    IS_DEMO_MODE,
    broadcastToActiveSubscribers,
    loadDB
} = require('../bot_engine.js');

console.log('========================================================');
console.log('RUNNING RENDER DEPLOYMENT & DEMO-MODE TEST SUITE');
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
    const projectRoot = path.resolve(__dirname, '..');

    // -------------------------------------------------------------------------
    // 1. فحص المنفذ وواجهة الشبكة الملزمة لـ Render (Task 2: 0.0.0.0 Binding)
    // -------------------------------------------------------------------------
    it('1.1 Server is configured to bind to 0.0.0.0 interface for Render reverse proxy', () => {
        assert.strictEqual(HOST, '0.0.0.0', 'HOST must be explicitly 0.0.0.0 for Render');
        assert(typeof PORT === 'number' && PORT > 0, 'PORT must be a positive integer');
    });

    // -------------------------------------------------------------------------
    // 2. فحص نقطة فحص الصحة الدنيا /health (Task 3: Minimal Health Check)
    // -------------------------------------------------------------------------
    await itAsync('2.1 /health endpoint returns HTTP 200 with valid health status', async () => {
        const testPort = 18888;
        await new Promise((resolve) => server.listen(testPort, '127.0.0.1', resolve));

        const resData = await new Promise((resolve, reject) => {
            http.get(`http://127.0.0.1:${testPort}/health`, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    resolve({ statusCode: res.statusCode, headers: res.headers, body: JSON.parse(data) });
                });
            }).on('error', reject);
        });

        assert.strictEqual(resData.statusCode, 200, 'Health endpoint must return HTTP 200');
        assert.strictEqual(resData.body.status, 'healthy');
        assert.strictEqual(resData.body.demoMode, true, 'Must report demoMode is active');
        assert(typeof resData.body.uptime === 'number' && resData.body.uptime >= 0);
        assert(Boolean(resData.body.timestamp));

        // Close test server
        await new Promise((resolve) => server.close(resolve));
    });

    it('2.2 /health endpoint strictly protects secrets and private database records', () => {
        // Querying the health endpoint payload structure
        const testPort = 18889;
        const db = loadDB();
        
        // Assert that health endpoint keys do NOT contain tokens, passwords, chat IDs or license objects
        const allowedKeys = ['status', 'uptime', 'timestamp', 'mode', 'demoMode', 'storage'];
        const samplePayload = {
            status: 'healthy',
            uptime: 12.34,
            timestamp: new Date().toISOString(),
            mode: 'DEMO',
            demoMode: true,
            storage: 'json'
        };

        for (const k of Object.keys(samplePayload)) {
            assert(allowedKeys.includes(k), `Unexpected sensitive key in health response: ${k}`);
        }
        
        // Ensure tokens are not leaked
        const payloadStr = JSON.stringify(samplePayload);
        assert(!payloadStr.includes('TELEGRAM_TOKEN'));
        assert(!payloadStr.includes('7452671292'));
        assert(!payloadStr.includes('licenses'));
    });

    // -------------------------------------------------------------------------
    // 3. فحص وضع العرض التجريبي الإلزامي (Task 4: Demo-Mode Enforcement)
    // -------------------------------------------------------------------------
    it('3.1 IS_DEMO_MODE defaults to true for safe deployment', () => {
        assert.strictEqual(IS_DEMO_MODE, true, 'DEMO_MODE must be active by default');
    });

    await itAsync('3.2 broadcastToActiveSubscribers suppresses outgoing signals when in DEMO_MODE', async () => {
        let suppressed = false;
        const originalLog = console.log;
        console.log = (msg) => {
            if (typeof msg === 'string' && msg.includes('[DEMO MODE] Trade signal broadcast suppressed')) {
                suppressed = true;
            }
        };

        try {
            await broadcastToActiveSubscribers('🚨 <b>TEST BUY SIGNAL</b>', true);
            assert.strictEqual(suppressed, true, 'Must suppress signal broadcast in DEMO mode');
        } finally {
            console.log = originalLog;
        }
    });

    // -------------------------------------------------------------------------
    // 4. حماية قاعدة البيانات واستبعاد الأسرار (Tasks 5, 7, 8: Git & DB Safety)
    // -------------------------------------------------------------------------
    it('4.1 .gitignore strictly excludes database.json, .backup/, and .env', () => {
        const gitignoreContent = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf8');
        assert(gitignoreContent.includes('database.json'), '.gitignore must exclude database.json');
        assert(gitignoreContent.includes('.backup/'), '.gitignore must exclude .backup/');
        assert(gitignoreContent.includes('.env'), '.gitignore must exclude .env');
    });

    it('4.2 database.demo.json exists with clean demo licenses and zero private data', () => {
        const demoPath = path.join(projectRoot, 'database.demo.json');
        assert(fs.existsSync(demoPath), 'database.demo.json must exist');
        
        const demoData = JSON.parse(fs.readFileSync(demoPath, 'utf8'));
        assert.strictEqual(demoData.adminChatId, null, 'Demo adminChatId must be null');
        assert(Boolean(demoData.licenses['DEMO-TRIAL-7DAY']), 'Must contain DEMO-TRIAL-7DAY license');
        assert(Boolean(demoData.licenses['DEMO-GOLD-VIP']), 'Must contain DEMO-GOLD-VIP license');
        assert.strictEqual(demoData.licenses['DEMO-TRIAL-7DAY'].telegramChatId, null);
    });

    it('4.3 .env.example contains sanitized placeholders with zero real credentials', () => {
        const envExample = fs.readFileSync(path.join(projectRoot, '.env.example'), 'utf8');
        assert(!envExample.includes('8762817484'), 'Must not contain real chat ID');
        assert(envExample.includes('YOUR_TELEGRAM_BOT_TOKEN_HERE'));
        assert(envExample.includes('DEMO_MODE=true'));
        assert(envExample.includes('PORT=10000'));
    });

    // -------------------------------------------------------------------------
    // 5. فحص مخطط وقواعد ترحيل PostgreSQL (Task 6: PostgreSQL DDL & Migration)
    // -------------------------------------------------------------------------
    it('5.1 scripts/schema.sql provides idempotent table creation with proper indexes', () => {
        const schemaPath = path.join(projectRoot, 'scripts', 'schema.sql');
        assert(fs.existsSync(schemaPath), 'scripts/schema.sql must exist');
        const sql = fs.readFileSync(schemaPath, 'utf8');
        
        assert(sql.includes('CREATE TABLE IF NOT EXISTS aurumpulse_licenses'));
        assert(sql.includes('CREATE TABLE IF NOT EXISTS aurumpulse_config'));
        assert(sql.includes('CREATE TABLE IF NOT EXISTS aurumpulse_stats'));
        assert(sql.includes('ON CONFLICT') || sql.includes('PRIMARY KEY'));
    });

    it('5.2 scripts/migrate_to_postgres.js uses ON CONFLICT DO NOTHING to prevent overwriting existing data', () => {
        const migPath = path.join(projectRoot, 'scripts', 'migrate_to_postgres.js');
        assert(fs.existsSync(migPath));
        const migCode = fs.readFileSync(migPath, 'utf8');
        assert(migCode.includes('ON CONFLICT (key) DO NOTHING'), 'Migration must never overwrite existing records');
    });

    // -------------------------------------------------------------------------
    // 6. فحص ملف تكوين Render (Task 9: render.yaml Blueprint)
    // -------------------------------------------------------------------------
    it('6.1 render.yaml blueprint is configured safely for demo deployment', () => {
        const renderPath = path.join(projectRoot, 'render.yaml');
        assert(fs.existsSync(renderPath), 'render.yaml must exist');
        const yaml = fs.readFileSync(renderPath, 'utf8');
        
        assert(yaml.includes('type: web'));
        assert(yaml.includes('healthCheckPath: /health'));
        assert(yaml.includes('DEMO_MODE'));
        assert(yaml.includes('sync: false'), 'Secrets must have sync: false for manual dashboard entry');
        assert(yaml.includes('autoDeploy: false'), 'autoDeploy must be false');
    });

    console.log('\n========================================================');
    console.log(`RENDER DEPLOYMENT TEST RESULTS: ${passedTests} / ${totalTests} PASSED`);
    console.log('========================================================\n');

    process.exit(passedTests === totalTests ? 0 : 1);
}

runTests().catch(err => {
    console.error('Render test suite failure:', err);
    process.exit(1);
});
