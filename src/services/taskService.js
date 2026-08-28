const { randomUUID } = require('crypto');
const { db } = require('../lib/db');
const logger = require('../lib/logger');

// In-process listeners for realtime task updates (wired to socket.io in app.js).
const listeners = new Set();
function onUpdate(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(task) {
  for (const fn of listeners) {
    try { fn(task); } catch (e) { logger.error('taskService listener error', e); }
  }
}

function now() { return new Date().toISOString(); }

function create({ type, vmId = null, nodeId = null, actorUserId = null, payload = null }) {
  const uuid = randomUUID();
  const ts = now();
  db.prepare(`
    INSERT INTO tasks (uuid, type, vm_id, node_id, actor_user_id, status, progress, payload, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
  `).run(uuid, type, vmId, nodeId, actorUserId, payload ? JSON.stringify(payload) : null, ts, ts);
  const task = getByUuid(uuid);
  emit(task);
  return task;
}

function getByUuid(uuid) {
  return db.prepare('SELECT * FROM tasks WHERE uuid = ?').get(uuid);
}

function getById(id) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

function log(taskId, message, level = 'info') {
  db.prepare('INSERT INTO task_logs (task_id, level, message, created_at) VALUES (?, ?, ?, ?)')
    .run(taskId, level, message, now());
  logger.info(`[task ${taskId}] ${message}`);
}

function update(taskId, fields) {
  const allowed = ['status', 'progress', 'stage', 'result', 'error', 'started_at', 'finished_at'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (fields[k] !== undefined) {
      sets.push(`${k} = ?`);
      vals.push(k === 'result' && fields[k] !== null && typeof fields[k] !== 'string'
        ? JSON.stringify(fields[k]) : fields[k]);
    }
  }
  if (!sets.length) return getById(taskId);
  sets.push('updated_at = ?');
  vals.push(now());
  vals.push(taskId);
  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  const task = getById(taskId);
  emit(task);
  return task;
}

function start(taskId, stage = null) {
  return update(taskId, { status: 'running', started_at: now(), stage, progress: 1 });
}

function progress(taskId, pct, stage = null) {
  const fields = { progress: Math.max(0, Math.min(100, pct)) };
  if (stage) fields.stage = stage;
  return update(taskId, fields);
}

function complete(taskId, result = null) {
  return update(taskId, { status: 'completed', progress: 100, result, finished_at: now(), stage: 'ready' });
}

function fail(taskId, error) {
  const message = error instanceof Error ? error.message : String(error);
  return update(taskId, { status: 'failed', error: message, finished_at: now(), stage: 'failed' });
}

function cancel(taskId) {
  return update(taskId, { status: 'cancelled', finished_at: now() });
}

function listLogs(taskId) {
  return db.prepare('SELECT * FROM task_logs WHERE task_id = ? ORDER BY id ASC').all(taskId);
}

function listRecent(limit = 50) {
  return db.prepare('SELECT * FROM tasks ORDER BY id DESC LIMIT ?').all(limit);
}

function listByVm(vmId) {
  return db.prepare('SELECT * FROM tasks WHERE vm_id = ? ORDER BY id DESC').all(vmId);
}

/**
 * Run a multi-step async task with automatic rollback on failure.
 * `steps` is an array of { name, run: async (ctx) => any, rollback?: async (ctx, stepResult) => void }.
 * Each step's return value is stored in ctx.results[name] and available to later steps/rollbacks.
 * On failure, already-completed steps' rollbacks run in reverse order before the task is marked failed.
 */
async function runWithRollback(task, steps) {
  const ctx = { task, results: {} };
  start(task.id, steps[0] ? steps[0].name : null);
  const completedSteps = [];
  const stepPct = Math.floor(100 / (steps.length + 1));

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    progress(task.id, stepPct * (i + 1), step.name);
    log(task.id, `Starting step: ${step.name}`);
    try {
      const result = await step.run(ctx);
      ctx.results[step.name] = result;
      completedSteps.push(step);
      log(task.id, `Completed step: ${step.name}`);
    } catch (err) {
      log(task.id, `Step failed: ${step.name} — ${err.message}`, 'error');
      // Roll back completed steps in reverse order.
      for (let j = completedSteps.length - 1; j >= 0; j--) {
        const rollbackStep = completedSteps[j];
        if (typeof rollbackStep.rollback === 'function') {
          try {
            log(task.id, `Rolling back: ${rollbackStep.name}`);
            await rollbackStep.rollback(ctx, ctx.results[rollbackStep.name]);
          } catch (rbErr) {
            log(task.id, `Rollback error for ${rollbackStep.name}: ${rbErr.message}`, 'error');
          }
        }
      }
      fail(task.id, err);
      return { ok: false, error: err, ctx };
    }
  }

  complete(task.id, ctx.results);
  return { ok: true, ctx };
}

module.exports = {
  create,
  getByUuid,
  getById,
  log,
  update,
  start,
  progress,
  complete,
  fail,
  cancel,
  listLogs,
  listRecent,
  listByVm,
  runWithRollback,
  onUpdate,
};
