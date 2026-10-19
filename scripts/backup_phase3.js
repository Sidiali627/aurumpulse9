const fs = require('fs');
const path = require('path');

const backupDir = path.join(__dirname, '..', '.backup', 'phase2_before_phase3');
fs.mkdirSync(backupDir, { recursive: true });

const filesToBackup = [
    'bot_engine.js',
    'bot_engine.js.js',
    'database.json',
    'index.html',
    'package.json',
    'package-lock.json',
    'server.js',
    '.env',
    '.env.example',
    '.gitignore'
];

for (const file of filesToBackup) {
    const src = path.join(__dirname, '..', file);
    const dest = path.join(backupDir, file);
    if (fs.existsSync(src)) {
        fs.copyFileSync(src, dest);
        console.log(`Backed up ${file} -> ${dest}`);
    }
}
console.log('Phase 3 pre-change backup complete.');
