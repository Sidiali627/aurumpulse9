/**
 * AurumPulse ICT - Phase 1 Security & Authentication Regression Test Suite
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

console.log('========================================================');
console.log('RUNNING PHASE 1 SECURITY & ACCESS CONTROL TEST SUITE');
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
    // 1. فحص ملف .gitignore وحماية البيانات السرية
    it('1.1 .gitignore exists and contains .env and .backup', () => {
        const gitignore = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
        assert(gitignore.includes('.env'), '.gitignore must ignore .env');
        assert(gitignore.includes('.backup/'), '.gitignore must ignore .backup/');
    });

    it('1.2 .env exists and loads TELEGRAM_TOKEN and ADMIN_CHAT_ID', () => {
        const envPath = path.join(__dirname, '..', '.env');
        assert(fs.existsSync(envPath), '.env must exist');
        const envContent = fs.readFileSync(envPath, 'utf8');
        assert(envContent.includes('TELEGRAM_TOKEN='), '.env must define TELEGRAM_TOKEN');
        assert(envContent.includes('ADMIN_CHAT_ID='), '.env must define ADMIN_CHAT_ID');
    });

    // 2. فحص عدم وجود التوكن مسرباً داخل الكود المصدري في bot_engine.js
    it('2.1 bot_engine.js does not contain hardcoded Bot Token', () => {
        const engineCode = fs.readFileSync(path.join(__dirname, '..', 'bot_engine.js'), 'utf8');
        const tokenLiteral = '8775098727:AAH2kimdfolIS_fHtW_k791WhOqGDT0H9O4';
        assert(!engineCode.includes(tokenLiteral), 'bot_engine.js must not contain plain text token');
        assert(engineCode.includes('process.env.TELEGRAM_TOKEN'), 'bot_engine.js must load from process.env');
    });

    it('2.2 bot_engine.js.js is deprecated and safely delegates to bot_engine.js', () => {
        const oldFile = path.join(__dirname, '..', 'bot_engine.js.js');
        assert(fs.existsSync(oldFile), 'Old file exists as compatibility proxy');
        const content = fs.readFileSync(oldFile, 'utf8');
        assert(content.includes("require('./bot_engine.js')"), 'Proxy must forward to bot_engine.js');
    });

    // 3. اختبارات محرك التراخيص ومكافحة الاستيلاء (Anti-Hijacking)
    const { loadDB, validateLicenseKey, checkIsAdmin, server } = require('../bot_engine.js');
    const db = loadDB();

    it('3.1 checkIsAdmin rejects unauthorized chat IDs', () => {
        const attackerChatId = 999999999;
        assert.strictEqual(checkIsAdmin(attackerChatId, db), false, 'Attacker chatId must be rejected');
    });

    it('3.2 checkIsAdmin authorizes legitimate master admin', () => {
        const legitimateAdmin = 7452671292;
        assert.strictEqual(checkIsAdmin(legitimateAdmin, db), true, 'Master admin must be recognized');
    });

    it('3.3 validateLicenseKey approves legitimate active keys', () => {
        const resAdmin = validateLicenseKey('PRO-ADMIN-2026');
        assert.strictEqual(resAdmin.valid, true, 'PRO-ADMIN-2026 should be valid');

        const resVip = validateLicenseKey('GOLD-09C7-D446');
        assert.strictEqual(resVip.valid, true, 'GOLD-09C7-D446 should be valid');
    });

    it('3.4 validateLicenseKey rejects unauthorized/fake keys', () => {
        const fakeKey = 'GOLD-9999-9999';
        const resFake = validateLicenseKey(fakeKey);
        assert.strictEqual(resFake.valid, false, 'Fake key must be rejected');

        const emptyRes = validateLicenseKey('');
        assert.strictEqual(emptyRes.valid, false, 'Empty key must be rejected');
    });

    // 4. اختبار خلو index.html من ثغرة الـ Regex bypass
    it('4.1 index.html does not contain regex auto-unlock bypass', () => {
        const htmlContent = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        assert(!htmlContent.includes('/^GOLD-[A-Z0-9]{4}-[A-Z0-9]{4}$/'), 'Regex auto-unlock must be removed');
        assert(!htmlContent.includes("isMasterAdminKey ? 'Abdelilah (Admin)' : 'VIP Member'"), 'Hardcoded client-side unlock must be removed');
    });

    // 5. اختبار استجابة واجهة برمجة التطبيقات API عبر محاكاة الطلب (In-Memory Request Dispatcher)
    await itAsync('5.1 /api/verify handler returns 200 for valid key and 403 for fake key', async () => {
        function dispatchReq(url, method = 'GET', bodyObj = null) {
            return new Promise((resolve) => {
                const req = new Readable();
                req.url = url;
                req.method = method;
                req.headers = { host: 'localhost:8080' };
                if (bodyObj) {
                    req.push(JSON.stringify(bodyObj));
                }
                req.push(null);

                let statusCode = 200;
                let responseBody = '';
                const res = {
                    setHeader: () => {},
                    writeHead: (code) => { statusCode = code; },
                    end: (chunk) => {
                        if (chunk) responseBody += chunk;
                        resolve({ statusCode, data: JSON.parse(responseBody) });
                    }
                };

                server.emit('request', req, res);
            });
        }

        const validRes = await dispatchReq('/api/verify?key=PRO-ADMIN-2026');
        assert.strictEqual(validRes.statusCode, 200, 'Valid key must return 200');
        assert.strictEqual(validRes.data.valid, true, 'Payload valid must be true');

        const fakeRes = await dispatchReq('/api/verify?key=GOLD-FAKE-KEY');
        assert.strictEqual(fakeRes.statusCode, 403, 'Fake key must return 403');
        assert.strictEqual(fakeRes.data.valid, false, 'Payload valid must be false');

        const postRes = await dispatchReq('/api/verify', 'POST', { key: 'GOLD-09C7-D446' });
        assert.strictEqual(postRes.statusCode, 200, 'POST with valid key must return 200');
        assert.strictEqual(postRes.data.valid, true, 'POST payload valid must be true');
    });

    console.log('\n========================================================');
    console.log(`TEST RESULTS: ${passedTests} / ${totalTests} PASSED`);
    console.log('========================================================\n');

    process.exit(passedTests === totalTests ? 0 : 1);
}

runTests().catch(err => {
    console.error('Test execution error:', err);
    process.exit(1);
});
