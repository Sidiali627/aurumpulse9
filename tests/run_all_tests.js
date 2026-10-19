/**
 * AurumPulse ICT - Master Test Runner across all Phases (1, 2, 3, 4)
 * Executes test suites sequentially with clean process isolation.
 */
const { execFileSync } = require('child_process');
const path = require('path');

const testSuites = [
  { name: 'Phase 1: Security & Licensing', file: 'tests/test_security.js' },
  { name: 'Phase 2: Database Integrity & Atomicity', file: 'tests/test_phase2_integrity.js' },
  { name: 'Phase 3: Trading Strategy & ICT Engine', file: 'tests/test_phase3_strategy.js' },
  { name: 'Phase 4: Quantitative Backtesting & Robustness', file: 'tests/test_phase4_backtest.js' },
  { name: 'Render Deployment & Demo-Mode Verification', file: 'tests/test_render_deployment.js' },
  { name: 'Phase 5: Production Licensing & Security Architecture', file: 'tests/test_production_licensing.js' },
  { name: 'Database Adapter & PostgreSQL Integration', file: 'tests/test_postgres_integration.js' },
  { name: 'Live Price Feed & Real-Time Latency', file: 'tests/test_live_price_feed.js' }
];

console.log('========================================================================');
console.log('   AURUMPULSE ICT — MASTER AUTOMATED TEST SUITE (PHASES 1 - 4)');
console.log('========================================================================\n');

let allPassed = true;
let totalPassedCount = 0;
let totalTestCount = 0;
const projectRoot = path.resolve(__dirname, '..');

for (const suite of testSuites) {
  console.log(`>>> Running ${suite.name} (${suite.file})...`);
  try {
    const output = execFileSync(process.execPath, [path.join(projectRoot, suite.file)], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    console.log(output.trim());
    console.log(`[PASS] ${suite.name} completed successfully.\n`);
    const match = output.match(/RESULTS:?\s*(\d+)\s*\/\s*(\d+)\s*PASSED/i);
    if (match) {
      totalPassedCount += parseInt(match[1], 10);
      totalTestCount += parseInt(match[2], 10);
    }
  } catch (err) {
    allPassed = false;
    console.error(`[FAIL] ${suite.name} encountered errors:`);
    if (err.stdout) console.log(err.stdout.toString());
    if (err.stderr) console.error(err.stderr.toString());
    break;
  }
}

if (!allPassed) {
  console.error('\n[FATAL] Some test suites failed. Exiting with status 1.');
  process.exit(1);
} else {
  console.log('========================================================================');
  console.log(`   ALL ${testSuites.length} TEST SUITES PASSED SUCCESSFULLY (${totalPassedCount} / ${totalTestCount} TESTS)!`);
  console.log('========================================================================\n');
  process.exit(0);
}
