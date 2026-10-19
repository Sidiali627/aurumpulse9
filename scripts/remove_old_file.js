const fs = require('fs');
const path = require('path');
const oldPath = path.join(__dirname, '..', 'bot_engine.js.js');
if (fs.existsSync(oldPath)) {
    fs.unlinkSync(oldPath);
    console.log('Successfully removed bot_engine.js.js');
} else {
    console.log('bot_engine.js.js does not exist.');
}
