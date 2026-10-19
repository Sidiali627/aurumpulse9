const fs = require('fs');
const path = require('path');

const resPath = path.join(__dirname, 'data', 'phase4_backtest_results.json');
const res = JSON.parse(fs.readFileSync(resPath, 'utf8'));

console.log('=== CHRONOLOGICAL SPLITS ===');
for (const [k, v] of Object.entries(res.baseline)) {
    console.log(k.padEnd(15), ':', {
        signals: v.totalSignals,
        wins: v.wins,
        losses: v.losses,
        be: v.breakevens,
        winRateDecisive: v.winRateDecisive + '%',
        netR: v.netR + 'R',
        maxDD: '-' + v.maxDrawdownR + 'R',
        profitFactor: v.profitFactor,
        expectancy: v.expectancyR + 'R'
    });
}

console.log('\n=== FRICTION COMPARISON ===');
for (const [k, v] of Object.entries(res.costsComparison)) {
    console.log(k.padEnd(15), ':', { netR: v.netR + 'R', maxDD: '-' + v.maxDrawdownR + 'R', expectancy: v.expectancyR + 'R' });
}

console.log('\n=== SESSIONS ===');
console.log('London:  ', res.baseline.full.londonStats);
console.log('New York:', res.baseline.full.nyStats);

console.log('\n=== ONE TRADE PER SESSION ===');
console.log('With:   ', { trades: res.constraintComparison.withOneTradePerSession.totalSignals, netR: res.constraintComparison.withOneTradePerSession.netR + 'R', maxDD: '-' + res.constraintComparison.withOneTradePerSession.maxDrawdownR + 'R' });
console.log('Without:', { trades: res.constraintComparison.withoutOneTradePerSession.totalSignals, netR: res.constraintComparison.withoutOneTradePerSession.netR + 'R', maxDD: '-' + res.constraintComparison.withoutOneTradePerSession.maxDrawdownR + 'R' });

console.log('\n=== SENSITIVITY MATRIX ===');
for (const [k, v] of Object.entries(res.sensitivity)) {
    console.log(k.padEnd(10), ':', {
        trades: v.totalSignals,
        winRate: v.winRateDecisive + '%',
        netR: v.netR + 'R',
        maxDD: '-' + v.maxDrawdownR + 'R',
        expectancy: v.expectancyR + 'R'
    });
}

console.log('\n=== OUTLIER SENSITIVITY ===');
console.log('Baseline Net R:              ', res.baseline.full.netR + 'R');
console.log('Without Top 2 Winning Trades:', res.baseline.full.netRWithoutTop2 + 'R');
