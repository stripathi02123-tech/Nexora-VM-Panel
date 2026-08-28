const { db } = require('../lib/db');
const logger = require('../lib/logger');

function now() { return new Date().toISOString(); }

// ===================== helpers: CIDR expansion =====================

function ipv4ToLong(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    throw new Error(`Invalid IPv4 address: ${ip}`);
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function longToIpv4(long) {
  return [24, 16, 8, 0].map((shift) => (long >>> shift) & 255).join('.');
}

/**
 * Expand an IPv4 CIDR into usable host addresses (excludes network + broadcast for /30 and larger).
 * Caps expansion at 65536 addresses as a safety limit.
 */
function expandIpv4Cidr(cidr) {
  const [base, prefixStr] = cidr.split('/');
  const prefix = Number(prefixStr);
  if (!base || Number.isNaN(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`Invalid IPv4 CIDR: ${cidr}`);
  }
  const hostBits = 32 - prefix;
  const size = hostBits >= 16 ? 65536 : (1 << hostBits);
  if (size > 65536) throw new Error(`CIDR too large to expand: ${cidr}`);
  const network = ipv4ToLong(base) & (hostBits === 32 ? 0 : (~0 << hostBits) >>> 0);
  const addrs = [];
  const usable = prefix >= 31 ? size : size - 2; // /31, /32 have no network/broadcast reserved
  const start = prefix >= 31 ? 0 : 1;
  for (let i = start; i < start + usable; i++) {
    addrs.push(longToIpv4((network + i) >>> 0));
  }
  return addrs;
}

// ===================== IPv4 pools =====================

function createIpv4Pool({ name, subnetCidr, gateway, netmask, dnsServers = [], nodeId = null, populate = true }) {
  const ts = now();
  const result = db.prepare(`
    INSERT INTO ip_pools (name, subnet_cidr, gateway, netmask, dns_servers, node_id, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(name, subnetCidr, gateway || null, netmask || null, JSON.stringify(dnsServers), nodeId, ts, ts);
  const poolId = result.lastInsertRowid;

  if (populate) {
    const addrs = expandIpv4Cidr(subnetCidr);
    const insert = db.prepare(`
      INSERT OR IGNORE INTO ip_addresses (pool_id, address, status, created_at, updated_at)
      VALUES (?, ?, 'available', ?, ?)
    `);
    const tx = db.transaction((list) => {
      for (const addr of list) insert.run(poolId, addr, ts, ts);
    });
    tx(addrs);
    logger.info(`ipamService: populated pool ${name} (${poolId}) with ${addrs.length} IPv4 addresses`);
  }

  return getIpv4Pool(poolId);
}

function getIpv4Pool(id) {
  return db.prepare('SELECT * FROM ip_pools WHERE id = ?').get(id);
}

function listIpv4Pools() {
  return db.prepare('SELECT * FROM ip_pools ORDER BY id DESC').all();
}

function poolStats(poolId) {
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS c FROM ip_addresses WHERE pool_id = ? GROUP BY status
  `).all(poolId);
  const stats = { available: 0, reserved: 0, assigned: 0, released: 0, disabled: 0 };
  for (const r of rows) stats[r.status] = r.c;
  return stats;
}

/**
 * Atomically allocate one available IPv4 address from a pool and assign it to a VM.
 * Uses an IMMEDIATE transaction so two simultaneous provisioning jobs cannot receive the same IP.
 */
function allocateIpv4({ poolId, vmId, isPrimary = true, actorUserId = null }) {
  const ts = now();
  const tx = db.transaction(() => {
    const candidate = db.prepare(`
      SELECT id, address FROM ip_addresses
      WHERE pool_id = ? AND status = 'available'
      ORDER BY id ASC LIMIT 1
    `).get(poolId);
    if (!candidate) {
      throw new Error(`No available IPv4 addresses in pool ${poolId}`);
    }
    const res = db.prepare(`
      UPDATE ip_addresses
      SET status = 'assigned', vm_id = ?, is_primary = ?, assigned_at = ?, updated_at = ?
      WHERE id = ? AND status = 'available'
    `).run(vmId, isPrimary ? 1 : 0, ts, ts, candidate.id);
    if (res.changes !== 1) {
      // Lost the race to another transaction; caller should retry.
      throw new Error('IPv4_ALLOCATION_RACE');
    }
    db.prepare(`
      INSERT INTO ip_address_history (ip_address_id, vm_id, action, actor_user_id, created_at)
      VALUES (?, ?, 'allocated', ?, ?)
    `).run(candidate.id, vmId, actorUserId, ts);
    return db.prepare('SELECT * FROM ip_addresses WHERE id = ?').get(candidate.id);
  });

  // Retry a few times on race loss (extremely unlikely with better-sqlite3's synchronous
  // transactions, but guards against future concurrent-writer configurations).
  let attempts = 0;
  while (attempts < 5) {
    try {
      return tx.immediate();
    } catch (err) {
      if (err.message === 'IPv4_ALLOCATION_RACE') { attempts++; continue; }
      throw err;
    }
  }
  throw new Error(`Failed to allocate IPv4 from pool ${poolId} after retries`);
}

function releaseIpv4(ipAddressId, actorUserId = null) {
  const ts = now();
  const tx = db.transaction(() => {
    const ip = db.prepare('SELECT * FROM ip_addresses WHERE id = ?').get(ipAddressId);
    if (!ip) throw new Error(`IPv4 address ${ipAddressId} not found`);
    db.prepare(`
      UPDATE ip_addresses SET status = 'available', vm_id = NULL, released_at = ?, updated_at = ?
      WHERE id = ?
    `).run(ts, ts, ipAddressId);
    db.prepare(`
      INSERT INTO ip_address_history (ip_address_id, vm_id, action, actor_user_id, created_at)
      VALUES (?, ?, 'released', ?, ?)
    `).run(ipAddressId, ip.vm_id, actorUserId, ts);
  });
  tx.immediate();
}

function releaseAllForVm(vmId, actorUserId = null) {
  const rows = db.prepare(`SELECT id FROM ip_addresses WHERE vm_id = ? AND status = 'assigned'`).all(vmId);
  for (const row of rows) releaseIpv4(row.id, actorUserId);
  const v6rows = db.prepare(`SELECT id FROM ipv6_addresses WHERE vm_id = ? AND status = 'assigned'`).all(vmId);
  for (const row of v6rows) releaseIpv6(row.id, actorUserId);
}

function reserveIpv4(ipAddressId, actorUserId = null) {
  const ts = now();
  db.prepare(`UPDATE ip_addresses SET status = 'reserved', updated_at = ? WHERE id = ? AND status = 'available'`)
    .run(ts, ipAddressId);
  db.prepare(`INSERT INTO ip_address_history (ip_address_id, action, actor_user_id, created_at) VALUES (?, 'reserved', ?, ?)`)
    .run(ipAddressId, actorUserId, ts);
}

function disableIpv4(ipAddressId, actorUserId = null) {
  const ts = now();
  db.prepare(`UPDATE ip_addresses SET status = 'disabled', updated_at = ? WHERE id = ?`).run(ts, ipAddressId);
  db.prepare(`INSERT INTO ip_address_history (ip_address_id, action, actor_user_id, created_at) VALUES (?, 'disabled', ?, ?)`)
    .run(ipAddressId, actorUserId, ts);
}

function reassignIpv4(ipAddressId, newVmId, actorUserId = null) {
  const ts = now();
  const tx = db.transaction(() => {
    db.prepare(`UPDATE ip_addresses SET vm_id = ?, status = 'assigned', assigned_at = ?, updated_at = ? WHERE id = ?`)
      .run(newVmId, ts, ts, ipAddressId);
    db.prepare(`INSERT INTO ip_address_history (ip_address_id, vm_id, action, actor_user_id, created_at) VALUES (?, ?, 'reassigned', ?, ?)`)
      .run(ipAddressId, newVmId, actorUserId, ts);
  });
  tx.immediate();
}

function searchIpv4(query) {
  return db.prepare(`
    SELECT ip_addresses.*, ip_pools.name AS pool_name FROM ip_addresses
    JOIN ip_pools ON ip_pools.id = ip_addresses.pool_id
    WHERE ip_addresses.address LIKE ?
    ORDER BY ip_addresses.id DESC LIMIT 100
  `).all(`%${query}%`);
}

function ipHistory(ipAddressId) {
  return db.prepare('SELECT * FROM ip_address_history WHERE ip_address_id = ? ORDER BY id DESC').all(ipAddressId);
}

function vmIpv4Addresses(vmId) {
  return db.prepare('SELECT * FROM ip_addresses WHERE vm_id = ?').all(vmId);
}

// ===================== IPv6 pools =====================

function createIpv6Pool({ name, subnetCidr, prefixLength = 64, gateway, dnsServers = [], nodeId = null }) {
  const ts = now();
  const result = db.prepare(`
    INSERT INTO ipv6_pools (name, subnet_cidr, prefix_length, gateway, dns_servers, node_id, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(name, subnetCidr, prefixLength, gateway || null, JSON.stringify(dnsServers), nodeId, ts, ts);
  return getIpv6Pool(result.lastInsertRowid);
}

function getIpv6Pool(id) {
  return db.prepare('SELECT * FROM ipv6_pools WHERE id = ?').get(id);
}

function listIpv6Pools() {
  return db.prepare('SELECT * FROM ipv6_pools ORDER BY id DESC').all();
}

/**
 * IPv6 addresses are allocated on demand from the pool's /64 (or configured prefix)
 * rather than pre-expanded like IPv4 — the address space is too large to enumerate.
 * We derive a deterministic-but-unique host suffix and record it in ipv6_addresses,
 * checking for collisions inside the same transaction that assigns it.
 */
function deriveIpv6Address(subnetCidr, index) {
  const [base] = subnetCidr.split('/');
  // Normalize base to its network form, append a hex host id in the last segment.
  const trimmed = base.replace(/::$/, '');
  const suffix = index.toString(16).padStart(4, '0');
  return `${trimmed}${trimmed.endsWith(':') ? '' : ':'}${suffix}`;
}

function allocateIpv6({ poolId, vmId, isPrimary = true, actorUserId = null }) {
  const pool = getIpv6Pool(poolId);
  if (!pool) throw new Error(`IPv6 pool ${poolId} not found`);
  const ts = now();

  const tx = db.transaction(() => {
    // Reuse a released/available address if one already exists in this pool.
    const existing = db.prepare(`
      SELECT id, address FROM ipv6_addresses
      WHERE pool_id = ? AND status = 'available'
      ORDER BY id ASC LIMIT 1
    `).get(poolId);

    let addrRow;
    if (existing) {
      const res = db.prepare(`
        UPDATE ipv6_addresses SET status = 'assigned', vm_id = ?, is_primary = ?, assigned_at = ?, updated_at = ?
        WHERE id = ? AND status = 'available'
      `).run(vmId, isPrimary ? 1 : 0, ts, ts, existing.id);
      if (res.changes !== 1) throw new Error('IPV6_ALLOCATION_RACE');
      addrRow = db.prepare('SELECT * FROM ipv6_addresses WHERE id = ?').get(existing.id);
    } else {
      // Generate a new address in this pool, retrying on unique-constraint collision.
      const countRow = db.prepare('SELECT COUNT(*) AS c FROM ipv6_addresses WHERE pool_id = ?').get(poolId);
      let idx = countRow.c + 1;
      let inserted = null;
      for (let attempt = 0; attempt < 20 && !inserted; attempt++, idx++) {
        const candidate = deriveIpv6Address(pool.subnet_cidr, idx);
        try {
          const res = db.prepare(`
            INSERT INTO ipv6_addresses (pool_id, address, prefix_length, status, vm_id, is_primary, assigned_at, created_at, updated_at)
            VALUES (?, ?, ?, 'assigned', ?, ?, ?, ?, ?)
          `).run(poolId, candidate, pool.prefix_length, vmId, isPrimary ? 1 : 0, ts, ts, ts);
          inserted = db.prepare('SELECT * FROM ipv6_addresses WHERE id = ?').get(res.lastInsertRowid);
        } catch (e) {
          if (!/UNIQUE constraint/.test(e.message)) throw e;
        }
      }
      if (!inserted) throw new Error(`Could not derive a unique IPv6 address in pool ${poolId}`);
      addrRow = inserted;
    }

    db.prepare(`
      INSERT INTO ip_address_history (ipv6_address_id, vm_id, action, actor_user_id, created_at)
      VALUES (?, ?, 'allocated', ?, ?)
    `).run(addrRow.id, vmId, actorUserId, ts);
    return addrRow;
  });

  let attempts = 0;
  while (attempts < 5) {
    try {
      return tx.immediate();
    } catch (err) {
      if (err.message === 'IPV6_ALLOCATION_RACE') { attempts++; continue; }
      throw err;
    }
  }
  throw new Error(`Failed to allocate IPv6 from pool ${poolId} after retries`);
}

function releaseIpv6(ipAddressId, actorUserId = null) {
  const ts = now();
  const tx = db.transaction(() => {
    const ip = db.prepare('SELECT * FROM ipv6_addresses WHERE id = ?').get(ipAddressId);
    if (!ip) throw new Error(`IPv6 address ${ipAddressId} not found`);
    db.prepare(`
      UPDATE ipv6_addresses SET status = 'available', vm_id = NULL, released_at = ?, updated_at = ?
      WHERE id = ?
    `).run(ts, ts, ipAddressId);
    db.prepare(`
      INSERT INTO ip_address_history (ipv6_address_id, vm_id, action, actor_user_id, created_at)
      VALUES (?, ?, 'released', ?, ?)
    `).run(ipAddressId, ip.vm_id, actorUserId, ts);
  });
  tx.immediate();
}

function ipv6History(ipAddressId) {
  return db.prepare('SELECT * FROM ip_address_history WHERE ipv6_address_id = ? ORDER BY id DESC').all(ipAddressId);
}

function vmIpv6Addresses(vmId) {
  return db.prepare('SELECT * FROM ipv6_addresses WHERE vm_id = ?').all(vmId);
}

// ===================== dual-stack convenience =====================

/**
 * Allocate a dual-stack address set for a VM from the given plan/pool config.
 * Rolls back any partial allocation if either step fails.
 */
function allocateDualStack({ vmId, ipv4PoolId, ipv6PoolId = null, actorUserId = null }) {
  let v4 = null;
  let v6 = null;
  try {
    v4 = allocateIpv4({ poolId: ipv4PoolId, vmId, actorUserId });
    if (ipv6PoolId) {
      v6 = allocateIpv6({ poolId: ipv6PoolId, vmId, actorUserId });
    }
    return { ipv4: v4, ipv6: v6 };
  } catch (err) {
    if (v4) releaseIpv4(v4.id, actorUserId);
    if (v6) releaseIpv6(v6.id, actorUserId);
    throw err;
  }
}

module.exports = {
  expandIpv4Cidr,
  createIpv4Pool,
  getIpv4Pool,
  listIpv4Pools,
  poolStats,
  allocateIpv4,
  releaseIpv4,
  releaseAllForVm,
  reserveIpv4,
  disableIpv4,
  reassignIpv4,
  searchIpv4,
  ipHistory,
  vmIpv4Addresses,
  createIpv6Pool,
  getIpv6Pool,
  listIpv6Pools,
  allocateIpv6,
  releaseIpv6,
  ipv6History,
  vmIpv6Addresses,
  allocateDualStack,
};
