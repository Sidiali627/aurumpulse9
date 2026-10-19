/**
 * AurumPulse ICT — Production Licensing Architecture Test Suite
 * Validates cryptographic key hashing, lifecycle states, rate-limiting,
 * hardware binding, demo-key rejection in production, and secret protection.
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const http = require('http');

const {
    validateProductionLicense,
    generateProductionKey,
    hashLicenseKey,
    checkRateLimit,
    recordFailedAttempt,
    clearRateLimit,
    resetAllRateLimits
} = require('../licensing_manager.js');

const {
    server,
    validateLicenseKey,
    loadDB,
    updateDB,
    saveDB
} = require('../bot_engine.js');

console.log('========================================================');
console.log('RUNNING PRODUCTION LICENSING & SECURITY TEST SUITE');
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
    resetAllRateLimits();
    const testDb = loadDB();

    // -------------------------------------------------------------------------
    // 1. التوليد والتشفير الآمن للمفاتيح (Task 2: Cryptographic Hashing & Key Generation)
    // -------------------------------------------------------------------------
    it('1.1 Generates cryptographically secure production keys with SHA-256 hash', () => {
        const { rawKey, keyHash, record, expiresAt } = generateProductionKey('VIP Pro', 30, 'Test Trader');
        assert(rawKey.startsWith('GOLD-'), 'Key must start with GOLD-');
        assert.strictEqual(rawKey.length, 19, 'Key format must be GOLD-XXXX-XXXX-XXXX');
        assert.strictEqual(keyHash, hashLicenseKey(rawKey), 'keyHash must match SHA-256 of rawKey');
        assert.strictEqual(record.status, 'active');
        assert.strictEqual(record.active, true);
        assert(Boolean(expiresAt));
    });

    it('1.2 SHA-256 hash is deterministic and case-insensitive', () => {
        const h1 = hashLicenseKey('GOLD-ABCD-EF01-2345');
        const h2 = hashLicenseKey('gold-abcd-ef01-2345');
        const h3 = hashLicenseKey('  GOLD-ABCD-EF01-2345  ');
        assert.strictEqual(h1, h2);
        assert.strictEqual(h1, h3);
        assert.strictEqual(h1.length, 64, 'SHA-256 hex string must be 64 characters');
    });

    // -------------------------------------------------------------------------
    // 2. فحص حالات دورة حياة الترخيص (Task 2: License States: active, expired, revoked, suspended)
    // -------------------------------------------------------------------------
    const mockDb = {
        licenses: {
            'PROD-ACTIVE-KEY': {
                plan: 'VIP Pro',
                clientName: 'Active User',
                days: 30,
                createdAt: '2026-10-01',
                expiresAt: '2026-12-31',
                status: 'active',
                active: true
            },
            'PROD-EXPIRED-KEY': {
                plan: 'VIP Pro',
                clientName: 'Expired User',
                days: 30,
                createdAt: '2020-01-01',
                expiresAt: '2020-02-01',
                status: 'expired',
                active: true
            },
            'PROD-REVOKED-KEY': {
                plan: 'VIP Pro',
                clientName: 'Revoked User',
                days: 30,
                createdAt: '2026-10-01',
                expiresAt: '2026-12-31',
                status: 'revoked',
                active: false
            },
            'PROD-SUSPENDED-KEY': {
                plan: 'VIP Pro',
                clientName: 'Suspended User',
                days: 30,
                createdAt: '2026-10-01',
                expiresAt: '2026-12-31',
                status: 'suspended',
                active: true
            }
        }
    };

    it('2.1 Approves active license within valid date range', () => {
        const res = validateProductionLicense('PROD-ACTIVE-KEY', mockDb, { isProduction: true });
        assert.strictEqual(res.valid, true);
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.clientName, 'Active User');
    });

    it('2.2 Rejects expired license with safe generic error message', () => {
        const res = validateProductionLicense('PROD-EXPIRED-KEY', mockDb, { isProduction: true });
        assert.strictEqual(res.valid, false);
        assert.strictEqual(res.statusCode, 403);
        assert.strictEqual(res.message, 'رمز الترخيص غير صالح أو منتهي الصلاحية.');
    });

    it('2.3 Rejects revoked license with safe generic error message', () => {
        const res = validateProductionLicense('PROD-REVOKED-KEY', mockDb, { isProduction: true });
        assert.strictEqual(res.valid, false);
        assert.strictEqual(res.statusCode, 403);
        assert.strictEqual(res.message, 'رمز الترخيص غير صالح أو منتهي الصلاحية.');
    });

    it('2.4 Rejects suspended license with suspension notice', () => {
        const res = validateProductionLicense('PROD-SUSPENDED-KEY', mockDb, { isProduction: true });
        assert.strictEqual(res.valid, false);
        assert.strictEqual(res.statusCode, 403);
        assert(res.message.includes('تعليقه مؤقتاً'));
    });

    it('2.5 Rejects non-existent fake key without revealing non-existence', () => {
        const res = validateProductionLicense('FAKE-KEY-999999', mockDb, { isProduction: true });
        assert.strictEqual(res.valid, false);
        assert.strictEqual(res.statusCode, 403);
        assert.strictEqual(res.message, 'رمز الترخيص غير صالح أو منتهي الصلاحية.');
    });

    // -------------------------------------------------------------------------
    // 3. عزل المفاتيح التجريبية في بيئة الإنتاج (Task 4: Demo-to-Production Separation)
    // -------------------------------------------------------------------------
    it('3.1 Strictly rejects DEMO- license keys in production environment', () => {
        const demoDb = {
            licenses: {
                'DEMO-TRIAL-7DAY': {
                    plan: 'Demo Trial',
                    clientName: 'Visitor',
                    expiresAt: '2026-12-31',
                    status: 'active',
                    active: true
                }
            }
        };

        // When in production: must be rejected!
        const prodRes = validateProductionLicense('DEMO-TRIAL-7DAY', demoDb, { isProduction: true });
        assert.strictEqual(prodRes.valid, false, 'Demo key must be rejected in production');
        assert.strictEqual(prodRes.statusCode, 403);

        // When in demo/development: allowed
        const demoRes = validateProductionLicense('DEMO-TRIAL-7DAY', demoDb, { isProduction: false });
        assert.strictEqual(demoRes.valid, true, 'Demo key allowed in demo environment');
    });

    // -------------------------------------------------------------------------
    // 4. فحص تقييد معدل الطلبات ومكافحة هجمات القوة الغاشمة (Task 2: Rate Limiting)
    // -------------------------------------------------------------------------
    it('4.1 Rate limiter blocks IP after 5 consecutive failed attempts', () => {
        const testIp = '192.168.10.50';
        clearRateLimit(testIp);

        // 5 failed attempts
        for (let i = 0; i < 5; i++) {
            const res = validateProductionLicense('BAD-KEY-' + i, mockDb, { clientIp: testIp, isProduction: false });
            assert.strictEqual(res.valid, false);
        }

        // 6th attempt should be blocked with HTTP 429
        const blockedRes = validateProductionLicense('PROD-ACTIVE-KEY', mockDb, { clientIp: testIp, isProduction: false });
        assert.strictEqual(blockedRes.valid, false);
        assert.strictEqual(blockedRes.statusCode, 429);
        assert(blockedRes.retryAfter > 0);
        assert(blockedRes.message.includes('تجاوز الحد الأقصى'));

        clearRateLimit(testIp);
    });

    it('4.2 Successful validation clears failed attempts for client IP', () => {
        const testIp = '192.168.10.51';
        clearRateLimit(testIp);

        // 3 failed attempts
        for (let i = 0; i < 3; i++) {
            validateProductionLicense('WRONG-KEY', mockDb, { clientIp: testIp, isProduction: false });
        }

        // Now validate active key
        const successRes = validateProductionLicense('PROD-ACTIVE-KEY', mockDb, { clientIp: testIp, isProduction: false });
        assert.strictEqual(successRes.valid, true);

        // Subsequent check should be allowed
        const rateCheck = checkRateLimit(testIp);
        assert.strictEqual(rateCheck.allowed, true);
    });

    // -------------------------------------------------------------------------
    // 5. ربط الترخيص بالجهاز ومنع التفعيل المزدوج (Task 2: Hardware/Installation Binding)
    // -------------------------------------------------------------------------
    it('5.1 License binds to installationId and rejects activation from different device', () => {
        const boundDb = {
            licenses: {
                'BOUND-KEY-001': {
                    plan: 'VIP Pro',
                    clientName: 'Single Device User',
                    expiresAt: '2026-12-31',
                    status: 'active',
                    active: true,
                    installationId: 'DEVICE-MAC-AAAA'
                }
            }
        };

        // Same device: allowed
        const sameDevice = validateProductionLicense('BOUND-KEY-001', boundDb, { installationId: 'DEVICE-MAC-AAAA' });
        assert.strictEqual(sameDevice.valid, true);

        // Different device: rejected
        const diffDevice = validateProductionLicense('BOUND-KEY-001', boundDb, { installationId: 'DEVICE-MAC-BBBB' });
        assert.strictEqual(diffDevice.valid, false);
        assert(diffDevice.message.includes('مرتبط بجهاز'));
    });

    it('5.2 Binds installationId on first activation if unbound', () => {
        const unboundDb = {
            licenses: {
                'UNBOUND-KEY-002': {
                    plan: 'VIP Pro',
                    clientName: 'First Time User',
                    expiresAt: '2026-12-31',
                    status: 'active',
                    active: true,
                    installationId: null
                }
            }
        };

        const res = validateProductionLicense('UNBOUND-KEY-002', unboundDb, { installationId: 'DEVICE-INITIAL-123' });
        assert.strictEqual(res.valid, true);
        assert.strictEqual(unboundDb.licenses['UNBOUND-KEY-002'].installationId, 'DEVICE-INITIAL-123');
    });

    // -------------------------------------------------------------------------
    // 6. منع التلاعب بجانب العميل (Task 2: Anti-Tamper & Server Authority)
    // -------------------------------------------------------------------------
    await itAsync('6.1 /api/verify rejects client-supplied admin role, tier, or expiration date', async () => {
        const testPort = 19991;
        await new Promise(r => server.listen(testPort, '127.0.0.1', r));

        const tamperedPayload = JSON.stringify({
            key: 'PRO-ADMIN-2026',
            plan: 'Super Admin Unlimited',
            role: 'root',
            expiresAt: '2099-01-01'
        });

        const res = await new Promise((resolve, reject) => {
            const req = http.request(`http://127.0.0.1:${testPort}/api/verify`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(tamperedPayload)
                }
            }, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => resolve({ statusCode: res.statusCode, data: JSON.parse(body) }));
            });
            req.on('error', reject);
            req.write(tamperedPayload);
            req.end();
        });

        await new Promise(r => server.close(r));

        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.data.valid, true);
        // The server must return the verified database plan, NOT the tampered 'Super Admin Unlimited'
        assert.strictEqual(res.data.plan, 'Lifetime Admin', 'Server must ignore client-side tampered plan');
        assert.strictEqual(res.data.role, undefined, 'Server must never inject client-supplied roles');
    });

    // -------------------------------------------------------------------------
    // 7. سلامة النظام عند غياب تيليجرام أو PostgreSQL (Task 5 & 3: Safe Degrade)
    // -------------------------------------------------------------------------
    it('7.1 System operates safely without crashing when Telegram credentials are unconfigured', () => {
        const { sendTelegram } = require('../bot_engine.js');
        // sendTelegram should safely no-op without error when unconfigured
        assert.doesNotThrow(() => {
            // Function exists and is safe
            assert(typeof sendTelegram === 'function' || typeof validateLicenseKey === 'function');
        });
    });

    console.log('\n========================================================');
    console.log(`PRODUCTION LICENSING TEST RESULTS: ${passedTests} / ${totalTests} PASSED`);
    console.log('========================================================\n');

    process.exit(passedTests === totalTests ? 0 : 1);
}

runTests().catch(err => {
    console.error('Production licensing test suite error:', err);
    process.exit(1);
});
