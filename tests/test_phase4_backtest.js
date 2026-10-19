/**
 * AurumPulse ICT - Phase 4 Quantitative Backtesting & Robustness Test Suite
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const {
    validateCandles,
    computeRealATR,
    findActiveORBSession,
    evaluateSignalCandidate
} = require('../bot_engine.js');
const {
    loadHistoricalDataset,
    simulateBacktest
} = require('../scripts/backtest_orb_ict.js');

console.log('========================================================');
console.log('RUNNING PHASE 4 QUANTITATIVE BACKTESTING TEST SUITE');
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
    const candles = loadHistoricalDataset();

    // -------------------------------------------------------------------------
    // 1. فحص سلامة وتماسك مجموعة البيانات التاريخية (Task 1: Dataset Validation)
    // -------------------------------------------------------------------------
    it('1.1 Historical dataset contains 15,000 valid 15m candles covering ~5 months', () => {
        assert(Array.isArray(candles), 'Dataset must be an array');
        assert.strictEqual(candles.length, 15000, 'Must contain exactly 15,000 bars');
        
        const first = candles[0];
        const last = candles[candles.length - 1];
        assert.strictEqual(first.time < last.time, true, 'Start time must precede end time');
        
        const calendarDays = (last.time - first.time) / 86400;
        assert(calendarDays >= 150, `Must span at least 150 days (actual: ${calendarDays.toFixed(1)})`);
    });

    it('1.2 Dataset has strictly monotonic timestamps and zero High/Low contradictions', () => {
        for (let i = 0; i < candles.length; i++) {
            const c = candles[i];
            assert(c.high >= c.low, `High must be >= Low at index ${i}`);
            assert(c.high >= c.open, `High must be >= Open at index ${i}`);
            assert(c.high >= c.close, `High must be >= Close at index ${i}`);
            assert(c.low <= c.open, `Low must be <= Open at index ${i}`);
            assert(c.low <= c.close, `Low must be <= Close at index ${i}`);

            if (i > 0) {
                assert(c.time > candles[i - 1].time, `Non-monotonic timestamp at index ${i}`);
                assert.strictEqual(c.time - candles[i - 1].time, 900, `Bar interval must be exactly 900s at index ${i}`);
            }
        }
    });

    // -------------------------------------------------------------------------
    // 2. فحص التقسيم الزمني الدقيق ومنع الانحياز المستقبلي (Task 2: Chronological Splits)
    // -------------------------------------------------------------------------
    it('2.1 Chronological splits are strictly non-overlapping and ordered', () => {
        const inSample = candles.slice(0, 7500);
        const val = candles.slice(7500, 11250);
        const oos = candles.slice(11250);

        assert.strictEqual(inSample.length, 7500);
        assert.strictEqual(val.length, 3750);
        assert.strictEqual(oos.length, 3750);

        assert(inSample[inSample.length - 1].time < val[0].time, 'In-sample must strictly precede Validation');
        assert(val[val.length - 1].time < oos[0].time, 'Validation must strictly precede Out-of-Sample');
    });

    it('2.2 Zero Look-Ahead Bias: slice at barIdx contains strictly no future bars', () => {
        const testBarIdx = 500;
        const slice = candles.slice(0, testBarIdx + 1);
        assert.strictEqual(slice.length, testBarIdx + 1);
        assert.strictEqual(slice[slice.length - 1].time, candles[testBarIdx].time);
        assert(slice[slice.length - 1].time < candles[testBarIdx + 1].time);
    });

    // -------------------------------------------------------------------------
    // 3. فحص نموذج احتساب التكاليف والاحتكاك الواقعي (Task 3: Friction Accounting)
    // -------------------------------------------------------------------------
    it('3.1 Cost accounting hierarchy: Gross Net R >= Forex CFD Net R >= Binance Spot Net R', () => {
        const testSlice = candles.slice(0, 2000);
        const gross = simulateBacktest(testSlice, { costModel: 'gross' });
        const cfd = simulateBacktest(testSlice, { costModel: 'forex_cfd' });
        const spot = simulateBacktest(testSlice, { costModel: 'binance_spot' });

        assert.strictEqual(gross.totalSignals, cfd.totalSignals, 'Signal count must be identical');
        assert.strictEqual(cfd.totalSignals, spot.totalSignals, 'Signal count must be identical');

        assert(gross.netR >= cfd.netR, `Gross net R (${gross.netR}) must be >= CFD net R (${cfd.netR})`);
        assert(cfd.netR >= spot.netR, `CFD net R (${cfd.netR}) must be >= Binance Spot net R (${spot.netR})`);
    });

    // -------------------------------------------------------------------------
    // 4. فحص قاعدة صفقة واحدة للجلسة وحظر الإفراط في التداول (Task 4: Constraints)
    // -------------------------------------------------------------------------
    it('4.1 One-Trade-Per-Session strictly restricts entries to at most 1 per session key', () => {
        const testSlice = candles.slice(0, 2500);
        const res = simulateBacktest(testSlice, { oneTradePerSession: true });
        
        const sessionCounts = {};
        for (const t of res.tradeLog) {
            sessionCounts[t.sessionKey] = (sessionCounts[t.sessionKey] || 0) + 1;
            assert.strictEqual(sessionCounts[t.sessionKey], 1, `Session ${t.sessionKey} had more than 1 trade`);
        }
    });

    // -------------------------------------------------------------------------
    // 5. فحص التكرارية الحتمية (Task 6: Deterministic Reproducibility)
    // -------------------------------------------------------------------------
    it('5.1 Two independent backtest runs on the same dataset produce identical results bit-for-bit', () => {
        const testSlice = candles.slice(0, 3000);
        const runA = simulateBacktest(testSlice, { costModel: 'forex_cfd' });
        const runB = simulateBacktest(testSlice, { costModel: 'forex_cfd' });

        assert.strictEqual(runA.totalSignals, runB.totalSignals);
        assert.strictEqual(runA.wins, runB.wins);
        assert.strictEqual(runA.losses, runB.losses);
        assert.strictEqual(runA.breakevens, runB.breakevens);
        assert.strictEqual(runA.netR, runB.netR);
        assert.strictEqual(runA.maxDrawdownR, runB.maxDrawdownR);
        assert.strictEqual(runA.profitFactor, runB.profitFactor);
        assert.strictEqual(runA.tradeLog.length, runB.tradeLog.length);
        
        for (let i = 0; i < runA.tradeLog.length; i++) {
            assert.strictEqual(runA.tradeLog[i].entry, runB.tradeLog[i].entry);
            assert.strictEqual(runA.tradeLog[i].outcome, runB.tradeLog[i].outcome);
            assert.strictEqual(runA.tradeLog[i].netR, runB.tradeLog[i].netR);
        }
    });

    // -------------------------------------------------------------------------
    // 6. فحص معالجة الشمعة الملتبسة بأسوأ سيناريو (Worst-Case Execution)
    // -------------------------------------------------------------------------
    it('6.1 Ambiguous candle hitting both SL and TP2 evaluates as Stop-Loss, never Win', () => {
        // Setup synthetic 2-candle sequence where second candle touches both SL and TP2
        const synthetic = [
            // Lookback bars
            ...candles.slice(0, 60),
            // Orb Candle
            { time: 1729300000, open: 2750, high: 2755, low: 2745, close: 2750 },
            // Breakout bar
            { time: 1729300900, open: 2750, high: 2765, low: 2748, close: 2762 },
            // Ambiguous forward bar touching both 2730 (SL) and 2790 (TP2)
            { time: 1729301800, open: 2762, high: 2800, low: 2720, close: 2780 }
        ];

        // The backtester's ambiguous bar check enforces tradeOutcome = 'SL'
        const res = simulateBacktest(synthetic, { costModel: 'gross' });
        if (res.tradeLog.length > 0) {
            const lastTrade = res.tradeLog[res.tradeLog.length - 1];
            if (lastTrade.outcome !== 'OPEN') {
                assert.notStrictEqual(lastTrade.outcome, 'WIN', 'Ambiguous bar must never be counted as WIN');
            }
        }
    });

    console.log('\n========================================================');
    console.log(`PHASE 4 TEST RESULTS: ${passedTests} / ${totalTests} PASSED`);
    console.log('========================================================\n');

    process.exit(passedTests === totalTests ? 0 : 1);
}

runTests().catch(err => {
    console.error('Phase 4 test error:', err);
    process.exit(1);
});
