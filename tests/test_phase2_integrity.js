/**
 * AurumPulse ICT - Phase 2 Single Source of Truth & Data Integrity Test Suite
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

console.log('========================================================');
console.log('RUNNING PHASE 2 DATA INTEGRITY & ARCHITECTURE TEST SUITE');
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
    const {
        loadDB,
        saveDB,
        updateDB,
        validateLicenseKey,
        saveActiveTradesToDB,
        restoreActiveTradesFromDB,
        manageOpenTradesLifecycle,
        checkIsAdmin,
        server,
        engineState
    } = require('../bot_engine.js');

    // -------------------------------------------------------------------------
    // 1. فحص الحفاظ الكامل على بيانات المشتركين والمفاتيح السابقة (Task 1 & 4)
    // -------------------------------------------------------------------------
    it('1.1 Preserves all 6 original licenses and adminChatId in database.json', () => {
        const db = loadDB();
        assert([7452671292, 8762817484].includes(Number(db.adminChatId)), 'adminChatId must be recognized master admin ID');
        assert(db.licenses['PRO-ADMIN-2026'], 'PRO-ADMIN-2026 must be preserved');
        assert(db.licenses['GOLD-09C7-D446'], 'GOLD-09C7-D446 must be preserved');
        assert(db.licenses['GOLD-DBD0-8145'], 'GOLD-DBD0-8145 must be preserved');
        assert(db.licenses['GOLD-B1AD-BC26'], 'GOLD-B1AD-BC26 must be preserved');
        assert(db.licenses['GOLD-8C29-61C1'], 'GOLD-8C29-61C1 must be preserved');
        assert(db.licenses['GOLD-3E85-07ED'], 'GOLD-3E85-07ED must be preserved');
    });

    it('1.2 Migrated licenses from server.js (GOLD-PRO-VIP1 & TRIAL-FREE-3DAY) are preserved and valid', () => {
        const db = loadDB();
        assert(db.licenses['GOLD-PRO-VIP1'], 'GOLD-PRO-VIP1 must exist');
        assert(db.licenses['TRIAL-FREE-3DAY'], 'TRIAL-FREE-3DAY must exist');

        const v1 = validateLicenseKey('GOLD-PRO-VIP1');
        assert.strictEqual(v1.valid, true, 'GOLD-PRO-VIP1 should validate');
        assert.strictEqual(v1.license.clientName, 'أحمد');

        const v2 = validateLicenseKey('TRIAL-FREE-3DAY');
        assert.strictEqual(v2.valid, true, 'TRIAL-FREE-3DAY should validate');
    });

    it('1.3 server.js is safely consolidated and forwards to bot_engine.js', () => {
        const serverPath = path.join(__dirname, '..', 'server.js');
        const content = fs.readFileSync(serverPath, 'utf8');
        assert(content.includes("require('./bot_engine.js')"), 'server.js must delegate to bot_engine.js');
    });

    // -------------------------------------------------------------------------
    // 2. فحص الكتابة الذرية ومنع التضارب التزامني (Task 1: Concurrency & Atomic Writes)
    // -------------------------------------------------------------------------
    await itAsync('2.1 Concurrent updates are serialized and preserve database integrity without data corruption', async () => {
        const updatePromises = [];
        const startTotal = loadDB().stats.totalSignals;

        // إطلاق 15 تعديل متزامن لاختبار طابور القفل التزامني
        for (let i = 0; i < 15; i++) {
            updatePromises.push(
                new Promise((resolve) => {
                    setTimeout(() => {
                        updateDB((db) => {
                            db.stats.testCounter = (db.stats.testCounter || 0) + 1;
                        });
                        resolve();
                    }, Math.floor(Math.random() * 20));
                })
            );
        }

        await Promise.all(updatePromises);

        // الانتظار حتى اكتمال طابور الكتابة على القرص
        await saveDB(loadDB());

        const refreshedDB = loadDB();
        assert.strictEqual(refreshedDB.stats.testCounter, 15, 'All 15 concurrent updates must be recorded');
        delete refreshedDB.stats.testCounter;
        await saveDB(refreshedDB);
    });

    // -------------------------------------------------------------------------
    // 3. فحص استعادة الصفقات المفتوحة عند إعادة تشغيل السيرفر (Task 2: Restart Recovery)
    // -------------------------------------------------------------------------
    it('3.1 Active trades persist to database.json and survive server restart simulation', () => {
        const sampleTrade = {
            id: 'TEST-RECOVERY-001',
            side: 'BUY',
            session: 'London Open (07:00 UTC)',
            entry: 2745.50,
            sl: 2738.00,
            tp1: 2755.00,
            tp2: 2765.00,
            rr: '2.50',
            beMoved: false,
            createdAt: new Date().toISOString(),
            alertsSent: { entry: true, tp1: false, be: false, tp2: false, sl: false }
        };

        engineState.activeTrades = [sampleTrade];
        saveActiveTradesToDB();

        // محاكاة إغلاق السيرفر وإفراغ الذاكرة المؤقتة بالكامل
        engineState.activeTrades = [];

        // استعادة الحالة من قاعدة البيانات
        restoreActiveTradesFromDB();

        assert.strictEqual(engineState.activeTrades.length, 1, 'Restored activeTrades must have 1 trade');
        const recovered = engineState.activeTrades[0];
        assert.strictEqual(recovered.id, 'TEST-RECOVERY-001');
        assert.strictEqual(recovered.entry, 2745.50);
        assert.strictEqual(recovered.alertsSent.tp1, false);

        // تنظيف الصفقة التجريبية
        engineState.activeTrades = [];
        saveActiveTradesToDB();
    });

    // -------------------------------------------------------------------------
    // 4. فحص منع تكرار تنبيهات الصفقات (Task 2: Duplicate Alert Prevention)
    // -------------------------------------------------------------------------
    await itAsync('4.1 Duplicate TP1/BE/TP2 alerts are strictly prevented even across restarts', async () => {
        const testTrade = {
            id: 'TEST-DUP-002',
            side: 'BUY',
            session: 'NY Kill Zone (12:00 UTC)',
            entry: 2740.00,
            sl: 2732.00,
            tp1: 2752.00,
            tp2: 2764.00,
            rr: '3.00',
            beMoved: false,
            createdAt: new Date().toISOString(),
            alertsSent: { entry: true, tp1: false, be: false, tp2: false, sl: false }
        };

        const initialStats = JSON.parse(JSON.stringify(loadDB().stats));

        engineState.activeTrades = [testTrade];
        saveActiveTradesToDB();

        // 1. سعر السوق يصل للهدف الأول TP1 ($2752.00)
        await manageOpenTradesLifecycle(2753.00);

        assert.strictEqual(testTrade.beMoved, true, 'Trade must move to Break-Even at TP1');
        assert.strictEqual(testTrade.alertsSent.tp1, true, 'alertsSent.tp1 must be true');
        assert.strictEqual(testTrade.alertsSent.be, true, 'alertsSent.be must be true');

        // 2. محاكاة إعادة تشغيل السيرفر بعد إرسال الهدف الأول
        engineState.activeTrades = [];
        restoreActiveTradesFromDB();

        assert.strictEqual(engineState.activeTrades.length, 1);
        const restored = engineState.activeTrades[0];
        assert.strictEqual(restored.alertsSent.tp1, true, 'Restored trade must remember TP1 was already sent');

        // 3. فحص السوق مرة أخرى والسعر أعلى من TP1: لا يجوز إرسال تنبيه مكرر!
        await manageOpenTradesLifecycle(2754.00);
        assert.strictEqual(restored.alertsSent.tp1, true, 'Must remain true without re-triggering');

        // 4. السعر يصل للهدف النهائي TP2 ($2765.00)
        await manageOpenTradesLifecycle(2765.00);
        assert.strictEqual(engineState.activeTrades.length, 0, 'Trade must close and be removed upon TP2');

        // التحقق من تسجيل الصفقة بنجاح في الإحصائيات ثم استعادة خط الأساس
        assert.strictEqual(loadDB().stats.totalSignals, initialStats.totalSignals + 1, 'Total signals incremented');
        updateDB((d) => { d.stats = initialStats; });
        await saveDB(loadDB());

        // تنظيف
        engineState.activeTrades = [];
        saveActiveTradesToDB();
    });

    // -------------------------------------------------------------------------
    // 5. تدقيق ومطابقة إحصائيات الأداء التاريخية (Task 3: Statistics Reconciliation)
    // -------------------------------------------------------------------------
    it('5.1 Stats reconciliation preserves legacy totals while documenting verified records transparently', () => {
        const db = loadDB();
        const s = db.stats;

        // التأكد من الحفاظ على الأرقام الأصلية بدون تزييف أو مسح
        assert.strictEqual(s.totalSignals, 18, 'Original totalSignals (18) must be preserved');
        assert.strictEqual(s.wins, 14, 'Original wins (14) must be preserved');
        assert.strictEqual(s.losses, 4, 'Original losses (4) must be preserved');
        assert.strictEqual(s.breakevens, 2, 'Original breakevens (2) must be preserved');
        assert.strictEqual(s.netR, 26.8, 'Original netR (26.8) must be preserved');

        // التحقق من وجود توثيق التدقيق الذي يفرق بين الإجمالي المستورد والـ 4 صفقات المؤكدة
        assert(s.auditReconciliation, 'auditReconciliation metadata must exist');
        assert.strictEqual(s.auditReconciliation.verifiedTotals.signals, 4);
        assert.strictEqual(s.auditReconciliation.verifiedTotals.netR, 5.9);
        assert.strictEqual(s.history.length, 4, 'History must contain the 4 verified trades');
    });

    // -------------------------------------------------------------------------
    // 6. فحص واجهة برمجة التراخيص عبر POST وتوافقية GET (Task 5: License API)
    // -------------------------------------------------------------------------
    await itAsync('6.1 License verification strictly supports POST with JSON payload', async () => {
        function dispatchReq(url, method = 'POST', bodyObj = null) {
            return new Promise((resolve) => {
                const req = new Readable();
                req.url = url;
                req.method = method;
                req.headers = { host: 'localhost:8080' };
                if (bodyObj) req.push(JSON.stringify(bodyObj));
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

        // اختبار POST مع كود صالح
        const postValid = await dispatchReq('/api/verify', 'POST', { key: 'GOLD-09C7-D446' });
        assert.strictEqual(postValid.statusCode, 200);
        assert.strictEqual(postValid.data.valid, true);
        assert.strictEqual(postValid.data.clientName, 'زبون VIP');

        // اختبار POST مع كود تم ترحيله من server.js
        const postMigrated = await dispatchReq('/api/verify', 'POST', { key: 'GOLD-PRO-VIP1' });
        assert.strictEqual(postMigrated.statusCode, 200);
        assert.strictEqual(postMigrated.data.valid, true);
        assert.strictEqual(postMigrated.data.clientName, 'أحمد');

        // اختبار POST مع كود غير موجود
        const postFake = await dispatchReq('/api/verify', 'POST', { key: 'GOLD-UNKNOWN' });
        assert.strictEqual(postFake.statusCode, 403);
        assert.strictEqual(postFake.data.valid, false);

        // اختبار توافقية GET التراجعية
        const getFallback = await dispatchReq('/api/verify?key=PRO-ADMIN-2026', 'GET');
        assert.strictEqual(getFallback.statusCode, 200);
        assert.strictEqual(getFallback.data.valid, true);
    });

    // -------------------------------------------------------------------------
    // 7. التأكد من استمرار نجاح اختبارات المرحلة الأولى الأمنية (Task 6: Phase 1 Regressions)
    // -------------------------------------------------------------------------
    it('7.1 Phase 1 security protections remain active and intact', () => {
        const engineCode = fs.readFileSync(path.join(__dirname, '..', 'bot_engine.js'), 'utf8');
        const tokenLiteral = '8775098727:AAH2kimdfolIS_fHtW_k791WhOqGDT0H9O4';
        assert(!engineCode.includes(tokenLiteral), 'No plain text token in bot_engine.js');

        const htmlContent = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        assert(!htmlContent.includes('/^GOLD-[A-Z0-9]{4}-[A-Z0-9]{4}$/'), 'No regex unlock in index.html');

        assert.strictEqual(checkIsAdmin(999999999, loadDB()), false, 'Unauthorized admin rejected');
        assert.strictEqual(checkIsAdmin(7452671292, loadDB()), true, 'Master admin authorized');
    });

    console.log('\n========================================================');
    console.log(`PHASE 2 TEST RESULTS: ${passedTests} / ${totalTests} PASSED`);
    console.log('========================================================\n');

    process.exit(passedTests === totalTests ? 0 : 1);
}

runTests().catch(err => {
    console.error('Test execution error:', err);
    process.exit(1);
});
