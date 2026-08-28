const express = require('express');
const { db, settings } = require('../lib/db');
const vmService = require('../services/vmService');
const { requireApiKeyScope } = require('../middleware/auth');
const router = express.Router();
const json = express.json({ limit: '1mb' });

function serializeNode(n) {
  return {
    id: n.id,
    uuid: n.uuid,
    name: n.name,
    location: n.location,
    status: n.status,
    cpu_cores: n.cpu_cores,
    ram_mb: n.ram_mb,
    storage_gb: n.storage_gb,
    cpu_usage: n.cpu_usage,
    ram_usage_mb: n.ram_usage_mb,
    disk_usage_gb: n.disk_usage_gb,
    agent_version: n.agent_version,
    last_heartbeat_at: n.last_heartbeat_at,
    enabled: !!n.enabled,
  };
}

function latencyFor(nodeId) {
  return db.prepare('SELECT * FROM node_latency_stats WHERE node_id = ?').get(nodeId) || null;
}

function vpsCountFor(nodeId) {
  const row = db.prepare(`SELECT
      SUM(CASE WHEN resource_type = 'vps' THEN 1 ELSE 0 END) AS vps,
      SUM(CASE WHEN resource_type = 'vds' THEN 1 ELSE 0 END) AS vds
    FROM vms WHERE node_id = ? AND status != 'deleted'`).get(nodeId);
  return { vps: row.vps || 0, vds: row.vds || 0 };
}

// All routes below require a valid, non-revoked API key with the given scope.
// This is deliberately separate from session/JWT auth (apiAuth) since the
// bot never logs in as a user.

router.get('/status', requireApiKeyScope('status:read'), (req, res) => {
  const nodes = db.prepare('SELECT * FROM nodes ORDER BY name ASC').all();
  const vmCounts = db.prepare(`SELECT
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
      COUNT(*) AS total
    FROM vms WHERE status != 'deleted'`).get();
  res.json({
    panel_name: settings.get('panel.name') || 'Nexora Cloud',
    nodes: nodes.map((n) => ({ ...serializeNode(n), latency: latencyFor(n.id), counts: vpsCountFor(n.id) })),
    vms: { total: vmCounts.total || 0, running: vmCounts.running || 0 },
    generated_at: new Date().toISOString(),
  });
});

router.get('/nodes', requireApiKeyScope('status:read'), (req, res) => {
  const nodes = db.prepare('SELECT * FROM nodes ORDER BY name ASC').all();
  res.json({ nodes: nodes.map((n) => ({ ...serializeNode(n), latency: latencyFor(n.id), counts: vpsCountFor(n.id) })) });
});

router.get('/nodes/:name', requireApiKeyScope('status:read'), (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE name = ? OR uuid = ?').get(req.params.name, req.params.name);
  if (!node) return res.status(404).json({ error: 'Node not found' });
  res.json({ node: { ...serializeNode(node), latency: latencyFor(node.id), counts: vpsCountFor(node.id) } });
});

router.get('/ping/:name', requireApiKeyScope('status:read'), (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE name = ? OR uuid = ?').get(req.params.name, req.params.name);
  if (!node) return res.status(404).json({ error: 'Node not found' });
  const lat = latencyFor(node.id);
  if (!lat) return res.json({ node: node.name, status: node.status, latency_ms: null, note: 'No latency samples yet' });
  res.json({ node: node.name, status: node.status, latency_ms: lat.current_ms, avg_ms: lat.avg_ms, min_ms: lat.min_ms, max_ms: lat.max_ms, last_success_at: lat.last_success_at });
});

router.get('/vps/:id', requireApiKeyScope('status:read'), (req, res) => {
  const vm = vmService.getVm(parseInt(req.params.id, 10));
  if (!vm) return res.status(404).json({ error: 'Server not found' });
  const s = vmService.serializeVm(vm);
  res.json({
    vps: {
      id: s.id, name: s.name, hostname: s.hostname, resource_type: s.resource_type,
      status: s.status, node_id: s.node_id, cpus: s.cpus, memory: s.memory, disk_size: s.disk_size,
      running: vmService.isRunning(vm), uptime_seconds: vmService.isRunning(vm) ? vmService.uptimeSeconds(vm) : 0,
    },
  });
});

router.get('/health', requireApiKeyScope('status:read'), (req, res) => {
  const nodes = db.prepare('SELECT status FROM nodes WHERE enabled = 1').all();
  const offline = nodes.filter((n) => n.status === 'offline').length;
  const degraded = nodes.filter((n) => n.status === 'degraded').length;
  res.json({
    ok: offline === 0,
    nodes_total: nodes.length,
    nodes_online: nodes.filter((n) => n.status === 'online').length,
    nodes_degraded: degraded,
    nodes_offline: offline,
  });
});

router.get('/uptime', requireApiKeyScope('status:read'), (req, res) => {
  const nodes = db.prepare('SELECT name, uptime_seconds, status FROM nodes ORDER BY name ASC').all();
  res.json({ nodes });
});

// ---- Admin-only bot actions ----
router.post('/maintenance', requireApiKeyScope('bot:admin'), json, (req, res) => {
  const { node, enabled } = req.body || {};
  if (!node) return res.status(400).json({ error: 'node is required' });
  const row = db.prepare('SELECT * FROM nodes WHERE name = ? OR uuid = ?').get(node, node);
  if (!row) return res.status(404).json({ error: 'Node not found' });
  const status = enabled === false ? 'online' : 'maintenance';
  db.prepare('UPDATE nodes SET status = ?, updated_at = ? WHERE id = ?').run(status, new Date().toISOString(), row.id);
  res.json({ ok: true, node: row.name, status });
});

router.post('/announce', requireApiKeyScope('bot:admin'), json, (req, res) => {
  // The panel doesn't push into Discord itself; this just records the
  // announcement so the panel/admin UI shows what the bot broadcast.
  const { message } = req.body || {};
  if (!message || !String(message).trim()) return res.status(400).json({ error: 'message is required' });
  db.prepare('INSERT INTO notifications (user_id, title, body, read, created_at) SELECT id, ?, ?, 0, ? FROM users WHERE role = ?')
    .run('Announcement', String(message).trim(), new Date().toISOString(), 'admin');
  res.json({ ok: true });
});

module.exports = router;
