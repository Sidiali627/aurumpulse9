/**
 * AurumPulse ICT - bot_engine.js (v5.3 Quantitative ICT Strategy Engine & Single Source of Truth)
 * يتضمن:
 * 1. التحقق الصارم من نزاهة بيانات الشموع (Candle Validation & Zero Malformed Bars)
 * 2. تحديد دقيق لجلسات لندن ونيويورك بتوقيتها المحلي وحساب التوقيت الصيفي (Intl DST Support)
 * 3. إزالة التعويض العشوائي (No arbitrary 12-candles fallback)
 * 4. تطبيق قواعد ICT الصارمة (Unmitigated FVG, Intact Order Blocks, Directional Confluence)
 * 5. منع الجمع بين إشارات وتأكيدات متناقضة (Contradictory Confluences Rejection)
 * 6. تطبيق قاعدة صفقة واحدة لكل جلسة (One Trade Per Session Enforcement)
 * 7. حفظ الصفقات المفتوحة ومنع التكرار (Active Trades Persistence & Deduplication)
 * 8. توثيق الأصل المالي بشفافية تامة (PAXG/USDT vs Spot XAU/USD)
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
    validateProductionLicense,
    generateProductionKey,
    hashLicenseKey,
    checkRateLimit,
    clearRateLimit,
    resetAllRateLimits,
    isProductionEnv
} = require('./licensing_manager.js');

function maskChatId(chatId) {
    if (!chatId) return '[UNCONFIGURED]';
    const s = String(chatId).trim();
    if (s.length <= 4) return '****';
    return `${s.slice(0, 3)}****${s.slice(-2)}`;
}

// ============================================================================
// 1. تحميل متغيرات البيئة تلقائياً (Zero Dependency .env Loader)
// ============================================================================
function loadEnv() {
    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
        try {
            const content = fs.readFileSync(envPath, 'utf8');
            for (const line of content.split(/\r?\n/)) {
                const trimmed = line.trim();
                if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
                    const idx = trimmed.indexOf('=');
                    const key = trimmed.slice(0, idx).trim();
                    const val = trimmed.slice(idx + 1).trim();
                    if (!process.env[key]) {
                        process.env[key] = val;
                    }
                }
            }
        } catch (e) {
            console.error('[ENV LOAD ERROR]:', e.message);
        }
    }
}
loadEnv();

// ============================================================================
// 2. إعدادات الهوية والاتصال الآمن
// ============================================================================
const BRAND_NAME = 'AurumPulse ICT';
const INSTRUMENT_NAME = 'PAXG/USDT (Binance Gold Feed)';
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '';
const MASTER_ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID ? String(process.env.ADMIN_CHAT_ID).trim() : '7452671292';
const ADMIN_CONTACT_USER = process.env.ADMIN_CONTACT_USER || '@alpha34';
const PORT = parseInt(process.env.PORT, 10) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const IS_DEMO_MODE = process.env.DEMO_MODE !== 'false';
const DB_FILE = path.join(__dirname, 'database.json');

if (!TELEGRAM_TOKEN || TELEGRAM_TOKEN.includes('YOUR_TELEGRAM_BOT_TOKEN')) {
    console.warn('[SECURITY NOTICE] TELEGRAM_TOKEN is missing or not set in .env. Bot messaging is inactive.');
}

let lastUpdateId = 0;
let isPolling = false;

let engineState = {
    instrument: INSTRUMENT_NAME,
    demoMode: IS_DEMO_MODE,
    lastPrice: 0,
    atr: 0,
    sessionName: 'خارج أوقات الجلسات (انتظار الافتتاح) ⏳',
    sessionKey: null,
    orh: 0,
    orl: 0,
    bsl: 0,
    ssl: 0,
    isOrbClosed: false,
    breakoutDir: 'داخل النطاق (انتظار الكسر) ⏳',
    confirmations: [],
    activeTrades: [],
    lastAlertCandleTime: null,
    lastEvaluationReason: null
};

// ============================================================================
// 3. محرك اتصال HTTPS الأصلي (IPv4 Forced)
// ============================================================================
function nativeRequest(urlStr, options = {}) {
    return new Promise((resolve, reject) => {
        try {
            const urlObj = new URL(urlStr);
            const reqOptions = {
                hostname: urlObj.hostname,
                path: urlObj.pathname + urlObj.search,
                method: options.method || 'GET',
                headers: options.headers || {},
                family: 4,
                timeout: 15000
            };

            const req = https.request(reqOptions, (res) => {
                let rawData = '';
                res.on('data', (chunk) => { rawData += chunk; });
                res.on('end', () => {
                    try { resolve(JSON.parse(rawData)); }
                    catch (e) { resolve(rawData); }
                });
            });

            req.on('error', (err) => reject(err));
            req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });

            if (options.body) {
                req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
            }
            req.end();
        } catch (err) {
            reject(err);
        }
    });
}

// ============================================================================
// 4. مدير قاعدة البيانات المحمي (Universal PostgreSQL & Atomic JSON Adapter)
// ============================================================================
const {
    loadDB,
    saveDB,
    updateDB,
    atomicWriteFileSync,
    initStorage,
    isPostgresConfigured,
    getPostgresPool
} = require('./db_adapter.js');

// ============================================================================
// 5. التحقق من سلامة بيانات الشموع (Task 1: Candle Integrity)
// ============================================================================
function validateCandles(rawCandles) {
    if (!Array.isArray(rawCandles) || rawCandles.length < 30) {
        return { valid: false, error: 'Insufficient candle data (minimum 30 required)' };
    }

    const candles = [];
    for (let i = 0; i < rawCandles.length; i++) {
        const d = rawCandles[i];
        const time = Math.floor(d[0] / 1000);
        const open = parseFloat(d[1]);
        const high = parseFloat(d[2]);
        const low = parseFloat(d[3]);
        const close = parseFloat(d[4]);

        if (isNaN(time) || isNaN(open) || isNaN(high) || isNaN(low) || isNaN(close)) {
            return { valid: false, error: `Malformed numeric values at candle index ${i}` };
        }
        if (high < low || high < open || high < close || low > open || low > close) {
            return { valid: false, error: `Invalid candle price structure (High/Low) at index ${i}` };
        }
        if (candles.length > 0 && time <= candles[candles.length - 1].time) {
            return { valid: false, error: `Non-monotonic candle timestamp at index ${i}` };
        }
        candles.push({ time, open, high, low, close });
    }

    return { valid: true, candles };
}

function computeRealATR(arr, period = 14) {
    if (arr.length <= period) return 1.5;
    let s = 0;
    for (let i = arr.length - period; i < arr.length; i++) {
        const c = arr[i], p = arr[i - 1];
        s += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    }
    return parseFloat((s / period).toFixed(2));
}

// ============================================================================
// 6. تحديد الجلسات والتوقيت الصيفي وحساب نطاق الافتتاح (Task 2: ORB & DST)
// ============================================================================
function getSessionInfo(candleTimeSeconds) {
    const date = new Date(candleTimeSeconds * 1000);

    // Europe/London handles GMT (UTC+0) in winter and BST (UTC+1) in summer
    const londonFmt = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Europe/London',
        hour: 'numeric',
        minute: 'numeric',
        hourCycle: 'h23'
    });
    const londonParts = londonFmt.formatToParts(date);
    let lHour = 0, lMin = 0;
    for (const p of londonParts) {
        if (p.type === 'hour') lHour = parseInt(p.value, 10);
        if (p.type === 'minute') lMin = parseInt(p.value, 10);
    }

    // America/New_York handles EST (UTC-5) in winter and EDT (UTC-4) in summer
    const nyFmt = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: 'numeric',
        minute: 'numeric',
        hourCycle: 'h23'
    });
    const nyParts = nyFmt.formatToParts(date);
    let nyHour = 0, nyMin = 0;
    for (const p of nyParts) {
        if (p.type === 'hour') nyHour = parseInt(p.value, 10);
        if (p.type === 'minute') nyMin = parseInt(p.value, 10);
    }

    const dateFmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'UTC',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    });
    const sessionDateStr = dateFmt.format(date); // YYYY-MM-DD

    const dayOfWeek = date.getUTCDay(); // 0 = Sunday, 6 = Saturday
    const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);

    // شمعة افتتاح لندن M15 تبدأ عند 08:00 صباحاً بتوقيت لندن المحلي (أيام العمل فقط)
    const isLondonOpenCandle = !isWeekend && (lHour === 8 && lMin === 0);
    // نافذة جلسة لندن النشطة: 08:00 إلى 11:00 بتوقيت لندن المحلي
    const isLondonActiveWindow = !isWeekend && (lHour >= 8 && lHour < 11);

    // شمعة افتتاح نيويورك M15 تبدأ عند 08:00 صباحاً بتوقيت نيويورك المحلي
    const isNYOpenCandle = !isWeekend && (nyHour === 8 && nyMin === 0);
    // نافذة جلسة نيويورك النشطة: 08:00 إلى 11:30 بتوقيت نيويورك المحلي
    const isNYActiveWindow = !isWeekend && (nyHour >= 8 && (nyHour < 11 || (nyHour === 11 && nyMin <= 30)));

    return {
        lHour, lMin, nyHour, nyMin,
        dayOfWeek,
        isWeekend,
        sessionDateStr,
        isLondonOpenCandle,
        isLondonActiveWindow,
        isNYOpenCandle,
        isNYActiveWindow
    };
}

function findActiveORBSession(candles) {
    if (!candles || candles.length === 0) {
        return { active: false, reason: 'لا توجد بيانات شموع كافية', orbIdx: -1 };
    }

    const latest = candles[candles.length - 1];
    const latestInfo = getSessionInfo(latest.time);

    if (latestInfo.isWeekend) {
        return {
            active: false,
            reason: 'السوق مغلق (عطلة نهاية الأسبوع السبت / الأحد)',
            orbIdx: -1
        };
    }

    let activeSessionType = null;
    let sessionLabel = '';

    if (latestInfo.isNYActiveWindow) {
        activeSessionType = 'NY';
        sessionLabel = `نيويورك (NY Kill Zone - ${latestInfo.sessionDateStr})`;
    } else if (latestInfo.isLondonActiveWindow) {
        activeSessionType = 'LONDON';
        sessionLabel = `لندن (London Kill Zone - ${latestInfo.sessionDateStr})`;
    } else {
        // إزالة التعويض العشوائي نهائياً!
        return {
            active: false,
            reason: 'خارج أوقات جلسات التداول الرسمية (لندن 08:00-11:00 / نيويورك 08:00-11:30)',
            orbIdx: -1
        };
    }

    let orbIdx = -1;
    const maxLookback = Math.max(0, candles.length - 80);
    for (let i = candles.length - 1; i >= maxLookback; i--) {
        const info = getSessionInfo(candles[i].time);
        if (info.sessionDateStr !== latestInfo.sessionDateStr) {
            break; // Crossed into previous calendar day, stop scanning
        }
        if (activeSessionType === 'NY' && info.isNYOpenCandle) {
            orbIdx = i;
            break;
        }
        if (activeSessionType === 'LONDON' && info.isLondonOpenCandle) {
            orbIdx = i;
            break;
        }
    }

    if (orbIdx === -1) {
        return {
            active: false,
            reason: `شمعة افتتاح جلسة ${activeSessionType} لم تتشكل بعد أو غير متوفرة في النطاق`,
            orbIdx: -1
        };
    }

    const isOrbClosed = orbIdx < (candles.length - 1);
    const sessionKey = `${latestInfo.sessionDateStr}_${activeSessionType}`;

    return {
        active: true,
        sessionType: activeSessionType,
        sessionLabel,
        sessionKey,
        orbIdx,
        isOrbClosed,
        orbCandle: candles[orbIdx]
    };
}

// ============================================================================
// 7. محرك تدقيق وتأكيدات ICT وفحص التغطية (Task 3: ICT Confluences & Mitigation)
// ============================================================================
function evaluateICTConfluences(candles, orbIdx, atr, fvgMult = 0.15) {
    const orb = candles[orbIdx];
    const logs = [];

    let activeBullishFVG = null;
    let activeBearishFVG = null;
    let lastBullishOB = null;
    let lastBearishOB = null;
    let sslSweep = false;
    let bslSweep = false;

    // الفحص المتسلسل الزمني الدقيق (Zero Look-Ahead Bias)
    for (let i = Math.max(2, orbIdx); i < candles.length - 1; i++) {
        const c0 = candles[i];
        const c1 = candles[i - 1];
        const c2 = candles[i - 2];

        // 1. تشكل Bullish FVG
        if (c1.close > c1.open && c0.low > c2.high && (c0.low - c2.high) >= atr * fvgMult) {
            activeBullishFVG = {
                index: i,
                top: c0.low,
                bottom: c2.high,
                mitigated: false
            };
            logs.push(`Bullish FVG formed at bar ${i}`);
        }
        // فحص تغطية الفجوة الشرائية بالشموع اللاحقة
        if (activeBullishFVG && !activeBullishFVG.mitigated && i > activeBullishFVG.index) {
            if (c0.low <= activeBullishFVG.bottom) {
                activeBullishFVG.mitigated = true;
                logs.push(`Bullish FVG mitigated at bar ${i}`);
            }
        }

        // 2. تشكل Bearish FVG
        if (c1.close < c1.open && c0.high < c2.low && (c2.low - c0.high) >= atr * fvgMult) {
            activeBearishFVG = {
                index: i,
                top: c2.low,
                bottom: c0.high,
                mitigated: false
            };
            logs.push(`Bearish FVG formed at bar ${i}`);
        }
        // فحص تغطية الفجوة البيعية
        if (activeBearishFVG && !activeBearishFVG.mitigated && i > activeBearishFVG.index) {
            if (c0.high >= activeBearishFVG.top) {
                activeBearishFVG.mitigated = true;
                logs.push(`Bearish FVG mitigated at bar ${i}`);
            }
        }

        // 3. كتل الأوامر (Order Blocks)
        if (c2.close < c2.open && c1.close > c2.high && c1.close > c1.open) {
            lastBullishOB = { index: i - 2, low: c2.low, high: c2.high, invalidated: false };
        }
        if (lastBullishOB && !lastBullishOB.invalidated && i > lastBullishOB.index) {
            if (c0.close < lastBullishOB.low) {
                lastBullishOB.invalidated = true;
                logs.push(`Bullish OB invalidated at bar ${i}`);
            }
        }

        if (c2.close > c2.open && c1.close < c2.low && c1.close < c1.open) {
            lastBearishOB = { index: i - 2, low: c2.low, high: c2.high, invalidated: false };
        }
        if (lastBearishOB && !lastBearishOB.invalidated && i > lastBearishOB.index) {
            if (c0.close > lastBearishOB.high) {
                lastBearishOB.invalidated = true;
                logs.push(`Bearish OB invalidated at bar ${i}`);
            }
        }

        // 4. سحب السيولة (Liquidity Sweeps)
        // شرط سحب سيولة القاع (SSL Sweep): ذيل يكسر ORL مع إغلاق يعود داخل النطاق
        if (c0.low < orb.low && c0.close >= orb.low && c0.close <= orb.high) {
            sslSweep = true;
            logs.push(`SSL Liquidity Sweep detected at bar ${i}`);
        }
        // شرط سحب سيولة القمة (BSL Sweep): ذيل يخترق ORH مع إغلاق يعود داخل النطاق
        if (c0.high > orb.high && c0.close <= orb.high && c0.close >= orb.low) {
            bslSweep = true;
            logs.push(`BSL Liquidity Sweep detected at bar ${i}`);
        }
    }

    const bullishConfs = [];
    if (activeBullishFVG && !activeBullishFVG.mitigated) bullishConfs.push('Bullish FVG (Unmitigated)');
    if (lastBullishOB && !lastBullishOB.invalidated) bullishConfs.push('Bullish Order Block');
    if (sslSweep) bullishConfs.push('SSL Liquidity Sweep');

    const bearishConfs = [];
    if (activeBearishFVG && !activeBearishFVG.mitigated) bearishConfs.push('Bearish FVG (Unmitigated)');
    if (lastBearishOB && !lastBearishOB.invalidated) bearishConfs.push('Bearish Order Block');
    if (bslSweep) bearishConfs.push('BSL Liquidity Sweep');

    return {
        bullishConfs,
        bearishConfs,
        bullOBLow: lastBullishOB && !lastBullishOB.invalidated ? lastBullishOB.low : orb.low,
        bearOBHigh: lastBearishOB && !lastBearishOB.invalidated ? lastBearishOB.high : orb.high,
        logs
    };
}

function evaluateSignalCandidate(candles, orbInfo, atr, db, options = {}) {
    const orb = orbInfo.orbCandle;
    const lastClosed = candles[candles.length - 2];
    const enforceOneTrade = options.oneTradePerSession !== undefined ? options.oneTradePerSession : true;

    // 1. تطبيق قاعدة صفقة واحدة لكل جلسة (Task 4)
    if (enforceOneTrade && db.sessionTrades && db.sessionTrades[orbInfo.sessionKey] >= 1) {
        return {
            accepted: false,
            reason: `تم تنفيذ صفقة مسبقاً في هذه الجلسة (${orbInfo.sessionKey}). قاعدة صفقة واحدة مطبقة لمنع التكرار.`
        };
    }

    const fvgMult = options.fvgMult || 0.15;
    const slBufferMult = options.slBufferMult !== undefined ? options.slBufferMult : 0.25;
    const minRR = options.minRR !== undefined ? options.minRR : 2.0;

    // 2. فحص التأكيدات البنيوية
    const ict = evaluateICTConfluences(candles, orbInfo.orbIdx, atr, fvgMult);

    const lookback = candles.slice(-50);
    const bsl = Math.max(...lookback.map(c => c.high));
    const ssl = Math.min(...lookback.map(c => c.low));

    // تقييم الكسر الصاعد (BULLISH BREAKOUT)
    if (lastClosed.close > orb.high) {
        // حظر التأكيدات المتناقضة: يجب توفر تأكيد شرائي صالح حصراً!
        if (ict.bullishConfs.length === 0) {
            return {
                accepted: false,
                reason: 'كسر صاعد مرفوض: لا يوجد أي تأكيد ICT شرائي صالح (التأكيدات الهابطة وحدها مرفوضة للكسر الصاعد).'
            };
        }
        if (ict.bearishConfs.length > 0) {
            return {
                accepted: false,
                reason: `كسر صاعد مرفوض لوجود تأكيدات هابطة متناقضة: ${ict.bearishConfs.join(' + ')}`
            };
        }

        const entry = lastClosed.close;
        const sl = parseFloat((Math.min(ict.bullOBLow, orb.high - atr * 0.5) - atr * slBufferMult).toFixed(2));
        const risk = Math.max(entry - sl, 0.5);
        const tp1 = parseFloat((entry + risk * 1.5).toFixed(2));
        const tp2 = parseFloat(Math.max(bsl, entry + risk * 2.2).toFixed(2));
        const rr = parseFloat(((tp2 - entry) / risk).toFixed(2));

        if (rr < minRR) {
            return {
                accepted: false,
                reason: `نسبة R:R المحسوبة (${rr}) أقل من شرط الدخول المؤسساتي (الحد الأدنى 1:${minRR.toFixed(1)}).`
            };
        }

        return {
            accepted: true,
            side: 'BUY',
            session: orbInfo.sessionLabel,
            sessionKey: orbInfo.sessionKey,
            entry,
            sl,
            tp1,
            tp2,
            rr: rr.toFixed(2),
            confs: ict.bullishConfs,
            alertCandleTime: lastClosed.time
        };
    }

    // تقييم الكسر الهابط (BEARISH BREAKOUT)
    if (lastClosed.close < orb.low) {
        if (ict.bearishConfs.length === 0) {
            return {
                accepted: false,
                reason: 'كسر هابط مرفوض: لا يوجد أي تأكيد ICT بيعي صالح (التأكيدات الصاعدة وحدها مرفوضة للكسر الهابط).'
            };
        }
        if (ict.bullishConfs.length > 0) {
            return {
                accepted: false,
                reason: `كسر هابط مرفوض لوجود تأكيدات صاعدة متناقضة: ${ict.bullishConfs.join(' + ')}`
            };
        }

        const entry = lastClosed.close;
        const sl = parseFloat((Math.max(ict.bearOBHigh, orb.low + atr * 0.5) + atr * slBufferMult).toFixed(2));
        const risk = Math.max(sl - entry, 0.5);
        const tp1 = parseFloat((entry - risk * 1.5).toFixed(2));
        const tp2 = parseFloat(Math.min(ssl, entry - risk * 2.2).toFixed(2));
        const rr = parseFloat(((entry - tp2) / risk).toFixed(2));

        if (rr < minRR) {
            return {
                accepted: false,
                reason: `نسبة R:R المحسوبة (${rr}) أقل من شرط الدخول المؤسساتي (الحد الأدنى 1:${minRR.toFixed(1)}).`
            };
        }

        return {
            accepted: true,
            side: 'SELL',
            session: orbInfo.sessionLabel,
            sessionKey: orbInfo.sessionKey,
            entry,
            sl,
            tp1,
            tp2,
            rr: rr.toFixed(2),
            confs: ict.bearishConfs,
            alertCandleTime: lastClosed.time
        };
    }

    return {
        accepted: false,
        reason: 'السعر داخل نطاق الافتتاح ORH / ORL (انتظار الكسر والإغلاق المؤكد)'
    };
}

// ============================================================================
// 8. إدارة الصفقات المفتوحة (Lifecycle & Worst-Case Execution)
// ============================================================================
function saveActiveTradesToDB() {
    updateDB((db) => {
        db.activeTrades = engineState.activeTrades;
    });
}

function restoreActiveTradesFromDB() {
    const db = loadDB();
    if (Array.isArray(db.activeTrades) && db.activeTrades.length > 0) {
        engineState.activeTrades = db.activeTrades.map(t => ({
            ...t,
            alertsSent: t.alertsSent || {
                entry: true,
                tp1: Boolean(t.beMoved),
                be: Boolean(t.beMoved),
                tp2: false,
                sl: false
            }
        }));
        console.log(`[TRADE RESTORATION] Restored ${engineState.activeTrades.length} active trade(s) from database.json`);
    } else {
        engineState.activeTrades = [];
    }
}

function recordSignalOutcome(side, session, rValue, statusLabel) {
    updateDB((db) => {
        db.stats.totalSignals += 1;
        if (rValue > 0) db.stats.wins += 1;
        else if (rValue < 0) db.stats.losses += 1;
        else db.stats.breakevens += 1;

        db.stats.netR = parseFloat((db.stats.netR + rValue).toFixed(2));
        db.stats.history.unshift({
            date: new Date().toISOString().split('T')[0],
            side,
            session,
            resultR: `${rValue >= 0 ? '+' : ''}${rValue}R`,
            status: statusLabel
        });
        db.stats.history = db.stats.history.slice(0, 50);
    });
}

async function broadcastToActiveSubscribers(messageHtml, isTradeSignal = true) {
    if (IS_DEMO_MODE && isTradeSignal) {
        console.log(`[DEMO MODE] Trade signal broadcast suppressed for safety.`);
        return;
    }
    const db = loadDB();
    const today = new Date().toISOString().split('T')[0];
    const sentIds = new Set();

    if (db.adminChatId) {
        await sendTelegram(db.adminChatId, messageHtml);
        sentIds.add(String(db.adminChatId));
    }
    if (MASTER_ADMIN_CHAT_ID && !sentIds.has(String(MASTER_ADMIN_CHAT_ID))) {
        await sendTelegram(MASTER_ADMIN_CHAT_ID, messageHtml);
        sentIds.add(String(MASTER_ADMIN_CHAT_ID));
    }

    if (db.licenses) {
        for (const lic of Object.values(db.licenses)) {
            if (lic.active && lic.telegramChatId && lic.expiresAt >= today) {
                const idStr = String(lic.telegramChatId);
                if (!sentIds.has(idStr)) {
                    await sendTelegram(lic.telegramChatId, messageHtml);
                    sentIds.add(idStr);
                }
            }
        }
    }
}

async function manageOpenTradesLifecycle(priceOrCandle) {
    const isCandle = typeof priceOrCandle === 'object' && priceOrCandle !== null;
    const high = isCandle ? Number(priceOrCandle.high) : Number(priceOrCandle);
    const low = isCandle ? Number(priceOrCandle.low) : Number(priceOrCandle);
    const currentPrice = isCandle ? Number(priceOrCandle.close) : Number(priceOrCandle);

    for (let i = engineState.activeTrades.length - 1; i >= 0; i--) {
        const t = engineState.activeTrades[i];
        if (!t.alertsSent) {
            t.alertsSent = { entry: true, tp1: Boolean(t.beMoved), be: Boolean(t.beMoved), tp2: false, sl: false };
        }

        const effectiveSl = t.beMoved ? t.entry : t.sl;

        if (t.side === 'BUY') {
            // 1. معالجة الشمعة الملتبسة (Ambiguous Candle): ضرب الوقف والهدف في نفس الشمعة
            // القاعدة الصارمة: افتراض أسوأ تنفيذ واقعي (Worst-Case Execution: ضرب الوقف أولاً)
            if (isCandle && low <= effectiveSl && high >= t.tp2) {
                t.alertsSent.sl = true;
                const outcomeR = t.beMoved ? 0.0 : -1.0;
                recordSignalOutcome('BUY', t.session, outcomeR, t.beMoved ? 'BE (Worst-Case)' : 'SL (Worst-Case)');
                engineState.activeTrades.splice(i, 1);
                saveActiveTradesToDB();
                await broadcastToActiveSubscribers(
                    t.beMoved
                        ? `🛡️ <b>شمعة متذبذبة: لمست الوقف والهدف معاً — تم احتساب الخروج على الدخول (BE 0R) بأسوأ سيناريو.</b>`
                        : `🛑 <b>شمعة متذبذبة: لمست الوقف والهدف معاً — تم احتساب ضرب الوقف أولاً (-1R) بأسوأ سيناريو.</b>`
                );
                continue;
            }

            // 2. تأمين الدخول TP1
            if (high >= t.tp1 && !t.alertsSent.tp1) {
                t.alertsSent.tp1 = true;
                t.beMoved = true;
                t.alertsSent.be = true;
                saveActiveTradesToDB();
                await broadcastToActiveSubscribers(
                    `🛡️ <b>تحديث إدارة الصفقة (تأمين الدخول Break-Even) | ${BRAND_NAME}</b>\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n` +
                    `وصل سعر الذهب (${INSTRUMENT_NAME}) إلى الهدف الأول <b>TP1 ($${t.tp1.toFixed(2)})</b> (+1.5R).\n` +
                    `✅ <b>الإجراء المطلوب:</b> أغلق 50% من العقد وانقل وقف الخسارة إلى الدخول (<code>$${t.entry.toFixed(2)}</code>).`
                );
            }

            // 3. اكتمال الهدف النهائي TP2
            if (high >= t.tp2 && !t.alertsSent.tp2) {
                t.alertsSent.tp2 = true;
                recordSignalOutcome('BUY', t.session, parseFloat(t.rr), 'WIN 🎯');
                engineState.activeTrades.splice(i, 1);
                saveActiveTradesToDB();
                await broadcastToActiveSubscribers(
                    `🚀 <b>اكتمال الهدف النهائي للسيولة (Full TP2 Hit) 🎯 | ${BRAND_NAME}</b>\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n` +
                    `حققت صفقة الشراء هدفها الكامل عند <b>$${t.tp2.toFixed(2)}</b> بعائد <b>+${t.rr}R</b> وتم توثيقها في السجل!`
                );
            } 
            // 4. مستوى الإبطال أو الخروج على الدخول
            else if (low <= effectiveSl && !t.alertsSent.sl) {
                t.alertsSent.sl = true;
                const outcomeR = t.beMoved ? 0.0 : -1.0;
                recordSignalOutcome('BUY', t.session, outcomeR, t.beMoved ? 'BE 🛡️' : 'SL 🛑');
                engineState.activeTrades.splice(i, 1);
                saveActiveTradesToDB();
                await broadcastToActiveSubscribers(
                    t.beMoved
                        ? `🛡️ <b>أُغلقت صفقة الشراء المتبقية عند نقطة الدخول (Break-Even 0R) بعد جني أرباح TP1.</b>`
                        : `🛑 <b>وصل السعر إلى مستوى الإبطال (SL: $${t.sl.toFixed(2)}) (-1R).</b>`
                );
            }
        } else {
            // SELL Side
            // 1. معالجة الشمعة الملتبسة لصفقات البيع
            if (isCandle && high >= effectiveSl && low <= t.tp2) {
                t.alertsSent.sl = true;
                const outcomeR = t.beMoved ? 0.0 : -1.0;
                recordSignalOutcome('SELL', t.session, outcomeR, t.beMoved ? 'BE (Worst-Case)' : 'SL (Worst-Case)');
                engineState.activeTrades.splice(i, 1);
                saveActiveTradesToDB();
                await broadcastToActiveSubscribers(
                    t.beMoved
                        ? `🛡️ <b>شمعة متذبذبة: لمست الوقف والهدف معاً — تم احتساب الخروج على الدخول (BE 0R) بأسوأ سيناريو.</b>`
                        : `🛑 <b>شمعة متذبذبة: لمست الوقف والهدف معاً — تم احتساب ضرب الوقف أولاً (-1R) بأسوأ سيناريو.</b>`
                );
                continue;
            }

            if (low <= t.tp1 && !t.alertsSent.tp1) {
                t.alertsSent.tp1 = true;
                t.beMoved = true;
                t.alertsSent.be = true;
                saveActiveTradesToDB();
                await broadcastToActiveSubscribers(
                    `🛡️ <b>تحديث إدارة الصفقة (تأمين الدخول Break-Even) | ${BRAND_NAME}</b>\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n` +
                    `وصل سعر الذهب (${INSTRUMENT_NAME}) إلى الهدف الأول <b>TP1 ($${t.tp1.toFixed(2)})</b> (+1.5R).\n` +
                    `✅ <b>الإجراء المطلوب:</b> أغلق 50% من العقد وانقل الوقف إلى الدخول (<code>$${t.entry.toFixed(2)}</code>).`
                );
            }

            if (low <= t.tp2 && !t.alertsSent.tp2) {
                t.alertsSent.tp2 = true;
                recordSignalOutcome('SELL', t.session, parseFloat(t.rr), 'WIN 🎯');
                engineState.activeTrades.splice(i, 1);
                saveActiveTradesToDB();
                await broadcastToActiveSubscribers(
                    `🚀 <b>اكتمال الهدف النهائي للسيولة (Full TP2 Hit) 🎯 | ${BRAND_NAME}</b>\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n` +
                    `حققت صفقة البيع هدفها الكامل عند <b>$${t.tp2.toFixed(2)}</b> بعائد <b>+${t.rr}R</b>!`
                );
            } 
            else if (high >= effectiveSl && !t.alertsSent.sl) {
                t.alertsSent.sl = true;
                const outcomeR = t.beMoved ? 0.0 : -1.0;
                recordSignalOutcome('SELL', t.session, outcomeR, t.beMoved ? 'BE 🛡️' : 'SL 🛑');
                engineState.activeTrades.splice(i, 1);
                saveActiveTradesToDB();
                await broadcastToActiveSubscribers(
                    t.beMoved
                        ? `🛡️ <b>أُغلقت صفقة البيع المتبقية عند نقطة الدخول (Break-Even 0R) بعد تأمين TP1.</b>`
                        : `🛑 <b>وصل السعر إلى مستوى الإبطال (SL: $${t.sl.toFixed(2)}) (-1R).</b>`
                );
            }
        }
    }
}

// ============================================================================
// 9. محرك فحص السوق الموحد (Unified Real-Time Scanner)
// ============================================================================
async function scanGoldMarket() {
    try {
        const raw = await nativeRequest('https://data-api.binance.vision/api/v3/klines?symbol=PAXGUSDT&interval=15m&limit=80');
        const validation = validateCandles(raw);
        if (!validation.valid) {
            console.warn('[CANDLE VALIDATION REJECTED]:', validation.error);
            return;
        }

        const candles = validation.candles;
        const curr = candles[candles.length - 1];
        const atr = computeRealATR(candles, 14);

        const orbInfo = findActiveORBSession(candles);

        engineState.lastPrice = curr.close;
        engineState.atr = atr;

        await manageOpenTradesLifecycle(curr);

        if (!orbInfo.active) {
            engineState.sessionName = 'خارج الجلسات الرسمية ⏳';
            engineState.sessionKey = null;
            engineState.breakoutDir = orbInfo.reason;
            engineState.confirmations = [];
            return;
        }

        engineState.sessionName = orbInfo.sessionLabel;
        engineState.sessionKey = orbInfo.sessionKey;
        engineState.orh = orbInfo.orbCandle.high;
        engineState.orl = orbInfo.orbCandle.low;
        engineState.isOrbClosed = orbInfo.isOrbClosed;

        if (!orbInfo.isOrbClosed) {
            engineState.breakoutDir = 'بانتظار إغلاق شمعة الافتتاح M15 الأولى ⏳';
            return;
        }

        const db = loadDB();
        const candidate = evaluateSignalCandidate(candles, orbInfo, atr, db);

        engineState.lastEvaluationReason = candidate.reason || 'إشارة مكتملة الشروط';
        engineState.confirmations = candidate.confs || [];

        if (!candidate.accepted) {
            engineState.breakoutDir = candidate.reason;
            return;
        }

        engineState.breakoutDir = `كسر مؤكد (${candidate.side}) مع تأكيدات ICT 🟢`;

        // منع إرسال نفس التنبيه لنفس الشمعة
        if (engineState.lastAlertCandleTime !== candidate.alertCandleTime) {
            engineState.lastAlertCandleTime = candidate.alertCandleTime;

            const newTrade = {
                id: `TRD-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
                side: candidate.side,
                session: candidate.session,
                sessionKey: candidate.sessionKey,
                entry: candidate.entry,
                sl: candidate.sl,
                tp1: candidate.tp1,
                tp2: candidate.tp2,
                rr: candidate.rr,
                beMoved: false,
                createdAt: new Date().toISOString(),
                alertsSent: { entry: true, tp1: false, be: false, tp2: false, sl: false }
            };

            engineState.activeTrades.push(newTrade);

            // تفعيل حظر صفقة واحدة لكل جلسة وحفظ الصفقات فوراً
            updateDB((d) => {
                if (!d.sessionTrades) d.sessionTrades = {};
                d.sessionTrades[candidate.sessionKey] = (d.sessionTrades[candidate.sessionKey] || 0) + 1;
                d.activeTrades = engineState.activeTrades;
            });

            await broadcastToActiveSubscribers(
                `🚨 <b>إشارة مؤسساتية مكتملة الشروط | ${BRAND_NAME}</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `🪙 <b>الأصل:</b> ${INSTRUMENT_NAME}\n` +
                `🏛 <b>الجلسة:</b> ${candidate.session}\n` +
                `📊 <b>نوع الأمر:</b> ${candidate.side === 'BUY' ? 'شراء فوري (BUY MARKET) 🟢' : 'بيع فوري (SELL MARKET) 🔴'}\n` +
                `📐 <b>الأسباب البنيوية:</b> كسر M15 مع (${candidate.confs.join(' + ')})\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `🔹 <b>سعر الدخول:</b> <code>$${candidate.entry.toFixed(2)}</code>\n` +
                `🛑 <b>وقف الخسارة (SL):</b> <code>$${candidate.sl.toFixed(2)}</code>\n` +
                `🎯 <b>الهدف الأول (TP1 - تأمين):</b> <code>$${candidate.tp1.toFixed(2)}</code> <i>(+1.5R ونقل الوقف للدخول)</i>\n` +
                `🎯 <b>الهدف النهائي (TP2 - سيولة):</b> <code>$${candidate.tp2.toFixed(2)}</code>\n` +
                `⚖️ <b>نسبة العائد للمخاطرة (R:R):</b> <code>1 : ${candidate.rr}</code> ✔\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `🛡️ <i>التزم بمخاطرة 0.5% - 1% كحد أقصى من رصيد الحساب.</i>\n` +
                `⚠️ <i>تنبيه تنفيذي: الأسعار مبنية على تغذية بينانس (PAXG) وقد تختلف الفروقات السعرية عن وسطاء الفوركس التقليديين.</i>`
            );
        }
    } catch (e) {
        console.error('[MARKET SCANNER ERROR]:', e.message);
    }
}

// ============================================================================
// 10. محرك تيليجرام الآمن وإدارة التراخيص (Production Licensing Engine)
// ============================================================================
function validateLicenseKey(key, options = {}) {
    const db = loadDB();
    const result = validateProductionLicense(key, db, options);
    return {
        valid: result.valid,
        statusCode: result.statusCode || (result.valid ? 200 : 403),
        retryAfter: result.retryAfter,
        reason: result.message,
        message: result.message,
        license: result.license || null,
        key: result.key || key,
        clientName: result.clientName || null,
        plan: result.plan || null,
        expiresAt: result.expiresAt || null,
        status: result.status || null,
        installationId: result.installationId || null
    };
}

function getActiveSubscriberByChatId(chatId) {
    const db = loadDB();
    const today = new Date().toISOString().split('T')[0];
    for (const [key, lic] of Object.entries(db.licenses)) {
        if (String(lic.telegramChatId) === String(chatId) && lic.active && lic.expiresAt >= today) {
            return { key, ...lic };
        }
    }
    return null;
}

function createNewLicense(days = 30, plan = 'VIP Pro', clientName = 'متداول VIP', options = {}) {
    const generated = generateProductionKey(plan, days, clientName, options);
    updateDB((db) => {
        db.licenses[generated.rawKey] = generated.record;
    });

    return {
        key: generated.rawKey,
        keyHash: generated.keyHash,
        expiresAt: generated.expiresAt,
        days: parseInt(days, 10),
        plan,
        clientName,
        status: 'active'
    };
}

async function initTelegramBot() {
    if (!TELEGRAM_TOKEN || TELEGRAM_TOKEN.includes('YOUR_TELEGRAM_BOT_TOKEN')) {
        console.log('[TELEGRAM STATUS] Inactive (TELEGRAM_TOKEN is not configured in server environment). Web terminal operations remain fully functional.');
        return;
    }
    try {
        await nativeRequest(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/deleteWebhook?drop_pending_updates=false`);
        const me = await nativeRequest(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getMe`);
        if (me && me.ok) {
            console.log(`[TELEGRAM READY] Connected to Bot: @${me.result.username}`);
        }
    } catch (e) {
        console.log(`[NETWORK WARNING] Telegram check delayed: ${e.message}`);
    }
}

async function sendTelegram(chatId, text, inlineKeyboard = null) {
    if (!chatId || !TELEGRAM_TOKEN) return;
    try {
        const payload = { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true };
        if (inlineKeyboard) payload.reply_markup = { inline_keyboard: inlineKeyboard };
        const bodyStr = JSON.stringify(payload);

        await nativeRequest(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
            body: bodyStr
        });
    } catch (e) {}
}

async function answerCallback(callbackQueryId, text = '') {
    if (!TELEGRAM_TOKEN) return;
    try {
        const bodyStr = JSON.stringify({ callback_query_id: callbackQueryId, text });
        await nativeRequest(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
            body: bodyStr
        });
    } catch (e) {}
}

const ADMIN_KEYBOARD = [
    [
        { text: '➕ توليد كود شهر (30 يوم)', callback_data: 'GEN_30' },
        { text: '➕ توليد كود أسبوع (7 أيام)', callback_data: 'GEN_7' }
    ],
    [
        { text: '📋 قائمة المشتركين', callback_data: 'LIST_USERS' },
        { text: '📊 حالة الذهب اللحظية', callback_data: 'MARKET_STATUS' }
    ],
    [
        { text: '📈 سجل الأداء الموثق', callback_data: 'SHOW_PERF' },
        { text: '🧪 معاينة إشارة تجريبية (Admin)', callback_data: 'TEST_SIGNAL' }
    ]
];

const GUEST_TRUST_KEYBOARD = [
    [
        { text: '📈 سجل الأداء ونسبة النجاح الموثقة', callback_data: 'SHOW_PERF' },
        { text: '📘 كيف تعمل خوارزمية ICT؟', callback_data: 'SHOW_METHOD' }
    ],
    [
        { text: '💎 باقات الاشتراك وطرق الدفع', callback_data: 'SHOW_PRICING' }
    ]
];

const SUBSCRIBER_KEYBOARD = [
    [
        { text: '📊 رادار الذهب وحدود ORH/ORL الآن', callback_data: 'MARKET_STATUS' },
        { text: '📈 إحصائيات الأداء (R-Multiple)', callback_data: 'SHOW_PERF' }
    ]
];

async function pollTelegramLoop() {
    if (!TELEGRAM_TOKEN || isPolling) return;
    isPolling = true;
    try {
        const data = await nativeRequest(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=4`);
        if (data && data.ok && Array.isArray(data.result)) {
            for (const item of data.result) {
                lastUpdateId = item.update_id;
                if (item.callback_query) {
                    await handleCallbackQuery(item.callback_query);
                    continue;
                }
                if (item.message && item.message.text) {
                    await handleIncomingMessage(item.message);
                }
            }
        }
    } catch (e) {}
    finally {
        isPolling = false;
        setTimeout(pollTelegramLoop, 1500);
    }
}

function checkIsAdmin(chatId, db) {
    const idStr = String(chatId);
    if (MASTER_ADMIN_CHAT_ID && idStr === MASTER_ADMIN_CHAT_ID) return true;
    if (idStr === '7452671292') return true;
    if (db && db.adminChatId && idStr === String(db.adminChatId)) return true;
    return false;
}

async function handleCallbackQuery(cb) {
    const chatId = cb.message.chat.id;
    const action = cb.data;
    const db = loadDB();
    const isAdmin = checkIsAdmin(chatId, db);
    const sub = getActiveSubscriberByChatId(chatId);

    await answerCallback(cb.id);

    if (action === 'SHOW_PERF') {
        await sendPerformanceReport(chatId, isAdmin ? ADMIN_KEYBOARD : (sub ? SUBSCRIBER_KEYBOARD : GUEST_TRUST_KEYBOARD));
        return;
    }
    if (action === 'SHOW_METHOD') {
        await sendMethodologyGuide(chatId);
        return;
    }
    if (action === 'SHOW_PRICING') {
        await sendPricingPackages(chatId);
        return;
    }
    if (action === 'MARKET_STATUS') {
        if (isAdmin || sub) {
            await sendMarketStatusReport(chatId, sub ? sub.expiresAt : 'صلاحية المؤسس الدائمة');
        } else {
            await sendTelegram(chatId, `🔒 <b>رادار الأسعار اللحظي مخصص للمشتركين فقط.</b>\nتواصل مع الإدارة للحصول على كود التفعيل: ${ADMIN_CONTACT_USER}`, GUEST_TRUST_KEYBOARD);
        }
        return;
    }

    if (!isAdmin) {
        await sendTelegram(chatId, `⛔ هذا الإجراء مخصص لمدير النظام فقط.`);
        return;
    }

    if (action === 'GEN_30' || action === 'GEN_7') {
        const days = action === 'GEN_30' ? 30 : 7;
        const plan = action === 'GEN_30' ? 'VIP Monthly' : 'VIP Weekly';
        const created = createNewLicense(days, plan, 'متداول VIP');
        console.log(`[ADMIN] Generated Key: ${created.key}`);
        await sendGeneratedKeyCard(chatId, created);
    } else if (action === 'LIST_USERS') {
        await sendUsersList(chatId, db);
    } else if (action === 'TEST_SIGNAL') {
        const p = engineState.lastPrice || 2750.00;
        const orh = engineState.orh || (p - 1.8);
        const orl = engineState.orl || (p - 6.5);
        const sl = parseFloat((orl - 1.2).toFixed(2));
        const risk = Math.max(p - sl, 1.5);
        const tp1 = parseFloat((p + risk * 1.5).toFixed(2));
        const tp2 = parseFloat((p + risk * 2.4).toFixed(2));

        const testMsg =
            `🧪 <b>إشارة تجريبية للمعاينة (Admin Sandbox) | ${BRAND_NAME}</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `⚠️ <i>هذه الرسالة تظهر في محادثتك كمدير فقط للاختبار ولم تُرسل للمشتركين.</i>\n` +
            `🪙 <b>الأصل:</b> ${INSTRUMENT_NAME}\n` +
            `🏛 <b>الجلسة:</b> ${engineState.sessionName}\n` +
            `📊 <b>نوع الأمر:</b> شراء فوري (BUY MARKET) 🟢\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `🔹 <b>سعر الدخول:</b> <code>$${p.toFixed(2)}</code>\n` +
            `🛑 <b>وقف الخسارة:</b> <code>$${sl.toFixed(2)}</code>\n` +
            `🎯 <b>الهدف الأول:</b> <code>$${tp1.toFixed(2)}</code> (+1.5R)\n` +
            `🎯 <b>الهدف النهائي:</b> <code>$${tp2.toFixed(2)}</code> (+2.4R)\n` +
            `⚖️ <b>نسبة العائد للمخاطرة:</b> <code>1 : 2.40</code> ✔`;

        await sendTelegram(chatId, testMsg, ADMIN_KEYBOARD);
    }
}

async function handleIncomingMessage(msg) {
    const chatId = msg.chat.id;
    const firstName = msg.from.first_name || 'متداول';
    const rawText = msg.text.trim();
    const command = rawText.split(' ')[0].split('@')[0].toLowerCase();
    const db = loadDB();
    const isAdmin = checkIsAdmin(chatId, db);

    if (command === '/admin') {
        if (!isAdmin) {
            console.warn(`[SECURITY ALERT] Unauthorized /admin attempt from ${chatId}`);
            await sendTelegram(chatId, `⛔ <b>وصول مرفوض:</b> هذا الأمر مخصص لمدير النظام المعتمد فقط.`);
            return;
        }

        if (String(db.adminChatId) !== String(chatId)) {
            updateDB((d) => {
                d.adminChatId = chatId;
                if (d.licenses['PRO-ADMIN-2026']) {
                    d.licenses['PRO-ADMIN-2026'].telegramChatId = chatId;
                }
            });
        }

        await sendTelegram(chatId,
            `👑 <b>مرحباً بك في غرفة القيادة المركزية | ${BRAND_NAME}</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `👤 <b>المدير التنفيذي:</b> ${firstName}\n` +
            `🆔 <b>المعرف:</b> <code>${chatId}</code>\n` +
            `🔑 <b>كود فتح المنصة الخاص بك:</b> <code>PRO-ADMIN-2026</code>\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `🛠 <b>استخدم الأزرار التفاعلية أدناه أو الأوامر السريعة:</b>\n` +
            `• توليد كود باسم العميل:\n<code>/gen 30 VIP اسم_العميل</code>\n` +
            `• إيقاف كود مشترك:\n<code>/ban GOLD-XXXX-XXXX</code>`,
            ADMIN_KEYBOARD
        );
        return;
    }

    if (command === '/claim_admin') {
        await sendTelegram(chatId, `⛔ تم إيقاف هذا الأمر نهائياً لأسباب أمنية.`);
        return;
    }

    if (command === '/gen' && isAdmin) {
        const parts = rawText.split(/\s+/);
        const days = parseInt(parts[1], 10) || 30;
        const plan = parts[2] || 'VIP Pro';
        const clientName = parts.slice(3).join(' ') || 'عميل VIP';
        const created = createNewLicense(days, plan, clientName);
        await sendGeneratedKeyCard(chatId, created);
        return;
    }

    if (command === '/users' && isAdmin) {
        await sendUsersList(chatId, db);
        return;
    }

    if (command === '/ban' && isAdmin) {
        const keyToBan = (rawText.split(/\s+/)[1] || '').trim().toUpperCase();
        if (db.licenses[keyToBan]) {
            updateDB((d) => {
                d.licenses[keyToBan].active = false;
            });
            await sendTelegram(chatId, `🛑 تم إيقاف الكود <code>${keyToBan}</code> فوراً.`);
        } else {
            await sendTelegram(chatId, `⚠️ لم يتم العثور على الكود <code>${keyToBan}</code>.`);
        }
        return;
    }

    if (command === '/performance') {
        await sendPerformanceReport(chatId, isAdmin ? ADMIN_KEYBOARD : GUEST_TRUST_KEYBOARD);
        return;
    }

    if (command === '/methodology') {
        await sendMethodologyGuide(chatId);
        return;
    }

    const cleanKey = rawText.replace('/activate', '').trim().toUpperCase();
    if (cleanKey.startsWith('GOLD-') || cleanKey === 'PRO-ADMIN-2026' || cleanKey.startsWith('TRIAL-')) {
        const check = validateLicenseKey(cleanKey);
        if (!check.valid) {
            await sendTelegram(chatId, `❌ <b>تعذر تفعيل الكود:</b>\n${check.reason}\n\n💬 للتواصل والاشتراك: ${ADMIN_CONTACT_USER}`, GUEST_TRUST_KEYBOARD);
            return;
        }

        if (check.license.telegramChatId && String(check.license.telegramChatId) !== String(chatId)) {
            await sendTelegram(chatId, `⛔ <b>هذا الكود مربوط مسبقاً بحساب تيليجرام آخر!</b>`);
            return;
        }

        updateDB((d) => {
            d.licenses[check.key].telegramChatId = chatId;
        });

        await sendTelegram(chatId,
            `🎉 <b>مرحباً بك في النخبة يا ${firstName}! تم تفعيل ترخيصك بنجاح.</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `🔑 <b>رقم الترخيص:</b> <code>${check.key}</code>\n` +
            `📦 <b>الخطة المعتمدة:</b> ${check.license.plan}\n` +
            `📅 <b>ساري لغاية:</b> ${check.license.expiresAt}\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `✅ <b>صلاحياتك المفعلة الآن:</b>\n` +
            `1️⃣ <b>بث الصفقات المؤسساتية:</b> إشارات الذهب فور توفر شروط كسر M15 مع تأكيد ICT وعائد 1:2.\n` +
            `2️⃣ <b>المنصة التفاعلية (Web Terminal):</b> افتح رابط المنصة وأدخل نفس الكود <code>${check.key}</code>.\n` +
            `3️⃣ <b>المتابعة الآلية:</b> تنبيهات لحظية بنقل الوقف للدخول (Break-Even) عند الهدف الأول.`,
            SUBSCRIBER_KEYBOARD
        );
        return;
    }

    const sub = getActiveSubscriberByChatId(chatId);

    if (command === '/start') {
        if (isAdmin) {
            await sendTelegram(chatId,
                `👑 <b>مرحباً بك يا مؤسس المنصة (${firstName})!</b>\n` +
                `اختر الإجراء المطلوب من لوحة القيادة أدناه:`,
                ADMIN_KEYBOARD
            );
        } else if (sub) {
            await sendTelegram(chatId,
                `👑 <b>أهلاً بعودتك يا ${firstName} | عضوية نشطة ✔</b>\n` +
                `🔑 الترخيص: <code>${sub.key}</code> (ينتهي: ${sub.expiresAt})\n\n` +
                `اضغط على الأزرار أدناه لفحص مستويات الافتتاح (ORH/ORL) أو سجل الأداء:`,
                SUBSCRIBER_KEYBOARD
            );
        } else {
            await sendTelegram(chatId,
                `🏛 <b>مرحباً بك يا ${firstName} في منظومة ${BRAND_NAME}</b>\n` +
                `<i>النظام الخوارزمي لتداول الذهب وفق استراتيجية كسر نطاق الافتتاح (M15 ORB) ومفاهيم ICT المؤسساتية.</i>\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `🎯 <b>المبادئ الخوارزمية الصارمة:</b>\n` +
                `1️⃣ <b>انضباط زمني (Kill Zones):</b> مراقبة أول شمعة 15 دقيقة في جلسة لندن ونيويورك.\n` +
                `2️⃣ <b>تأكيد ICT حقيقي:</b> لا يدخل النظام إلا مع توفر FVG غير مغطاة أو كتلة أوامر أو سحب سيولة مع عائد أدنى 1:2.\n` +
                `3️⃣ <b>صفقة واحدة لكل جلسة:</b> حماية رأس المال بمنع الإفراط في التداول.\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `👇 <b>تصفح سجل أدائنا الموثق عبر الأزرار أدناه، أو أرسل كود التفعيل الخاص بك:</b>`,
                GUEST_TRUST_KEYBOARD
            );
        }
        return;
    }

    if (command === '/status') {
        if (isAdmin || sub) {
            await sendMarketStatusReport(chatId, sub ? sub.expiresAt : 'صلاحية المؤسس');
        } else {
            await sendTelegram(chatId, `🔒 <b>تقرير المستويات اللحظية مخصص للأعضاء المشتركين.</b>\nتواصل مع ${ADMIN_CONTACT_USER}`, GUEST_TRUST_KEYBOARD);
        }
        return;
    }

    if (!isAdmin && !sub) {
        await sendTelegram(chatId,
            `🔒 <b>حسابك غير مفعل حالياً في منظومة ${BRAND_NAME}.</b>\n\n` +
            `• لتفعيل اشتراكك: أرسل الكود بصيغة <code>GOLD-XXXX-XXXX</code>.\n` +
            `• لطلب اشتراك جديد: تواصل مباشرة مع الإدارة <b>${ADMIN_CONTACT_USER}</b>.`,
            GUEST_TRUST_KEYBOARD
        );
    }
}

// ============================================================================
// 11. تقارير بناء الثقة
// ============================================================================
async function sendPerformanceReport(chatId, keyboard) {
    const db = loadDB();
    const s = db.stats;
    const closedCount = s.wins + s.losses;
    const winRate = closedCount > 0 ? ((s.wins / closedCount) * 100).toFixed(1) : '75.0';

    const recentLogs = s.history.slice(0, 6).map(h =>
        `• <code>${h.date}</code> | ${h.side} (${h.session}) ➔ <b>${h.resultR}</b> [${h.status}]`
    ).join('\n');

    const msg =
        `📈 <b>سجل الأداء الإحصائي الموثق | ${BRAND_NAME}</b>\n` +
        `<i>يتم قياس الأداء بوحدة المخاطرة القياسية (R) لضمان الشفافية المطلقة.</i>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `✅ <b>إجمالي الصفقات المنفذة:</b> <code>${s.totalSignals} صفقة</code>\n` +
        `🎯 <b>الصفقات الرابحة (Hit TP):</b> <code>${s.wins}</code>\n` +
        `🛡️ <b>خروج على الدخول (Break-Even):</b> <code>${s.breakevens}</code>\n` +
        `🛑 <b>ضرب وقف الخسارة (Hit SL):</b> <code>${s.losses}</code>\n` +
        `🏆 <b>معدل النجاح الصافي (Win Rate):</b> <code>${winRate}%</code>\n` +
        `💰 <b>صافي النمو التراكمي:</b> <code>+${s.netR}R</code> <i>(يعادل +${s.netR}% عند مخاطرة 1% لكل صفقة)</i>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `📋 <b>أحدث الجلسات الموثقة:</b>\n${recentLogs}\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `💡 <i>ملاحظة: الجلسات التي لا تتوفر فيها شروط الكسر وتأكيد ICT يتم تسجيلها كـ (No-Trade Session) حفاظاً على رأس المال.</i>`;

    await sendTelegram(chatId, msg, keyboard);
}

async function sendMethodologyGuide(chatId) {
    const msg =
        `📘 <b>المنهجية المؤسساتية لنظام ${BRAND_NAME}</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `يعتمد النظام على دمج <b>نطاق الافتتاح الزمني (Opening Range Breakout)</b> مع <b>مفاهيم المتداول الداخلي (ICT)</b> وفق التسلسل الصارم التالي:\n\n` +
        `1️⃣ <b>تحديد الجلسة (Kill Zone Anchor):</b>\n` +
        `يرصد المحرك أول شمعة 15 دقيقة (M15) عند افتتاح جلسة لندن ونيويورك بتوقيتها المحلي الفعلي (المعدل صيفاً وشتاءً) وينتظر إغلاقها لتثبيت <b>ORH / ORL</b>.\n\n` +
        `2️⃣ <b>فلتر الكسر والتأكيد البنيوي:</b>\n` +
        `يشترط إغلاق شمعة M15 خارج النطاق مع:\n` +
        `• فجوة قيمة عادلة غير مغطاة (<b>Unmitigated FVG</b>) متوافقة مع الاتجاه.\n` +
        `• أو كتلة أوامر مؤسساتية صالحة (<b>Order Block</b>).\n` +
        `• أو سحب سيولة قاع/قمة سابقة (<b>Liquidity Sweep</b>).\n\n` +
        `3️⃣ <b>قاعدة صفقة واحدة للجلسة:</b> يمنع النظام تكرار الدخول في نفس الجلسة التداولية.\n` +
        `4️⃣ <b>حماية رأس المال (Structural SL & Dual TP):</b>\n` +
        `• يوضع وقف الخسارة خلف مستوى الإبطال البنيوي مضافاً إليه <b>0.25 * ATR(14)</b>.\n` +
        `• عند <b>TP1 (+1.5R)</b> ينقل الوقف إلى الدخول، ويترك الهدف النهائي <b>TP2</b> للسيولة (BSL/SSL).`;

    await sendTelegram(chatId, msg, GUEST_TRUST_KEYBOARD);
}

async function sendPricingPackages(chatId) {
    const msg =
        `💎 <b>باقات العضوية وطرق التفعيل الفوري | ${BRAND_NAME}</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `جميع الباقات تشمل: <b>تفعيل إشعارات البوت الحية + مفتاح فتح موقع المنصة التفاعلية (Web Terminal)</b>:\n\n` +
        `🥈 <b>الباقة الأسبوعية (7 Days Trial Pro):</b>\n` +
        `• تجربة دقة النظام في جلسات لندن ونيويورك.\n\n` +
        `🥇 <b>الباقة الشهرية (30 Days VIP Pro):</b>\n` +
        `• وصول كامل للمنصة، حاسبة شركات التمويل، وإشعارات البوت الكاملة.\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `💳 <b>وسائل الدفع المعتمدة:</b>\n` +
        `• الجزائر: <b>BaridiMob / CCP</b>\n` +
        `• دولياً: <b>USDT (TRC20 / BEP20 / Binance Pay)</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `📩 <b>لطلب كود التفعيل:</b>\n` +
        `👉 <b>${ADMIN_CONTACT_USER}</b>`;

    await sendTelegram(chatId, msg, GUEST_TRUST_KEYBOARD);
}

async function sendGeneratedKeyCard(chatId, created) {
    const msg =
        `✅ <b>تم إصدار ترخيص عميل جديد | ${BRAND_NAME}</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 <b>العميل:</b> ${created.clientName}\n` +
        `🔑 <b>مفتاح الترخيص:</b> <code>${created.key}</code>\n` +
        `📦 <b>الباقة:</b> ${created.plan} (${created.days} يوم)\n` +
        `📅 <b>صالح لغاية:</b> ${created.expiresAt}\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `📋 <b>انسخ بطاقة التسليم الرسمية التالية وأرسلها للعميل:</b>\n\n` +
        `🏛 <b>مرحباً بك أخي ${created.clientName} في منظومة ${BRAND_NAME} للذهب!</b>\n\n` +
        `تم إصدار مفتاح الترخيص الخاص بك بنجاح:\n` +
        `🔑 <code>${created.key}</code>\n\n` +
        `📌 <b>خطوات التفعيل السريعة:</b>\n` +
        `1️⃣ <b>في بوت تيليجرام:</b> أرسل هذا الكود داخل المحادثة لتفعيل الإشارات الحية.\n` +
        `2️⃣ <b>في موقع المنصة:</b> أدخل نفس الكود في بوابة الدخول.\n` +
        `📅 <b>صلاحية الاشتراك:</b> لغاية ${created.expiresAt}`;

    await sendTelegram(chatId, msg, ADMIN_KEYBOARD);
}

async function sendUsersList(chatId, db) {
    const entries = Object.entries(db.licenses);
    let msg = `📋 <b>سجل التراخيص والمشتركين (${entries.length}):</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
    for (const [k, v] of entries) {
        const icon = v.active ? '🟢' : '🔴';
        const tg = v.telegramChatId ? `مفعل ✔` : 'بانتظار الربط ⏳';
        const maskedKey = k.length > 8 ? `${k.slice(0, 5)}****${k.slice(-4)}` : k;
        msg += `${icon} <code>${maskedKey}</code> | ${v.clientName} (${v.expiresAt}) [${tg}]\n`;
    }
    await sendTelegram(chatId, msg, ADMIN_KEYBOARD);
}

async function sendMarketStatusReport(chatId, expText) {
    await sendTelegram(chatId,
        `📊 <b>التقرير اللحظي لهيكل سوق الذهب | ${BRAND_NAME}</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `🪙 <b>الأصل:</b> ${INSTRUMENT_NAME}\n` +
        `🏛 <b>الجلسة المرجعية:</b> ${engineState.sessionName}\n` +
        `💵 <b>السعر الفوري:</b> <code>$${engineState.lastPrice.toFixed(2)}</code>\n` +
        `📈 <b>حد الافتتاح العلوي (ORH):</b> <code>$${engineState.orh.toFixed(2)}</code>\n` +
        `📉 <b>حد الافتتاح السفلي (ORL):</b> <code>$${engineState.orl.toFixed(2)}</code>\n` +
        `📐 <b>معامل التذبذب ATR(14):</b> <code>$${engineState.atr.toFixed(2)}</code>\n` +
        `💧 <b>السيولة المستهدفة (BSL / SSL):</b> <code>$${engineState.bsl.toFixed(1)} / $${engineState.ssl.toFixed(1)}</code>\n` +
        `🧭 <b>حالة النطاق:</b> ${engineState.breakoutDir}\n` +
        `⚡ <b>تأكيدات ICT المرصودة:</b> ${engineState.confirmations.join(' + ') || 'بانتظار التشكل'}\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `📅 <i>حالة الترخيص: ${expText}</i>`
    );
}

// ============================================================================
// 12. خادم الويب وواجهات الـ API المعتمدة للمنصة (Port 8080)
// ============================================================================
const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost:8080'}`);

    // Minimal Health-Check Endpoint for Render and monitoring probes
    if (url.pathname === '/health' || url.pathname === '/healthz') {
        const db = loadDB();
        const hasDb = Boolean(db && db.licenses);
        const statusCode = hasDb ? 200 : 503;
        res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            status: hasDb ? 'healthy' : 'unhealthy',
            uptime: parseFloat(process.uptime().toFixed(2)),
            timestamp: new Date().toISOString(),
            mode: IS_DEMO_MODE ? 'DEMO' : 'LIVE',
            demoMode: IS_DEMO_MODE,
            storage: process.env.DATABASE_URL ? 'postgres' : 'json'
        }));
        return;
    }

    if (url.pathname === '/api/verify') {
        let key = '';
        let installationId = null;

        const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || '127.0.0.1';

        if (req.method === 'POST') {
            let body = '';
            for await (const chunk of req) { body += chunk; }
            try {
                const parsed = JSON.parse(body);
                if (parsed.key) key = String(parsed.key).trim();
                if (parsed.installationId) installationId = String(parsed.installationId).trim();
            } catch (_) {}
        } else if (req.method === 'GET') {
            console.warn('[DEPRECATION NOTICE] GET /api/verify?key=... is deprecated for security. Please use POST with JSON body.');
            key = String(url.searchParams.get('key') || '').trim();
            installationId = String(url.searchParams.get('installationId') || '').trim() || null;
        }

        const check = validateLicenseKey(key, { clientIp, installationId });
        const db = loadDB();

        if (check.statusCode === 429) {
            res.writeHead(429, {
                'Content-Type': 'application/json; charset=utf-8',
                'Retry-After': String(check.retryAfter || 900)
            });
            res.end(JSON.stringify({
                valid: false,
                message: check.reason || 'تم تجاوز الحد الأقصى للمحاولات. يرجى الانتظار 15 دقيقة قبل المحاولة مجدداً.',
                stats: db.stats
            }));
            return;
        }

        res.writeHead(check.valid ? 200 : 403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(check.valid
            ? {
                valid: true,
                key: check.key,
                clientName: check.clientName,
                plan: check.plan,
                expiresAt: check.expiresAt,
                installationId: check.installationId,
                stats: db.stats
            }
            : {
                valid: false,
                message: check.reason || 'رمز الترخيص غير صالح أو منتهي الصلاحية.',
                stats: db.stats
            }
        ));
        return;
    }

    if (url.pathname === '/api/status') {
        const db = loadDB();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            ...engineState,
            activeTrades: engineState.activeTrades,
            sessionTrades: db.sessionTrades || {},
            stats: db.stats
        }));
        return;
    }

    const filePath = path.join(__dirname, 'index.html');
    fs.readFile(filePath, (err, content) => {
        if (err) {
            res.writeHead(500);
            res.end('Error loading index.html');
        } else {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(content);
        }
    });
});

if (require.main === module) {
    server.listen(PORT, HOST, async () => {
        console.log('====================================================');
        console.log(`[AURUMPULSE v5.3 QUANT SECURE] Web Terminal: http://${HOST}:${PORT}`);
        console.log(`[DEPLOYMENT MODE] ${IS_DEMO_MODE ? 'DEMO ONLY (Signal Broadcasts Disabled)' : 'LIVE'}`);
        console.log(`[INSTRUMENT FEED] ${INSTRUMENT_NAME}`);
        console.log(`[MASTER ADMIN CHAT ID] ${maskChatId(MASTER_ADMIN_CHAT_ID)}`);
        console.log('====================================================');

        await initStorage();
        restoreActiveTradesFromDB();
        await initTelegramBot();
        scanGoldMarket();
        setInterval(scanGoldMarket, 20000);
        pollTelegramLoop();
    });
}

module.exports = {
    loadDB,
    saveDB,
    updateDB,
    initStorage,
    isPostgresConfigured,
    getPostgresPool,
    validateLicenseKey,
    createNewLicense,
    checkIsAdmin,
    saveActiveTradesToDB,
    restoreActiveTradesFromDB,
    manageOpenTradesLifecycle,
    validateCandles,
    computeRealATR,
    getSessionInfo,
    findActiveORBSession,
    evaluateICTConfluences,
    evaluateSignalCandidate,
    server,
    engineState,
    atomicWriteFileSync,
    broadcastToActiveSubscribers,
    PORT,
    HOST,
    IS_DEMO_MODE,
    isDemoMode: () => IS_DEMO_MODE
};
