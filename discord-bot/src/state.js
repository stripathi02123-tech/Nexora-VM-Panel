// Tiny local state file so the bot remembers which message it's already
// posted the live status embed to, and edits that message instead of
// spamming a new one every refresh cycle.
const fs = require('fs');
const path = require('path');

const STATE_PATH = path.join(__dirname, '..', 'state.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (_) {
    return {};
  }
}

function save(state) {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('[nexora-bot] failed to persist state:', e.message);
  }
}

module.exports = { load, save };
