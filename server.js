/**
 * AurumPulse ICT - server.js (Consolidated into bot_engine.js)
 * 
 * NOTICE: As part of the Phase 2 Architecture Consolidation:
 * 1. All active licenses ('GOLD-PRO-VIP1', 'TRIAL-FREE-3DAY') have been migrated to database.json.
 * 2. All Telegram polling and market scanning functionality has been unified in bot_engine.js.
 * 3. This file forwards directly to bot_engine.js to preserve backward compatibility.
 */

console.log('[CONSOLIDATION NOTICE] server.js has been migrated to bot_engine.js. Forwarding execution...');
module.exports = require('./bot_engine.js');
