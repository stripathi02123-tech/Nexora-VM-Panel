const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');

if (!fs.existsSync(path.dirname(config.dbPath))) {
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
}

// Fresh install: this schema replaces the old vpanel-pro DB entirely.
// If an old database file exists at config.dbPath, delete it before
// starting the app (or set DB_PATH to a new file) — there is no
// migration path from the old schema to this one.

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
-- ===================== USERS / AUTH =====================

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  root_admin INTEGER NOT NULL DEFAULT 0,
  language TEXT NOT NULL DEFAULT 'en',
  avatar TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  verify_token TEXT,
  suspended INTEGER NOT NULL DEFAULT 0,
  tfa_enabled INTEGER NOT NULL DEFAULT 0,
  tfa_secret TEXT,
  last_login_at TEXT,
  last_login_ip TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  ip TEXT,
  username TEXT,
  status TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reset_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '[]',
  last_used_at TEXT,
  expires_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ===================== NODES =====================

CREATE TABLE IF NOT EXISTS nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE NOT NULL,
  name TEXT UNIQUE NOT NULL,
  location TEXT,
  fqdn TEXT,
  agent_url TEXT,
  agent_token_hash TEXT,
  status TEXT NOT NULL DEFAULT 'offline',
  cpu_cores INTEGER,
  ram_mb INTEGER,
  storage_gb INTEGER,
  agent_version TEXT,
  cpu_usage REAL,
  ram_usage_mb INTEGER,
  disk_usage_gb INTEGER,
  network_rx_bytes INTEGER,
  network_tx_bytes INTEGER,
  uptime_seconds INTEGER,
  last_heartbeat_at TEXT,
  heartbeat_timeout_seconds INTEGER NOT NULL DEFAULT 90,
  notes TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS node_heartbeats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id INTEGER NOT NULL,
  cpu_usage REAL,
  ram_usage_mb INTEGER,
  disk_usage_gb INTEGER,
  network_rx_bytes INTEGER,
  network_tx_bytes INTEGER,
  latency_ms REAL,
  status TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS node_latency_stats (
  node_id INTEGER PRIMARY KEY,
  current_ms REAL,
  avg_ms REAL,
  min_ms REAL,
  max_ms REAL,
  last_success_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS storage_pools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'nvme',
  path TEXT,
  capacity_gb INTEGER NOT NULL,
  used_gb INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
);

-- ===================== NETWORKING =====================

CREATE TABLE IF NOT EXISTS networks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id INTEGER,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'bridge',
  bridge_iface TEXT,
  vlan_tag INTEGER,
  is_private INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS network_interfaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vm_id INTEGER NOT NULL,
  network_id INTEGER,
  mac_address TEXT UNIQUE,
  is_primary INTEGER NOT NULL DEFAULT 1,
  bandwidth_limit_mbps INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY (vm_id) REFERENCES vms(id) ON DELETE CASCADE,
  FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS ip_pools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  subnet_cidr TEXT NOT NULL,
  gateway TEXT,
  netmask TEXT,
  dns_servers TEXT,
  node_id INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS ip_addresses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_id INTEGER NOT NULL,
  address TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'available',
  vm_id INTEGER,
  is_primary INTEGER NOT NULL DEFAULT 1,
  assigned_at TEXT,
  released_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (pool_id) REFERENCES ip_pools(id) ON DELETE CASCADE,
  FOREIGN KEY (vm_id) REFERENCES vms(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS ip_address_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_address_id INTEGER,
  ipv6_address_id INTEGER,
  vm_id INTEGER,
  action TEXT NOT NULL,
  actor_user_id INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY (ip_address_id) REFERENCES ip_addresses(id) ON DELETE CASCADE,
  FOREIGN KEY (ipv6_address_id) REFERENCES ipv6_addresses(id) ON DELETE CASCADE,
  CHECK (ip_address_id IS NOT NULL OR ipv6_address_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS ipv6_pools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  subnet_cidr TEXT NOT NULL,
  prefix_length INTEGER NOT NULL DEFAULT 64,
  gateway TEXT,
  dns_servers TEXT,
  node_id INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS ipv6_addresses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_id INTEGER NOT NULL,
  address TEXT UNIQUE NOT NULL,
  prefix_length INTEGER NOT NULL DEFAULT 64,
  status TEXT NOT NULL DEFAULT 'available',
  vm_id INTEGER,
  is_primary INTEGER NOT NULL DEFAULT 1,
  assigned_at TEXT,
  released_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (pool_id) REFERENCES ipv6_pools(id) ON DELETE CASCADE,
  FOREIGN KEY (vm_id) REFERENCES vms(id) ON DELETE SET NULL
);

-- ===================== PLANS =====================

CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL DEFAULT 'vps',
  cpu_cores INTEGER NOT NULL,
  cpu_dedicated INTEGER NOT NULL DEFAULT 0,
  ram_mb INTEGER NOT NULL,
  disk_gb INTEGER NOT NULL,
  storage_type TEXT NOT NULL DEFAULT 'nvme',
  ipv4_count INTEGER NOT NULL DEFAULT 1,
  ipv6_enabled INTEGER NOT NULL DEFAULT 1,
  bandwidth_tb INTEGER,
  price_cents INTEGER,
  billing_cycle TEXT DEFAULT 'monthly',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plan_nodes (
  plan_id INTEGER NOT NULL,
  node_id INTEGER NOT NULL,
  PRIMARY KEY (plan_id, node_id),
  FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE CASCADE,
  FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
);

-- ===================== OS IMAGES / ISOS =====================

CREATE TABLE IF NOT EXISTS os_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  family TEXT NOT NULL,
  version TEXT,
  codename TEXT,
  source_url TEXT,
  local_path TEXT,
  default_username TEXT DEFAULT 'root',
  cloud_init_supported INTEGER NOT NULL DEFAULT 1,
  is_custom INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS isos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  file_path TEXT,
  source_url TEXT,
  size_mb INTEGER,
  uploaded_by INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL
);

-- ===================== VMS (VPS + VDS share this table) =====================

CREATE TABLE IF NOT EXISTS vms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE NOT NULL,
  owner_id INTEGER NOT NULL,
  resource_type TEXT NOT NULL DEFAULT 'vps',
  name TEXT NOT NULL,
  hostname TEXT,
  plan_id INTEGER,
  node_id INTEGER,
  storage_pool_id INTEGER,
  os_image_id INTEGER,
  os_type TEXT,
  codename TEXT,
  img_url TEXT,
  username TEXT,
  password TEXT,
  ssh_public_key TEXT,
  disk_size TEXT DEFAULT '20G',
  memory INTEGER DEFAULT 2048,
  cpus INTEGER DEFAULT 2,
  cpu_dedicated INTEGER NOT NULL DEFAULT 0,
  bandwidth_limit_mbps INTEGER,
  ssh_port INTEGER,
  gui_mode INTEGER NOT NULL DEFAULT 0,
  port_forwards TEXT,
  img_file TEXT,
  seed_file TEXT,
  cloud_init_config TEXT,
  start_on_boot INTEGER NOT NULL DEFAULT 0,
  startup_command TEXT,
  auto_create INTEGER NOT NULL DEFAULT 1,
  status TEXT DEFAULT 'pending',
  provisioning_stage TEXT,
  rescue_mode INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  vnc_port INTEGER,
  agent_port INTEGER,
  agent_token TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE SET NULL,
  FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE SET NULL,
  FOREIGN KEY (storage_pool_id) REFERENCES storage_pools(id) ON DELETE SET NULL,
  FOREIGN KEY (os_image_id) REFERENCES os_images(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS subusers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vm_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  permissions TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (vm_id) REFERENCES vms(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vm_id INTEGER NOT NULL,
  name TEXT,
  file_path TEXT,
  size_mb INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'completed',
  created_at TEXT NOT NULL,
  FOREIGN KEY (vm_id) REFERENCES vms(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vm_id INTEGER NOT NULL,
  name TEXT,
  file TEXT,
  size INTEGER DEFAULT 0,
  kind TEXT DEFAULT 'full',
  status TEXT NOT NULL DEFAULT 'completed',
  created_at TEXT NOT NULL,
  FOREIGN KEY (vm_id) REFERENCES vms(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vm_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  cron TEXT NOT NULL,
  action TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  next_run_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (vm_id) REFERENCES vms(id) ON DELETE CASCADE
);

-- ===================== TASKS (async provisioning / jobs) =====================

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL,
  vm_id INTEGER,
  node_id INTEGER,
  actor_user_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  progress INTEGER NOT NULL DEFAULT 0,
  stage TEXT,
  payload TEXT,
  result TEXT,
  error TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (vm_id) REFERENCES vms(id) ON DELETE SET NULL,
  FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS task_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

-- ===================== METRICS =====================

CREATE TABLE IF NOT EXISTS metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  cpu_usage REAL,
  ram_usage_mb INTEGER,
  disk_usage_gb INTEGER,
  network_rx_bytes INTEGER,
  network_tx_bytes INTEGER,
  created_at TEXT NOT NULL
);

-- ===================== ACTIVITY / AUDIT =====================

CREATE TABLE IF NOT EXISTS activity_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  vm_id INTEGER,
  event TEXT NOT NULL,
  details TEXT,
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER,
  actor_type TEXT NOT NULL DEFAULT 'user',
  action TEXT NOT NULL,
  target_type TEXT,
  target_id INTEGER,
  details TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);

-- ===================== MISC =====================

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT,
  body TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ===================== INDEXES =====================

CREATE INDEX IF NOT EXISTS idx_vms_owner ON vms(owner_id);
CREATE INDEX IF NOT EXISTS idx_vms_node ON vms(node_id);
CREATE INDEX IF NOT EXISTS idx_vms_status ON vms(status);
CREATE INDEX IF NOT EXISTS idx_vms_resource_type ON vms(resource_type);
CREATE INDEX IF NOT EXISTS idx_subusers_vm ON subusers(vm_id);
CREATE INDEX IF NOT EXISTS idx_subusers_user ON subusers(user_id);
CREATE INDEX IF NOT EXISTS idx_backups_vm ON backups(vm_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_vm ON snapshots(vm_id);
CREATE INDEX IF NOT EXISTS idx_schedules_vm ON schedules(vm_id);
CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_vm ON activity_logs(vm_id);
CREATE INDEX IF NOT EXISTS idx_login_ip ON login_attempts(ip);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_user_id);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_logs(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_ip_addresses_pool ON ip_addresses(pool_id);
CREATE INDEX IF NOT EXISTS idx_ip_addresses_status ON ip_addresses(status);
CREATE INDEX IF NOT EXISTS idx_ip_addresses_vm ON ip_addresses(vm_id);
CREATE INDEX IF NOT EXISTS idx_ipv6_addresses_pool ON ipv6_addresses(pool_id);
CREATE INDEX IF NOT EXISTS idx_ipv6_addresses_status ON ipv6_addresses(status);
CREATE INDEX IF NOT EXISTS idx_ipv6_addresses_vm ON ipv6_addresses(vm_id);
CREATE INDEX IF NOT EXISTS idx_ip_history_ip ON ip_address_history(ip_address_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_vm ON tasks(vm_id);
CREATE INDEX IF NOT EXISTS idx_tasks_node ON tasks(node_id);
CREATE INDEX IF NOT EXISTS idx_task_logs_task ON task_logs(task_id);
CREATE INDEX IF NOT EXISTS idx_metrics_entity ON metrics(entity_type, entity_id, created_at);
CREATE INDEX IF NOT EXISTS idx_node_heartbeats_node ON node_heartbeats(node_id, created_at);
CREATE INDEX IF NOT EXISTS idx_network_interfaces_vm ON network_interfaces(vm_id);
CREATE INDEX IF NOT EXISTS idx_storage_pools_node ON storage_pools(node_id);
CREATE INDEX IF NOT EXISTS idx_plan_nodes_plan ON plan_nodes(plan_id);
`);

const defaultSettings = {
  'panel.name': 'Nexora Cloud',
  'panel.logo_mode': 'url',
  'panel.logo_url': '',
  'panel.logo_file': '',
  'panel.favicon_name': 'nexora',
  'panel.favicon_mode': 'url',
  'panel.favicon_url': '',
  'panel.favicon_file': '',
  'panel.bg_mode': 'color',
  'panel.bg_color': '#0b1020',
  'panel.bg_url': '',
  'panel.bg_file': '',
  'panel.bg_video_file': '',
  'panel.bg_video_url': '',
  'panel.bg_cover': '1',
  'panel.bg_overlay': '0.55',
  'panel.music_mode': 'none',
  'panel.music_url': '',
  'panel.music_file': '',
  'panel.music_youtube': '',
  'panel.music_autoplay': '0',
  'panel.music_loop': '1',
  'panel.music_volume': '35',
  'panel.navbar_style': 'glass',
  'panel.navbar_transparent': '1',
  'panel.navbar_blur': '1',
  'panel.accent': '#6366f1',
  'panel.theme': 'dark',
  'panel.wallpapers_api_key': '',
  'mail.host': config.mail.host,
  'mail.port': String(config.mail.port),
  'mail.secure': String(config.mail.secure),
  'mail.user': config.mail.user,
  'mail.pass': config.mail.pass,
  'mail.from': config.mail.from,
  'mail.verify': String(Boolean(config.mail.host)),
  'security.allow_register': config.allowRegister ? '1' : '0',
  'security.require_verify': '0',
  'security.force_tfa': '0',
  'vm.auto_port_min': String(config.autoPortMin),
  'vm.auto_port_max': String(config.autoPortMax),
  'vm.vnc_port_min': String(config.autoVncPortMin),
  'vm.vnc_port_max': String(config.autoVncPortMax),
  'vm.agent_port_min': String(config.autoAgentPortMin),
  'vm.agent_port_max': String(config.autoAgentPortMax),
  'vm.default_memory': '2048',
  'vm.default_cpus': '2',
  'vm.default_disk': '20G',
  'vm.default_os': 'Ubuntu 24.04',
  'vm.os_list': JSON.stringify([
    ['Ubuntu 22.04', 'ubuntu', 'jammy', 'https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.img', 'ubuntu', 'root'],
    ['Ubuntu 24.04', 'ubuntu', 'noble', 'https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img', 'ubuntu', 'root'],
    ['Debian 11', 'debian', 'bullseye', 'https://cloud.debian.org/images/cloud/bullseye/latest/debian-11-generic-amd64.qcow2', 'debian', 'root'],
    ['Debian 12', 'debian', 'bookworm', 'https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-generic-amd64.qcow2', 'debian', 'root'],
    ['Rocky Linux 9', 'rockylinux', '9', 'https://download.rockylinux.org/pub/rocky/9/images/x86_64/Rocky-9-GenericCloud.latest.x86_64.qcow2', 'rocky', 'root'],
    ['AlmaLinux 9', 'almalinux', '9', 'https://repo.almalinux.org/almalinux/9/cloud/x86_64/images/AlmaLinux-9-GenericCloud-latest.x86_64.qcow2', 'almalinux', 'root'],
  ]),
  'node.heartbeat_timeout_seconds': '90',
  'discord.bot_token': '',
  'discord.status_channel_id': '',
  'discord.status_message_id': '',
  'discord.enabled': '0',
};

function seedSettings() {
  const stmt = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(defaultSettings)) stmt.run(k, v);
}
seedSettings();

function seedOsImages() {
  const existing = db.prepare('SELECT COUNT(*) AS c FROM os_images').get();
  if (existing.c > 0) return;
  const now = new Date().toISOString();
  const rows = [
    ['Ubuntu 22.04', 'ubuntu', '22.04', 'jammy', 'https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.img', 'ubuntu'],
    ['Ubuntu 24.04', 'ubuntu', '24.04', 'noble', 'https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img', 'ubuntu'],
    ['Debian 11', 'debian', '11', 'bullseye', 'https://cloud.debian.org/images/cloud/bullseye/latest/debian-11-generic-amd64.qcow2', 'debian'],
    ['Debian 12', 'debian', '12', 'bookworm', 'https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-generic-amd64.qcow2', 'debian'],
    ['Rocky Linux 9', 'rockylinux', '9', '9', 'https://download.rockylinux.org/pub/rocky/9/images/x86_64/Rocky-9-GenericCloud.latest.x86_64.qcow2', 'rocky'],
    ['AlmaLinux 9', 'almalinux', '9', '9', 'https://repo.almalinux.org/almalinux/9/cloud/x86_64/images/AlmaLinux-9-GenericCloud-latest.x86_64.qcow2', 'almalinux'],
  ];
  const stmt = db.prepare(`INSERT INTO os_images (name, family, version, codename, source_url, default_username, cloud_init_supported, is_custom, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, 0, 1, ?, ?)`);
  for (const r of rows) stmt.run(r[0], r[1], r[2], r[3], r[4], r[5], now, now);
}
seedOsImages();

const S = {
  get(key, fallback = null) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (!row) return fallback;
    try { return JSON.parse(row.value); } catch (_) { return row.value; }
  },
  set(key, value) {
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(key, typeof value === 'string' ? value : JSON.stringify(value));
  },
  all() {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const out = {};
    for (const r of rows) {
      try { out[r.key] = JSON.parse(r.value); } catch (_) { out[r.key] = r.value; }
    }
    return out;
  },
};

module.exports = { db, settings: S };
