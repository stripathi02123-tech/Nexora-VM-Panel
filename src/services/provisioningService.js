const { db } = require('../lib/db');
const logger = require('../lib/logger');
const taskService = require('./taskService');
const ipamService = require('./ipamService');
const vmService = require('./vmService');
const { logActivity } = require('./activityService');

function now() { return new Date().toISOString(); }

// ===================== node/storage selection =====================

function getNode(nodeId) {
  return db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);
}

function listOnlineNodes() {
  return db.prepare(`SELECT * FROM nodes WHERE enabled = 1 AND status IN ('online', 'degraded') ORDER BY id ASC`).all();
}

/**
 * Pick a node with enough free CPU/RAM/disk for the requested plan.
 * Never fakes availability — if no node qualifies, throws.
 */
function selectNode({ nodeId, cpuCores, ramMb, diskGb }) {
  if (nodeId) {
    const node = getNode(nodeId);
    if (!node) throw new Error(`Node ${nodeId} not found`);
    if (node.status === 'offline' || node.status === 'maintenance' || !node.enabled) {
      throw new Error(`Node ${node.name} is not available (status: ${node.status})`);
    }
    return node;
  }
  const candidates = listOnlineNodes();
  for (const node of candidates) {
    const usedRam = db.prepare(`SELECT COALESCE(SUM(memory),0) AS s FROM vms WHERE node_id = ? AND status != 'deleted'`).get(node.id).s;
    const usedCpu = db.prepare(`SELECT COALESCE(SUM(cpus),0) AS s FROM vms WHERE node_id = ? AND status != 'deleted'`).get(node.id).s;
    const freeRam = (node.ram_mb || 0) - usedRam;
    const freeCpu = (node.cpu_cores || 0) - usedCpu;
    if (freeRam >= ramMb && freeCpu >= cpuCores) return node;
  }
  throw new Error('No node has sufficient available resources for this plan');
}

function selectStoragePool({ nodeId, diskGb, preferredType = null }) {
  const pools = db.prepare(`SELECT * FROM storage_pools WHERE node_id = ? AND enabled = 1 ORDER BY id ASC`).all(nodeId);
  for (const pool of pools) {
    if (preferredType && pool.type !== preferredType) continue;
    const free = pool.capacity_gb - pool.used_gb;
    if (free >= diskGb) return pool;
  }
  // Fall back to any pool with room, ignoring type preference.
  for (const pool of pools) {
    const free = pool.capacity_gb - pool.used_gb;
    if (free >= diskGb) return pool;
  }
  return null; // Not fatal — node may manage its own storage without a tracked pool.
}

function reserveStorage(poolId, diskGb) {
  if (!poolId) return;
  db.prepare('UPDATE storage_pools SET used_gb = used_gb + ?, updated_at = ? WHERE id = ?').run(diskGb, now(), poolId);
}

function releaseStorage(poolId, diskGb) {
  if (!poolId) return;
  db.prepare('UPDATE storage_pools SET used_gb = MAX(0, used_gb - ?), updated_at = ? WHERE id = ?').run(diskGb, now(), poolId);
}

// ===================== plan resolution =====================

function resolvePlan(planId) {
  if (!planId) return null;
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId);
  if (!plan) throw new Error(`Plan ${planId} not found`);
  if (!plan.enabled) throw new Error(`Plan ${plan.name} is disabled`);
  return plan;
}

// ===================== permission / quota validation =====================

function validateOwnerPermissions(user) {
  if (!user) throw new Error('Not authenticated');
  if (user.suspended) throw new Error('Account is suspended');
}

// ===================== main provisioning pipeline =====================

/**
 * Create a VPS or VDS through the full async pipeline:
 * validate -> select node -> select storage -> allocate IPv4 -> allocate IPv6 ->
 * create VM -> create disk -> configure network -> generate cloud-init ->
 * install/configure OS -> start VM -> health check -> mark READY.
 *
 * Returns the created task immediately; the pipeline runs in the background
 * and reports progress via taskService (and, through it, socket.io).
 */
function provisionVm({ user, data, resourceType = 'vps' }) {
  validateOwnerPermissions(user);

  const plan = resolvePlan(data.plan_id);
  const cpuCores = parseInt(data.cpus || (plan && plan.cpu_cores) || 2, 10);
  const ramMb = parseInt(data.memory || (plan && plan.ram_mb) || 2048, 10);
  const diskGb = parseInt(
    data.disk_size ? String(data.disk_size).replace(/[^0-9]/g, '') : (plan && plan.disk_gb) || 20, 10
  );
  const wantsIpv6 = data.ipv6_pool_id || (plan && plan.ipv6_enabled);
  const cpuDedicated = resourceType === 'vds' ? 1 : (plan && plan.cpu_dedicated ? 1 : 0);

  const task = taskService.create({
    type: resourceType === 'vds' ? 'vds_create' : 'vps_create',
    actorUserId: user.id,
    payload: { name: data.name, plan_id: data.plan_id, resource_type: resourceType },
  });

  // Run the pipeline asynchronously; caller gets the task handle immediately.
  runProvisioningPipeline(task, { user, data, resourceType, plan, cpuCores, ramMb, diskGb, wantsIpv6, cpuDedicated })
    .catch((e) => logger.error(`[provisioning] task ${task.id} crashed outside step handling: ${e.stack || e.message}`));

  return task;
}

async function runProvisioningPipeline(task, { user, data, resourceType, plan, cpuCores, ramMb, diskGb, wantsIpv6, cpuDedicated }) {
  const steps = [
    {
      name: 'validate',
      run: async () => {
        validateOwnerPermissions(user);
        const vmName = String(data.name || '').trim().replace(/\s+/g, '-');
        if (!vmName || !/^[a-zA-Z0-9_-]+$/.test(vmName)) {
          throw new Error('VPS name can only contain letters, numbers, hyphens, underscores');
        }
        return { vmName };
      },
    },
    {
      name: 'select_node',
      run: async () => {
        const node = selectNode({ nodeId: data.node_id ? parseInt(data.node_id, 10) : null, cpuCores, ramMb, diskGb });
        return node;
      },
    },
    {
      name: 'select_storage',
      run: async (ctx) => {
        const node = ctx.results.select_node;
        const pool = selectStoragePool({ nodeId: node.id, diskGb, preferredType: data.storage_type || null });
        if (pool) reserveStorage(pool.id, diskGb);
        return pool;
      },
      rollback: async (ctx, pool) => {
        if (pool) releaseStorage(pool.id, diskGb);
      },
    },
    {
      name: 'allocate_ipv4',
      run: async () => {
        const poolId = data.ip_pool_id ? parseInt(data.ip_pool_id, 10) : null;
        if (!poolId) {
          const anyPool = db.prepare(`SELECT id FROM ip_pools WHERE enabled = 1 ORDER BY id ASC LIMIT 1`).get();
          if (!anyPool) throw new Error('No IPv4 pool configured');
          return ipamService.allocateIpv4({ poolId: anyPool.id, vmId: null, actorUserId: user.id, isPrimary: true });
        }
        return ipamService.allocateIpv4({ poolId, vmId: null, actorUserId: user.id, isPrimary: true });
      },
      rollback: async (ctx, ip) => {
        if (ip) ipamService.releaseIpv4(ip.id, user.id);
      },
    },
    {
      name: 'allocate_ipv6',
      run: async () => {
        if (!wantsIpv6) return null;
        const poolId = data.ipv6_pool_id ? parseInt(data.ipv6_pool_id, 10) : null;
        const pool = poolId ? ipamService.getIpv6Pool(poolId) : db.prepare('SELECT * FROM ipv6_pools WHERE enabled = 1 ORDER BY id ASC LIMIT 1').get();
        if (!pool) return null; // IPv6 optional if nothing configured
        return ipamService.allocateIpv6({ poolId: pool.id, vmId: null, actorUserId: user.id, isPrimary: true });
      },
      rollback: async (ctx, ip6) => {
        if (ip6) ipamService.releaseIpv6(ip6.id, user.id);
      },
    },
    {
      name: 'create_vm',
      run: async (ctx) => {
        const node = ctx.results.select_node;
        const pool = ctx.results.select_storage;
        let vm;
        try {
          vm = await vmService.create({ user, data: { ...data, cpus: cpuCores, memory: ramMb, disk_size: `${diskGb}G` } });
        } catch (err) {
          // vmService.create() inserts the DB row before attempting the image
          // download/resize, so a failure partway through can leave an orphaned
          // row. Clean it up here since the step never returned a value for
          // the rollback list to act on.
          const orphan = db.prepare('SELECT * FROM vms WHERE owner_id = ? AND name = ? ORDER BY id DESC LIMIT 1')
            .get(user.id, String(data.name || '').trim().replace(/\s+/g, '-'));
          if (orphan && orphan.status !== 'running') {
            try { vmService.remove(orphan, user); } catch (_) { /* best effort */ }
          }
          throw err;
        }
        db.prepare(`
          UPDATE vms SET resource_type = ?, plan_id = ?, node_id = ?, storage_pool_id = ?, cpu_dedicated = ?,
            provisioning_stage = 'creating_vm', status = 'provisioning', updated_at = ?
          WHERE id = ?
        `).run(resourceType, data.plan_id || null, node.id, pool ? pool.id : null, cpuDedicated, now(), vm.id);
        return vmService.getVm(vm.id);
      },
      rollback: async (ctx, vm) => {
        if (vm) {
          try { vmService.remove(vm, user); } catch (e) { logger.error(`rollback: failed to remove vm ${vm.id}: ${e.message}`); }
        }
      },
    },
    {
      name: 'configure_network',
      run: async (ctx) => {
        const vm = ctx.results.create_vm;
        const ip4 = ctx.results.allocate_ipv4;
        const ip6 = ctx.results.allocate_ipv6;
        if (ip4) db.prepare('UPDATE ip_addresses SET vm_id = ?, assigned_at = ?, updated_at = ? WHERE id = ?').run(vm.id, now(), now(), ip4.id);
        if (ip6) db.prepare('UPDATE ipv6_addresses SET vm_id = ?, assigned_at = ?, updated_at = ? WHERE id = ?').run(vm.id, now(), now(), ip6.id);
        db.prepare(`INSERT INTO network_interfaces (vm_id, is_primary, bandwidth_limit_mbps, created_at) VALUES (?, 1, ?, ?)`)
          .run(vm.id, data.bandwidth_limit_mbps || null, now());
        db.prepare(`UPDATE vms SET provisioning_stage = 'configuring_network', updated_at = ? WHERE id = ?`).run(now(), vm.id);
        return { ip4, ip6 };
      },
    },
    {
      name: 'cloud_init',
      run: async (ctx) => {
        const vm = ctx.results.create_vm;
        db.prepare(`UPDATE vms SET provisioning_stage = 'cloud_init', cloud_init_config = ?, updated_at = ? WHERE id = ?`)
          .run(JSON.stringify(data.cloud_init || {}), now(), vm.id);
        return true;
      },
    },
    {
      name: 'start_vm',
      run: async (ctx) => {
        const vm = vmService.getVm(ctx.results.create_vm.id);
        db.prepare(`UPDATE vms SET provisioning_stage = 'starting', updated_at = ? WHERE id = ?`).run(now(), vm.id);
        await vmService.start(vm, { user });
        return true;
      },
    },
    {
      name: 'health_check',
      run: async (ctx) => {
        const vm = vmService.getVm(ctx.results.create_vm.id);
        db.prepare(`UPDATE vms SET provisioning_stage = 'health_check', updated_at = ? WHERE id = ?`).run(now(), vm.id);
        // Poll briefly for the process to actually be up rather than assuming success.
        const deadline = Date.now() + 15000;
        let healthy = false;
        while (Date.now() < deadline) {
          if (vmService.isRunning(vm)) { healthy = true; break; }
          await new Promise((r) => setTimeout(r, 1000));
        }
        if (!healthy) throw new Error('VM did not report running state within health check window');
        return true;
      },
    },
  ];

  const result = await taskService.runWithRollback(task, steps);

  if (result.ok) {
    const vm = result.ctx.results.create_vm;
    db.prepare(`UPDATE vms SET status = 'running', provisioning_stage = 'ready', updated_at = ? WHERE id = ?`)
      .run(now(), vm.id);
    logActivity({ user_id: user.id, vm_id: vm.id, event: `${task.type}:ready`, details: { task_id: task.id } });
  } else {
    // Ensure no VM row is left in a half-provisioned state pointing at freed resources.
    const vm = result.ctx.results.create_vm;
    if (vm) {
      db.prepare(`UPDATE vms SET status = 'error', provisioning_stage = 'failed', updated_at = ? WHERE id = ?`)
        .run(now(), vm.id);
    }
    logActivity({ user_id: user.id, vm_id: vm ? vm.id : null, event: `${task.type}:failed`, details: { task_id: task.id, error: result.error.message } });
  }

  return result;
}

module.exports = {
  provisionVm,
  selectNode,
  selectStoragePool,
  listOnlineNodes,
};
