/**
 * AurumPulse ICT - Phase 3 Quantitative Strategy & Market Engine Regression Test Suite
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    validateCandles,
    computeRealATR,
    getSessionInfo,
    findActiveORBSession,
    evaluateICTConfluences,
    evaluateSignalCandidate,
    loadDB,
    updateDB,
    saveDB
} = require('../bot_engine.js');

console.log('========================================================');
console.log('RUNNING PHASE 3 STRATEGY & MARKET ENGINE TEST SUITE');
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
    // 1. فحص نزاهة بيانات الشموع (Task 1: Candle Integrity)
    // -------------------------------------------------------------------------
    it('1.1 validateCandles accepts valid OHLCV candles', () => {
        const mockRaw = [];
        const baseTime = 1729300000000;
        for (let i = 0; i < 40; i++) {
            mockRaw.push([
                baseTime + (i * 15 * 60 * 1000),
                '2750.00', '2755.00', '2748.00', '2752.00', '100'
            ]);
        }
        const res = validateCandles(mockRaw);
        assert.strictEqual(res.valid, true);
        assert.strictEqual(res.candles.length, 40);
        assert.strictEqual(res.candles[0].open, 2750.00);
    });

    it('1.2 validateCandles rejects malformed price structure (High < Low)', () => {
        const badRaw = [
            [1729300000000, '2750.00', '2740.00', '2755.00', '2752.00'] // High < Low!
        ];
        const res = validateCandles(badRaw);
        assert.strictEqual(res.valid, false);
    });

    it('1.3 validateCandles rejects non-monotonic timestamps', () => {
        const outOfOrder = [];
        for (let i = 0; i < 35; i++) {
            outOfOrder.push([1729300000000 + (i * 900000), '2750', '2755', '2745', '2750']);
        }
        outOfOrder[20][0] = outOfOrder[19][0] - 5000; // Out of order!
        const res = validateCandles(outOfOrder);
        assert.strictEqual(res.valid, false);
        assert(res.error.includes('Non-monotonic'));
    });

    // -------------------------------------------------------------------------
    // 2. فحص دقة تحديد الجلسات وحساب التوقيت الصيفي (Task 2: ORB & DST)
    // -------------------------------------------------------------------------
    it('2.1 getSessionInfo handles London summer (BST = UTC+1) and winter (GMT = UTC+0)', () => {
        // Summer timestamp: July 15, 2026, 07:00 UTC -> 08:00 BST London
        const summerDateSec = Math.floor(new Date('2026-07-15T07:00:00Z').getTime() / 1000);
        const summerInfo = getSessionInfo(summerDateSec);
        assert.strictEqual(summerInfo.lHour, 8, '07:00 UTC in July must be 08:00 London BST');
        assert.strictEqual(summerInfo.isLondonOpenCandle, true, 'Must identify 08:00 BST as London Open');

        // Winter timestamp: January 15, 2026, 08:00 UTC -> 08:00 GMT London
        const winterDateSec = Math.floor(new Date('2026-01-15T08:00:00Z').getTime() / 1000);
        const winterInfo = getSessionInfo(winterDateSec);
        assert.strictEqual(winterInfo.lHour, 8, '08:00 UTC in January must be 08:00 London GMT');
        assert.strictEqual(winterInfo.isLondonOpenCandle, true, 'Must identify 08:00 GMT as London Open');
    });

    it('2.2 getSessionInfo handles New York summer (EDT = UTC-4) and winter (EST = UTC-5)', () => {
        // Summer timestamp: July 15, 2026, 12:00 UTC -> 08:00 EDT New York
        const summerDateSec = Math.floor(new Date('2026-07-15T12:00:00Z').getTime() / 1000);
        const summerInfo = getSessionInfo(summerDateSec);
        assert.strictEqual(summerInfo.nyHour, 8, '12:00 UTC in July must be 08:00 NY EDT');
        assert.strictEqual(summerInfo.isNYOpenCandle, true);

        // Winter timestamp: January 15, 2026, 13:00 UTC -> 08:00 EST New York
        const winterDateSec = Math.floor(new Date('2026-01-15T13:00:00Z').getTime() / 1000);
        const winterInfo = getSessionInfo(winterDateSec);
        assert.strictEqual(winterInfo.nyHour, 8, '13:00 UTC in January must be 08:00 NY EST');
        assert.strictEqual(winterInfo.isNYOpenCandle, true);
    });

    it('2.3 findActiveORBSession rejects off-session hours without arbitrary fallback', () => {
        // Candle during Asian session: 03:00 UTC
        const asianCandles = [];
        const base = Math.floor(new Date('2026-10-19T02:00:00Z').getTime() / 1000);
        for (let i = 0; i < 40; i++) {
            asianCandles.push({
                time: base + (i * 900),
                open: 2750, high: 2752, low: 2748, close: 2750
            });
        }
        const orbRes = findActiveORBSession(asianCandles);
        assert.strictEqual(orbRes.active, false, 'Must be inactive during Asian session');
        assert.strictEqual(orbRes.orbIdx, -1, 'Must have orbIdx = -1 (no arbitrary fallback)');
    });

    // -------------------------------------------------------------------------
    // 3. فحص تأكيدات ICT وتغطية الفجوات ومنع التعارض (Task 3: ICT & Mitigation)
    // -------------------------------------------------------------------------
    it('3.1 evaluateICTConfluences detects Bullish FVG and marks it mitigated upon retest', () => {
        const atr = 5.0;
        const testCandles = [
            { time: 1000, open: 2700, high: 2705, low: 2698, close: 2702 }, // Orb
            { time: 1900, open: 2702, high: 2708, low: 2700, close: 2706 }, // c2: high 2708
            { time: 2800, open: 2706, high: 2725, low: 2705, close: 2724 }, // c1: bullish expansion
            { time: 3700, open: 2724, high: 2730, low: 2715, close: 2728 }, // c0: low 2715 (Gap: 2708 to 2715 = 7 > atr*0.15)
            { time: 4600, open: 2728, high: 2732, low: 2720, close: 2730 }  // closed bar above
        ];

        // Before mitigation:
        const unmitigated = evaluateICTConfluences(testCandles, 0, atr);
        assert(unmitigated.bullishConfs.includes('Bullish FVG (Unmitigated)'));

        // Subsequent candle dips to 2707 <= 2708 (Mitigating the FVG):
        testCandles.push({ time: 5500, open: 2730, high: 2730, low: 2707, close: 2712 });
        testCandles.push({ time: 6400, open: 2712, high: 2720, low: 2710, close: 2718 });

        const mitigated = evaluateICTConfluences(testCandles, 0, atr);
        assert(!mitigated.bullishConfs.includes('Bullish FVG (Unmitigated)'), 'Mitigated FVG must be invalidated');
    });

    it('3.2 evaluateSignalCandidate rejects Bullish breakout with contradictory Bearish-only confluences', () => {
        const atr = 5.0;
        const orbCandle = { time: 1000, open: 2750, high: 2760, low: 2740, close: 2755 };
        const candles = [
            orbCandle,
            // Synthetic Bearish FVG formed inside the range:
            { time: 1900, open: 2755, high: 2758, low: 2745, close: 2746 }, // c2: low 2745
            { time: 2800, open: 2746, high: 2748, low: 2730, close: 2732 }, // c1: bearish expansion
            { time: 3700, open: 2732, high: 2738, low: 2728, close: 2735 }, // c0: high 2738 (Bearish FVG between 2738 & 2745)
            // Now a sudden wick breakout above ORH:
            { time: 4600, open: 2735, high: 2770, low: 2735, close: 2768 }, // Breakout close 2768 > 2760 ORH
            { time: 5500, open: 2768, high: 2772, low: 2766, close: 2770 }  // Forming
        ];

        const orbInfo = {
            active: true,
            orbCandle,
            orbIdx: 0,
            sessionLabel: 'NY Kill Zone',
            sessionKey: '2026-10-19_NY',
            isOrbClosed: true
        };

        const candidate = evaluateSignalCandidate(candles, orbInfo, atr, { sessionTrades: {} });
        assert.strictEqual(candidate.accepted, false, 'Must reject BUY breakout when only Bearish FVG exists');
        assert(candidate.reason.includes('مرفوض'), 'Must provide clear rejection reason');
    });

    // -------------------------------------------------------------------------
    // 4. فحص قاعدة صفقة واحدة لكل جلسة (Task 4: One Trade Per Session)
    // -------------------------------------------------------------------------
    it('4.1 One-Trade-Per-Session strictly blocks second signal in the same session', () => {
        const atr = 5.0;
        const orbCandle = { time: 1000, open: 2750, high: 2755, low: 2745, close: 2750 };
        const candles = [
            orbCandle,
            { time: 1900, open: 2750, high: 2752, low: 2748, close: 2751 },
            { time: 2800, open: 2751, high: 2765, low: 2750, close: 2764 },
            { time: 3700, open: 2764, high: 2775, low: 2762, close: 2772 },
            { time: 4600, open: 2772, high: 2780, low: 2770, close: 2778 },
            { time: 5500, open: 2778, high: 2785, low: 2776, close: 2782 }
        ];

        const orbInfo = {
            active: true,
            orbCandle,
            orbIdx: 0,
            sessionLabel: 'NY Kill Zone',
            sessionKey: '2026-10-19_NY',
            isOrbClosed: true
        };

        // If sessionTrades already has this session recorded:
        const dbWithSession = {
            sessionTrades: { '2026-10-19_NY': 1 }
        };

        const res = evaluateSignalCandidate(candles, orbInfo, atr, dbWithSession);
        assert.strictEqual(res.accepted, false, 'Second signal must be blocked');
        assert(res.reason.includes('قاعدة صفقة واحدة مطبقة'), 'Reason must cite one trade per session');
    });

    // -------------------------------------------------------------------------
    // 5. فحص حسابات المخاطرة وافتراض أسوأ تنفيذ (Task 5: Risk & Worst-Case Execution)
    // -------------------------------------------------------------------------
    it('5.1 Rejects signals with planned Risk-to-Reward ratio < 2.0', () => {
        const atr = 10.0;
        const orbCandle = { time: 1000, open: 2750, high: 2755, low: 2730, close: 2750 };
        const candles = [
            orbCandle,
            { time: 1900, open: 2750, high: 2758, low: 2748, close: 2756 }, // Small breakout
            { time: 2800, open: 2756, high: 2758, low: 2754, close: 2757 }
        ];
        const orbInfo = {
            active: true,
            orbCandle,
            orbIdx: 0,
            sessionLabel: 'London Open',
            sessionKey: '2026-10-19_LONDON',
            isOrbClosed: true
        };

        // When SL distance is large relative to nearest liquidity, RR < 2.0
        const res = evaluateSignalCandidate(candles, orbInfo, atr, { sessionTrades: {} });
        assert.strictEqual(res.accepted, false);
    });

    it('3.3 evaluateICTConfluences detects Bearish FVG and marks it mitigated upon upward retest', () => {
        const atr = 5.0;
        const testCandles = [
            { time: 1000, open: 2750, high: 2755, low: 2745, close: 2750 }, // Orb
            { time: 1900, open: 2750, high: 2752, low: 2740, close: 2741 }, // c2: low 2740
            { time: 2800, open: 2741, high: 2742, low: 2720, close: 2722 }, // c1: bearish impulse
            { time: 3700, open: 2722, high: 2732, low: 2718, close: 2725 }, // c0: high 2732 (Gap: 2740 - 2732 = 8 > atr*0.15)
            { time: 4600, open: 2725, high: 2728, low: 2715, close: 2720 }
        ];

        // Before mitigation:
        const unmitigated = evaluateICTConfluences(testCandles, 0, atr);
        assert(unmitigated.bearishConfs.includes('Bearish FVG (Unmitigated)'));

        // Subsequent candle rises to 2741 >= 2740 (Mitigates the Bearish FVG):
        testCandles.push({ time: 5500, open: 2720, high: 2742, low: 2718, close: 2738 });
        testCandles.push({ time: 6400, open: 2738, high: 2740, low: 2730, close: 2735 });

        const mitigated = evaluateICTConfluences(testCandles, 0, atr);
        assert(!mitigated.bearishConfs.includes('Bearish FVG (Unmitigated)'), 'Mitigated Bearish FVG must be removed');
    });

    it('3.4 evaluateICTConfluences detects Bullish Order Block and invalidates upon close below OB low', () => {
        const atr = 5.0;
        const testCandles = [
            { time: 1000, open: 2750, high: 2755, low: 2745, close: 2750 },
            { time: 1900, open: 2750, high: 2752, low: 2740, close: 2742 }, // c2: down candle (low 2740)
            { time: 2800, open: 2742, high: 2760, low: 2741, close: 2758 }, // c1: strong up candle engulfing c2
            { time: 3700, open: 2758, high: 2762, low: 2752, close: 2760 }, // c0: confirms OB
            { time: 4600, open: 2760, high: 2765, low: 2755, close: 2762 }
        ];

        const validOB = evaluateICTConfluences(testCandles, 0, atr);
        assert(validOB.bullishConfs.includes('Bullish Order Block'));

        // Price drops and closes at 2735 < 2740 (Invalidates Bullish OB):
        testCandles.push({ time: 5500, open: 2762, high: 2762, low: 2732, close: 2735 });
        testCandles.push({ time: 6400, open: 2735, high: 2738, low: 2730, close: 2732 });

        const invalidatedOB = evaluateICTConfluences(testCandles, 0, atr);
        assert(!invalidatedOB.bullishConfs.includes('Bullish Order Block'), 'Invalidated OB must be removed');
    });

    it('5.2 manageOpenTradesLifecycle resolves ambiguous candle with worst-case execution (SL first)', async () => {
        const { engineState, manageOpenTradesLifecycle, saveActiveTradesToDB } = require('../bot_engine.js');
        const initialStats = JSON.parse(JSON.stringify(loadDB().stats));
        
        // Setup synthetic active trade
        engineState.activeTrades = [{
            id: 'TEST-AMBIGUOUS-1',
            side: 'BUY',
            session: 'London Open',
            sessionKey: '2026-10-19_TEST',
            entry: 2750.0,
            sl: 2740.0,
            tp1: 2760.0,
            tp2: 2780.0,
            rr: '3.0',
            beMoved: false,
            alertsSent: { entry: true, tp1: false, be: false, tp2: false, sl: false }
        }];

        // Ambiguous candle: Low drops to 2735 <= SL (2740) AND High reaches 2785 >= TP2 (2780)
        const ambiguousCandle = {
            time: 1729300000,
            open: 2750.0,
            high: 2785.0,
            low: 2735.0,
            close: 2775.0
        };

        await manageOpenTradesLifecycle(ambiguousCandle);

        // Under worst-case execution, trade must be closed as SL, not WIN!
        assert.strictEqual(engineState.activeTrades.length, 0, 'Trade must be removed from active trades');
        
        const db = loadDB();
        const latestHistory = db.stats.history[0];
        assert(latestHistory.status.includes('SL (Worst-Case)'), 'History must record worst-case SL execution');

        // Restore clean persistent stats baseline to prevent test pollution
        await updateDB((d) => { d.stats = initialStats; });
    });

    it('5.3 findActiveORBSession rejects weekend candles without error', () => {
        // Saturday timestamp: Oct 17, 2026, 08:00 UTC
        const satBase = Math.floor(new Date('2026-10-17T08:00:00Z').getTime() / 1000);
        const satCandles = [];
        for (let i = 0; i < 40; i++) {
            satCandles.push({
                time: satBase + (i * 900),
                open: 2750, high: 2755, low: 2748, close: 2752
            });
        }
        const orbRes = findActiveORBSession(satCandles);
        assert.strictEqual(orbRes.active, false, 'Weekend session must be inactive');
        assert(orbRes.reason.includes('عطلة نهاية الأسبوع'), 'Must report weekend status');
    });

    it('6.1 saveActiveTradesToDB and restoreActiveTradesFromDB preserve trades and deduplication state', () => {
        const { engineState, saveActiveTradesToDB, restoreActiveTradesFromDB } = require('../bot_engine.js');
        engineState.activeTrades = [{
            id: 'RESTART-TEST-1',
            side: 'BUY',
            session: 'NY Kill Zone',
            sessionKey: '2026-10-19_NY_RECOVERY',
            entry: 2755.0,
            sl: 2745.0,
            tp1: 2765.0,
            tp2: 2785.0,
            rr: '3.0',
            beMoved: true,
            alertsSent: { entry: true, tp1: true, be: true, tp2: false, sl: false }
        }];

        saveActiveTradesToDB();

        // Simulate complete restart: clear engineState
        engineState.activeTrades = [];
        assert.strictEqual(engineState.activeTrades.length, 0);

        // Restore
        restoreActiveTradesFromDB();
        assert.strictEqual(engineState.activeTrades.length, 1);
        assert.strictEqual(engineState.activeTrades[0].id, 'RESTART-TEST-1');
        assert.strictEqual(engineState.activeTrades[0].beMoved, true);
        assert.strictEqual(engineState.activeTrades[0].alertsSent.be, true);

        // Clean up
        engineState.activeTrades = [];
        saveActiveTradesToDB();
    });

    console.log('\n========================================================');
    console.log(`PHASE 3 TEST RESULTS: ${passedTests} / ${totalTests} PASSED`);
    console.log('========================================================\n');

    process.exit(passedTests === totalTests ? 0 : 1);
}

runTests().catch(err => {
    console.error('Test execution error:', err);
    process.exit(1);
});
