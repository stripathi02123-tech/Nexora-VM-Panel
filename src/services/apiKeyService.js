const crypto = require('crypto');
const { db } = require('../lib/db');
const { logAudit } = require('./activityService');

function now() { return new Date().toISOString(); }

const PREFIX = 'nexk_';

function hashKey(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Generate a new API key. Returns the raw key ONCE (never stored/retrievable
 * again) plus the DB row. `scopes` is an array of strings, e.g.
 * ['status:read', 'vps:read', 'bot:admin'].
 */
function generate({ userId = null, name, scopes = [], expiresAt = null }) {
  if (!name || !String(name).trim()) throw new Error('API key name is required');
  const random = crypto.randomBytes(24).toString('base64url');
  const raw = `${PREFIX}${random}`;
  const keyPrefix = raw.slice(0, PREFIX.length + 8);
  const keyHash = hashKey(raw);

  const info = db.prepare(`
    INSERT INTO api_keys (user_id, name, key_prefix, key_hash, scopes, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(userId, String(name).trim(), keyPrefix, keyHash, JSON.stringify(scopes), expiresAt, now());

  const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(info.lastInsertRowid);
  return { raw, key: serialize(row) };
}

function serialize(row) {
  if (!row) return null;
  let scopes = [];
  try { scopes = JSON.parse(row.scopes || '[]'); } catch (_) {}
  return {
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    key_prefix: row.key_prefix,
    scopes,
    last_used_at: row.last_used_at,
    expires_at: row.expires_at,
    revoked: !!row.revoked,
    created_at: row.created_at,
  };
}

/** Verify a raw API key string. Returns the row (with parsed scopes) or null. */
function verify(raw) {
  if (!raw || !raw.startsWith(PREFIX)) return null;
  const keyHash = hashKey(raw);
  const row = db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(keyHash);
  if (!row) return null;
  if (row.revoked) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;
  db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now(), row.id);
  return serialize(row);
}

function hasScope(key, scope) {
  if (!key) return false;
  if (key.scopes.includes('*')) return true;
  return key.scopes.includes(scope);
}

function list({ userId = null } = {}) {
  const rows = userId
    ? db.prepare('SELECT * FROM api_keys WHERE user_id = ? ORDER BY id DESC').all(userId)
    : db.prepare('SELECT * FROM api_keys ORDER BY id DESC').all();
  return rows.map(serialize);
}

function revoke(id, actorUserId = null) {
  const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id);
  if (!row) throw new Error('API key not found');
  db.prepare('UPDATE api_keys SET revoked = 1 WHERE id = ?').run(id);
  logAudit({ actor_user_id: actorUserId, actor_type: 'user', action: 'api_key.revoke', target_type: 'api_key', target_id: id });
  return true;
}

module.exports = { generate, verify, hasScope, list, revoke, serialize, PREFIX };
