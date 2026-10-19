const fs = require('fs');
const path = require('path');

const backupDir = path.join(__dirname, '..', '.backup', 'phase0');
fs.mkdirSync(backupDir, { recursive: true });

const filesToBackup = [
    'bot_engine.js.js',
    'database.json',
    'index.html',
    'package.json',
    'package-lock.json',
    'server.js'
];

for (const file of filesToBackup) {
    const src = path.join(__dirname, '..', file);
    const dest = path.join(backupDir, file);
    if (fs.existsSync(src)) {
        fs.copyFileSync(src, dest);
        console.log(`Backed up ${file} -> ${dest}`);
    }
}
console.log('Phase 0 backup complete.');
