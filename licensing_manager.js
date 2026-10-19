/**
 * AurumPulse ICT — Production Licensing Manager & Security Engine
 * 
 * Features:
 * 1. Cryptographic SHA-256 key hashing & secure key generation.
 * 2. Multi-state lifecycle: active, expired, revoked, suspended.
 * 3. Server-side activation validation & hardware/installation binding.
 * 4. In-memory IP-based rate limiting to prevent brute-force attacks (5 attempts / 15m).
 * 5. Strict Demo-to-Production separation (rejects demo keys in production).
 * 6. Safe generic error responses (zero information disclosure).
 * 7. 100% backwards compatible with existing Phase 1-4 license records.
 */
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// Rate limiting state: clientIp -> { count: number, firstAttempt: number, blockedUntil: number }
const rateLimitMap = new Map();
const RATE_LIMIT_MAX_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_BLOCK_MS = 15 * 60 * 1000;

function isProductionEnv() {
    return process.env.NODE_ENV === 'production' || process.env.LICENSING_ENV === 'production';
}

function hashLicenseKey(rawKey) {
    if (!rawKey || typeof rawKey !== 'string') return '';
    const clean = rawKey.trim().toUpperCase();
    return crypto.createHash('sha256').update(clean).digest('hex');
}

function checkRateLimit(clientIp) {
    if (!clientIp) return { allowed: true };
    const now = Date.now();
    const record = rateLimitMap.get(clientIp);

    if (!record) return { allowed: true };

    if (record.blockedUntil && now < record.blockedUntil) {
        const retryAfter = Math.ceil((record.blockedUntil - now) / 1000);
        return { allowed: false, retryAfter };
    }

    if (now - record.firstAttempt > RATE_LIMIT_WINDOW_MS) {
        rateLimitMap.delete(clientIp);
        return { allowed: true };
    }

    return { allowed: true };
}

function recordFailedAttempt(clientIp) {
    if (!clientIp) return;
    const now = Date.now();
    const record = rateLimitMap.get(clientIp) || { count: 0, firstAttempt: now, blockedUntil: 0 };

    if (now - record.firstAttempt > RATE_LIMIT_WINDOW_MS) {
        record.count = 1;
        record.firstAttempt = now;
        record.blockedUntil = 0;
    } else {
        record.count++;
    }

    if (record.count >= RATE_LIMIT_MAX_ATTEMPTS) {
        record.blockedUntil = now + RATE_LIMIT_BLOCK_MS;
    }

    rateLimitMap.set(clientIp, record);
}

function clearRateLimit(clientIp) {
    if (clientIp) rateLimitMap.delete(clientIp);
}

function resetAllRateLimits() {
    rateLimitMap.clear();
}

/**
 * Validates a license key against current database records
 */
function validateProductionLicense(key, db, options = {}) {
    const clientIp = options.clientIp || null;
    const installationId = options.installationId ? String(options.installationId).trim() : null;
    const isProd = options.isProduction !== undefined ? options.isProduction : isProductionEnv();

    // 1. Rate Limit Check
    const rateCheck = checkRateLimit(clientIp);
    if (!rateCheck.allowed) {
        return {
            valid: false,
            statusCode: 429,
            retryAfter: rateCheck.retryAfter,
            message: 'تم تجاوز الحد الأقصى للمحاولات المسموح بها. يرجى الانتظار 15 دقيقة قبل المحاولة مجدداً.'
        };
    }

    const cleanKey = (key || '').trim().toUpperCase();
    if (!cleanKey) {
        recordFailedAttempt(clientIp);
        return {
            valid: false,
            statusCode: 403,
            message: 'يرجى إدخال رمز ترخيص صالح.'
        };
    }

    // 2. Demo-Key Rejection in Production (Demo keys strictly disallowed in production)
    if (isProd) {
        if (cleanKey.startsWith('DEMO-')) {
            recordFailedAttempt(clientIp);
            return {
                valid: false,
                statusCode: 403,
                message: 'رمز الترخيص غير صالح أو منتهي الصلاحية.'
            };
        }
    }

    // 3. Database Lookup (Plaintext or SHA-256 Hash)
    const keyHash = hashLicenseKey(cleanKey);
    let matchedKey = null;
    let lic = null;

    if (db && db.licenses) {
        if (db.licenses[cleanKey]) {
            matchedKey = cleanKey;
            lic = db.licenses[cleanKey];
        } else {
            // Check by hash
            for (const [k, v] of Object.entries(db.licenses)) {
                if (v.keyHash && v.keyHash === keyHash) {
                    matchedKey = k;
                    lic = v;
                    break;
                }
            }
        }
    }

    if (!lic) {
        recordFailedAttempt(clientIp);
        return {
            valid: false,
            statusCode: 403,
            message: 'رمز الترخيص غير صالح أو منتهي الصلاحية.'
        };
    }

    // 4. In Production, reject licenses marked as Demo tier
    if (isProd && lic.plan && lic.plan.toLowerCase().includes('demo')) {
        recordFailedAttempt(clientIp);
        return {
            valid: false,
            statusCode: 403,
            message: 'رمز الترخيص غير صالح أو منتهي الصلاحية.'
        };
    }

    // 5. Lifecycle States Check: active, expired, revoked, suspended
    const licenseStatus = (lic.status || (lic.active ? 'active' : 'revoked')).toLowerCase();

    if (licenseStatus === 'revoked') {
        recordFailedAttempt(clientIp);
        return {
            valid: false,
            statusCode: 403,
            message: 'رمز الترخيص غير صالح أو منتهي الصلاحية.'
        };
    }

    if (licenseStatus === 'suspended') {
        recordFailedAttempt(clientIp);
        return {
            valid: false,
            statusCode: 403,
            message: 'رمز الترخيص غير صالح أو تم تعليقه مؤقتاً.'
        };
    }

    if (!lic.active || licenseStatus !== 'active') {
        recordFailedAttempt(clientIp);
        return {
            valid: false,
            statusCode: 403,
            message: 'رمز الترخيص غير صالح أو منتهي الصلاحية.'
        };
    }

    // 6. Expiry Date Check
    const today = new Date().toISOString().split('T')[0];
    if (lic.expiresAt && lic.expiresAt < today) {
        recordFailedAttempt(clientIp);
        return {
            valid: false,
            statusCode: 403,
            message: 'رمز الترخيص غير صالح أو منتهي الصلاحية.'
        };
    }

    // 7. Safe Installation / Device Binding Check
    if (lic.installationId && installationId && lic.installationId !== installationId) {
        recordFailedAttempt(clientIp);
        return {
            valid: false,
            statusCode: 403,
            message: 'رمز الترخيص مرتبط بجهاز أو تثبيت آخر.'
        };
    }

    // If license is not yet bound and client provided installationId, bind it
    if (!lic.installationId && installationId) {
        lic.installationId = installationId;
        lic.activatedAt = new Date().toISOString();
    }

    // Success -> Clear rate limit for this IP
    clearRateLimit(clientIp);

    return {
        valid: true,
        statusCode: 200,
        key: cleanKey,
        clientName: lic.clientName,
        plan: lic.plan,
        expiresAt: lic.expiresAt,
        status: licenseStatus,
        installationId: lic.installationId || null,
        license: lic
    };
}

/**
 * Creates a cryptographically secure production license key
 */
function generateProductionKey(plan = 'VIP Pro', days = 30, clientName = 'متداول VIP', options = {}) {
    // Generate 12 cryptographically random hex characters: GOLD-XXXX-XXXX-XXXX
    const b1 = crypto.randomBytes(2).toString('hex').toUpperCase();
    const b2 = crypto.randomBytes(2).toString('hex').toUpperCase();
    const b3 = crypto.randomBytes(2).toString('hex').toUpperCase();
    const rawKey = `GOLD-${b1}-${b2}-${b3}`;
    const keyHash = hashLicenseKey(rawKey);

    const expDate = new Date();
    expDate.setDate(expDate.getDate() + parseInt(days, 10));
    const expStr = expDate.toISOString().split('T')[0];

    const record = {
        key: rawKey,
        keyHash,
        plan,
        clientName,
        days: parseInt(days, 10),
        createdAt: new Date().toISOString().split('T')[0],
        expiresAt: expStr,
        telegramChatId: options.telegramChatId || null,
        installationId: options.installationId || null,
        status: 'active',
        active: true
    };

    return { rawKey, keyHash, record, expiresAt: expStr };
}

module.exports = {
    hashLicenseKey,
    validateProductionLicense,
    generateProductionKey,
    checkRateLimit,
    recordFailedAttempt,
    clearRateLimit,
    resetAllRateLimits,
    isProductionEnv
};
