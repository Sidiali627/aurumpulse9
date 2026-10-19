/**
 * AurumPulse ICT - Historical Market Data Ingestion & Integrity Validator
 * Fetches 15,000 Binance PAXGUSDT 15m klines, verifies OHLC integrity,
 * detects timestamp gaps, and writes reproducible historical dataset.
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

function fetchKlinesChunk(endTime) {
    return new Promise((resolve, reject) => {
        let url = 'https://data-api.binance.vision/api/v3/klines?symbol=PAXGUSDT&interval=15m&limit=1000';
        if (endTime) url += `&endTime=${endTime}`;

        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve(parsed);
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', reject);
    });
}

async function ingestAndValidate() {
    console.log('===============================================================');
    console.log('  AURUMPULSE ICT — HISTORICAL MARKET DATA INGESTION ENGINE');
    console.log('===============================================================\n');
    console.log('[PROVENANCE] Source: Binance Public Vision API (https://data-api.binance.vision)');
    console.log('[INSTRUMENT] Symbol: PAXGUSDT (Paxos Standard Gold Token vs USDT)');
    console.log('[TIMEFRAME]  Interval: 15m (900,000 ms per candle)');
    console.log('[TARGET]     Target Depth: 15,000 candles (~5 calendar months)\n');

    const rawAll = [];
    let currEnd = undefined;
    const TOTAL_CHUNKS = 15;

    for (let c = 0; c < TOTAL_CHUNKS; c++) {
        process.stdout.write(`Fetching chunk ${c + 1} / ${TOTAL_CHUNKS}... `);
        const chunk = await fetchKlinesChunk(currEnd);
        if (!chunk || !Array.isArray(chunk) || chunk.length === 0) {
            console.log('No more candles returned.');
            break;
        }
        console.log(`Received ${chunk.length} candles. (${new Date(chunk[0][0]).toISOString().slice(0, 10)} to ${new Date(chunk[chunk.length - 1][0]).toISOString().slice(0, 10)})`);
        rawAll.unshift(...chunk); // prepend older chunk
        currEnd = chunk[0][0] - 1;
        // brief rate-limit courtesy pause
        await new Promise(r => setTimeout(r, 200));
    }

    console.log(`\nTotal raw candles ingested: ${rawAll.length}`);

    // Sort chronologically ascending
    rawAll.sort((a, b) => a[0] - b[0]);

    // De-duplicate and validate
    const uniqueMap = new Map();
    let duplicatesCount = 0;
    for (const row of rawAll) {
        const timeMs = row[0];
        if (uniqueMap.has(timeMs)) {
            duplicatesCount++;
        } else {
            uniqueMap.set(timeMs, row);
        }
    }

    const uniqueRows = Array.from(uniqueMap.values());
    console.log(`De-duplicated dataset count: ${uniqueRows.length} (Duplicates removed: ${duplicatesCount})`);

    // Rigorous Validation
    const cleanCandles = [];
    const gaps = [];
    let highLowErrors = 0;

    for (let i = 0; i < uniqueRows.length; i++) {
        const r = uniqueRows[i];
        const time = Math.floor(r[0] / 1000);
        const open = parseFloat(r[1]);
        const high = parseFloat(r[2]);
        const low = parseFloat(r[3]);
        const close = parseFloat(r[4]);
        const volume = parseFloat(r[5]);

        if (isNaN(time) || isNaN(open) || isNaN(high) || isNaN(low) || isNaN(close) || isNaN(volume)) {
            throw new Error(`Malformed numeric data at index ${i}`);
        }

        if (high < low || high < open || high < close || low > open || low > close) {
            highLowErrors++;
        }

        if (i > 0) {
            const prevTime = cleanCandles[cleanCandles.length - 1].time;
            const diffSec = time - prevTime;
            if (diffSec < 900) {
                throw new Error(`Non-monotonic timestamp order at index ${i}: prev=${prevTime}, curr=${time}`);
            } else if (diffSec > 900) {
                gaps.push({
                    from: new Date(prevTime * 1000).toISOString(),
                    to: new Date(time * 1000).toISOString(),
                    missingBars: Math.round(diffSec / 900) - 1,
                    gapSeconds: diffSec - 900
                });
            }
        }

        cleanCandles.push({ time, open, high, low, close, volume });
    }

    const startDate = new Date(cleanCandles[0].time * 1000).toISOString();
    const endDate = new Date(cleanCandles[cleanCandles.length - 1].time * 1000).toISOString();
    const calendarDays = ((cleanCandles[cleanCandles.length - 1].time - cleanCandles[0].time) / 86400).toFixed(1);

    console.log('\n--- DATASET INTEGRITY AUDIT ---');
    console.log(`Date Span:         ${startDate}  ➔  ${endDate}`);
    console.log(`Calendar Days:     ${calendarDays} days (~${(calendarDays / 30.4).toFixed(1)} months)`);
    console.log(`Total Valid Bars:  ${cleanCandles.length}`);
    console.log(`High/Low Errors:   ${highLowErrors}`);
    console.log(`Gaps Detected:     ${gaps.length}`);
    if (gaps.length > 0) {
        console.log('Sample Gaps (Binance maintenance / downtime):');
        gaps.slice(0, 5).forEach(g => {
            console.log(`  • From ${g.from} to ${g.to} (Missing ${g.missingBars} bars / ${(g.gapSeconds/3600).toFixed(1)} hrs)`);
        });
    }

    const outDataPath = path.join(__dirname, 'data', 'paxgusdt_15m_historical.json');
    const outMetaPath = path.join(__dirname, 'data', 'dataset_metadata.json');

    fs.writeFileSync(outDataPath, JSON.stringify(cleanCandles, null, 2), 'utf8');
    const metadata = {
        instrument: 'PAXGUSDT',
        exchange: 'Binance',
        provenanceUrl: 'https://data-api.binance.vision/api/v3/klines',
        interval: '15m',
        timeframeSeconds: 900,
        totalCandles: cleanCandles.length,
        startDateUtc: startDate,
        endDateUtc: endDate,
        calendarDays: parseFloat(calendarDays),
        gapsCount: gaps.length,
        gapsList: gaps,
        ingestedAt: new Date().toISOString()
    };
    fs.writeFileSync(outMetaPath, JSON.stringify(metadata, null, 2), 'utf8');

    console.log(`\nSuccessfully persisted clean dataset to: ${outDataPath}`);
    console.log(`Metadata persisted to: ${outMetaPath}`);
    console.log('===============================================================\n');

    return { cleanCandles, metadata };
}

if (require.main === module) {
    ingestAndValidate().catch(err => {
        console.error('Fatal ingestion error:', err);
        process.exit(1);
    });
}

module.exports = { ingestAndValidate };
