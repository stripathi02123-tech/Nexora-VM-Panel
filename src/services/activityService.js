const { db } = require('../lib/db');

function logActivity({ user_id = null, vm_id = null, event, details = null, ip = null, user_agent = null }) {
  try {
    db.prepare(
      'INSERT INTO activity_logs (user_id, vm_id, event, details, ip, user_agent, created_at) VALUES (?,?,?,?,?,?,?)'
    ).run(user_id, vm_id, event, details ? JSON.stringify(details) : null, ip, user_agent, new Date().toISOString());
  } catch (e) { /* noop */ }
}

function logLogin({ user_id = null, ip, username, status }) {
  try {
    db.prepare(
      'INSERT INTO login_attempts (user_id, ip, username, status, created_at) VALUES (?,?,?,?,?)'
    ).run(user_id, ip, username, status, new Date().toISOString());
  } catch (e) { /* noop */ }
}

function listActivity({ user_id = null, vm_id = null, limit = 100, offset = 0 }) {
  let sql = `
    SELECT a.*, u.username, v.name as vm_name
    FROM activity_logs a
    LEFT JOIN users u ON u.id = a.user_id
    LEFT JOIN vms v ON v.id = a.vm_id
    WHERE 1=1`;
  const params = [];
  if (user_id) { sql += ' AND a.user_id = ?'; params.push(user_id); }
  if (vm_id) { sql += ' AND a.vm_id = ?'; params.push(vm_id); }
  sql += ' ORDER BY a.id DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  const rows = db.prepare(sql).all(...params);
  for (const r of rows) {
    try { r.details = JSON.parse(r.details); } catch (_) { r.details = null; }
  }
  return rows;
}

function listLoginHistory({ user_id = null, limit = 100, offset = 0 }) {
  let sql = 'SELECT * FROM login_attempts WHERE 1=1';
  const params = [];
  if (user_id) { sql += ' AND user_id = ?'; params.push(user_id); }
  sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return db.prepare(sql).all(...params);
}

function recentLogin(userId) {
  return db.prepare(
    'SELECT * FROM login_attempts WHERE user_id = ? ORDER BY id DESC LIMIT 1'
  ).get(userId) || null;
}

function logAudit({ actor_user_id = null, actor_type = 'user', action, target_type = null, target_id = null, details = null, ip = null }) {
  try {
    db.prepare(
      'INSERT INTO audit_logs (actor_user_id, actor_type, action, target_type, target_id, details, ip, created_at) VALUES (?,?,?,?,?,?,?,?)'
    ).run(actor_user_id, actor_type, action, target_type, target_id, details ? JSON.stringify(details) : null, ip, new Date().toISOString());
  } catch (e) { /* noop */ }
}

function listAudit({ limit = 100, offset = 0 } = {}) {
  return db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ? OFFSET ?').all(limit, offset);
}

module.exports = { logActivity, logLogin, listActivity, listLoginHistory, recentLogin, logAudit, listAudit };
