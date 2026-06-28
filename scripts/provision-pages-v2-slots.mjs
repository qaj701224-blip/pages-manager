#!/usr/bin/env node
import { appendFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const SUPPORTED_ENVIRONMENTS = new Set(['production', 'staging']);
const SUPPORTED_PHASES = new Set(['plan', 'prepare', 'activate', 'cleanup-plan', 'cleanup']);
const DEFAULT_CF_API_BASE_URL = 'https://api.cloudflare.com/client/v4';
const PLACEHOLDER_WORKER_MODULE = `export default {
  fetch() {
    return new Response('XD Cell slot is not assigned.', { status: 404 });
  },
};`;

export function renderSlotWorkerName(environment, slotNumber) {
  const number = formatSlotNumber(slotNumber);
  return environment === 'staging' ? `pages-v2-staging-slot-${number}` : `pages-v2-production-slot-${number}`;
}

export function renderSlotBindingName(slotNumber) {
  return `SITE_SLOT_${formatSlotNumber(slotNumber)}`;
}

export function buildSlotRecord({ environment, slotNumber, status = 'available_pending_router', now = new Date().toISOString() }) {
  const number = Number(slotNumber);
  return {
    id: `slot_${environment}_${formatSlotNumber(number)}`,
    environment,
    slotNumber: number,
    workerName: renderSlotWorkerName(environment, number),
    bindingName: renderSlotBindingName(number),
    status,
    assignedSiteId: null,
    assignedRouteId: null,
    assignedVersionId: null,
    assignedAt: null,
    lastDeployedVersionId: null,
    lastSeenAt: null,
    healthStatus: 'unknown',
    notes: 'created by pages v2 slot provisioner',
    createdAt: now,
    updatedAt: now,
  };
}

export function planNormalWorkerSlotProvisioning(slots, config) {
  const environmentSlots = slots
    .filter((slot) => slot.environment === config.environment)
    .map(normalizeSlot)
    .sort((left, right) => left.slotNumber - right.slotNumber);
  const availableCount = environmentSlots.filter((slot) => slot.status === 'available').length;
  const previousBindingCount = environmentSlots.reduce((max, slot) => Math.max(max, slot.slotNumber), 0);

  if (availableCount >= config.minAvailable) {
    return {
      availableCount,
      previousBindingCount,
      bindingCount: previousBindingCount,
      createSlotNumbers: [],
    };
  }

  if (previousBindingCount >= config.maxTotal) {
    throw new Error('SLOT_CAPACITY_EXHAUSTED');
  }

  const remainingCapacity = config.maxTotal - previousBindingCount;
  const createCount = Math.min(config.expandBy, remainingCapacity);
  const createSlotNumbers = Array.from({ length: createCount }, (_, index) => previousBindingCount + index + 1);

  return {
    availableCount,
    previousBindingCount,
    bindingCount: previousBindingCount + createCount,
    createSlotNumbers,
  };
}

export function planNormalWorkerSlotCleanup({ slots, activeRoutes = [], config, now = new Date().toISOString() }) {
  const activeSlotIds = new Set(activeRoutes.map((route) => route.slotId || route.slot_id).filter(Boolean));
  const activeVersionIds = new Set(activeRoutes.map((route) => route.activeVersionId || route.active_version_id).filter(Boolean));
  const cutoffMs = Date.parse(now) - config.cleanupRetentionSeconds * 1000;
  if (!Number.isFinite(cutoffMs)) throw new Error('PAGES_NORMAL_WORKER_SLOT_CLEANUP_NOW_INVALID');

  const cleanupSlots = [];
  const retainedSlots = [];
  for (const slot of slots.filter((candidate) => candidate.environment === config.environment).map(normalizeSlot)) {
    if (slot.status !== 'assigned' && slot.status !== 'cleanup_pending') continue;
    if (activeSlotIds.has(slot.id) || activeVersionIds.has(slot.assignedVersionId)) {
      retainedSlots.push({ ...slot, reason: 'active' });
      continue;
    }
    if (!slot.assignedVersionId) {
      retainedSlots.push({ ...slot, reason: 'missing_version' });
      continue;
    }
    if (slot.status === 'cleanup_pending') {
      cleanupSlots.push(slot);
      continue;
    }
    const assignedAtMs = Date.parse(slot.assignedAt || '');
    if (!Number.isFinite(assignedAtMs)) {
      retainedSlots.push({ ...slot, reason: 'missing_assigned_at' });
      continue;
    }
    if (assignedAtMs > cutoffMs) {
      retainedSlots.push({ ...slot, reason: 'retention_window' });
      continue;
    }
    cleanupSlots.push(slot);
  }
  return {
    cleanupRetentionSeconds: config.cleanupRetentionSeconds,
    cleanupSlots,
    retainedSlots,
  };
}

export async function cleanupNormalWorkerSlots({ config, d1, cloudflare, now = new Date().toISOString(), dryRun = false }) {
  const slots = await d1.listWorkerSlots(config.environment);
  const activeRoutes = typeof d1.listActiveSlotReferences === 'function'
    ? await d1.listActiveSlotReferences(config.environment)
    : [];
  const plan = planNormalWorkerSlotCleanup({ slots, activeRoutes, config, now });
  if (dryRun) {
    return cleanupResult({ phase: 'cleanup-plan', dryRun: true, plan });
  }

  const cleanedSlotIds = [];
  const failedSlotIds = [];
  const skippedSlotIds = [];
  for (const slot of plan.cleanupSlots) {
    const pending =
      slot.status === 'cleanup_pending'
        ? slot
        : await d1.markWorkerSlotCleanupPending({ ...slot, environment: config.environment, cutoff: cutoffIso(now, config) });
    if (!pending) {
      skippedSlotIds.push(slot.id);
      continue;
    }
    try {
      await cloudflare.putWorker({ workerName: pending.workerName, environment: config.environment });
      const released = await d1.releaseCleanupWorkerSlot({ ...pending, environment: config.environment });
      if (!released || released.status !== 'available') {
        failedSlotIds.push(slot.id);
        continue;
      }
      cleanedSlotIds.push(slot.id);
    } catch {
      failedSlotIds.push(slot.id);
    }
  }
  return cleanupResult({ phase: 'cleanup', dryRun: false, plan, cleanedSlotIds, failedSlotIds, skippedSlotIds });
}

export async function provisionNormalWorkerSlots({ phase, config, d1, cloudflare, env = process.env }) {
  if (phase === 'cleanup-plan' || phase === 'cleanup') {
    return cleanupNormalWorkerSlots({ config, d1, cloudflare, dryRun: phase === 'cleanup-plan' });
  }

  if (phase === 'plan') {
    const slots = await d1.listWorkerSlots(config.environment);
    if (config.executionMode && config.executionMode !== 'normal-worker-slot') {
      const bindingCount = maxSlotNumber(slots, config.environment);
      return {
        phase,
        dryRun: true,
        availableCount: slots.filter((slot) => slot.environment === config.environment && slot.status === 'available').length,
        previousBindingCount: bindingCount,
        bindingCount,
        createSlotNumbers: [],
      };
    }
    return { phase, dryRun: true, ...planNormalWorkerSlotProvisioning(slots, config) };
  }

  if (phase === 'activate') {
    if ((config.bindingCount === undefined || config.bindingCount === '') && config.executionMode !== 'normal-worker-slot') {
      return { phase, bindingCount: 0, activatedCount: 0 };
    }
    const bindingCount = assertPositiveInteger(config.bindingCount, 'PAGES_NORMAL_WORKER_SLOT_BINDING_COUNT');
    const activatedCount = await d1.activatePendingWorkerSlots({
      environment: config.environment,
      maxSlotNumber: bindingCount,
    });
    return { phase, bindingCount, activatedCount };
  }

  const slots = await d1.listWorkerSlots(config.environment);
  if (config.executionMode && config.executionMode !== 'normal-worker-slot') {
    const bindingCount = maxSlotNumber(slots, config.environment);
    await writeGithubEnv(env, {
      PAGES_NORMAL_WORKER_SLOT_BINDING_COUNT: bindingCount ? String(bindingCount) : '',
    });
    return {
      phase,
      availableCount: slots.filter((slot) => slot.environment === config.environment && slot.status === 'available').length,
      previousBindingCount: bindingCount,
      bindingCount,
      createSlotNumbers: [],
    };
  }
  const plan = planNormalWorkerSlotProvisioning(slots, config);
  const now = new Date().toISOString();

  for (const slotNumber of plan.createSlotNumbers) {
    const slot = buildSlotRecord({ environment: config.environment, slotNumber, now });
    await cloudflare.putWorker({ workerName: slot.workerName, environment: config.environment });
    await d1.insertPendingWorkerSlot(slot);
  }

  await writeGithubEnv(env, {
    PAGES_NORMAL_WORKER_SLOT_BINDING_COUNT: String(plan.bindingCount),
  });

  return { phase, ...plan };
}

export function parseSlotCapacityConfig(templateText, environment) {
  const executionMode = readTemplateVar(templateText, 'PAGES_EXECUTION_MODE');
  return {
    environment,
    executionMode,
    minAvailable: assertPositiveInteger(
      readTemplateVar(templateText, 'PAGES_NORMAL_WORKER_SLOT_MIN_AVAILABLE'),
      'PAGES_NORMAL_WORKER_SLOT_MIN_AVAILABLE'
    ),
    expandBy: assertPositiveInteger(
      readTemplateVar(templateText, 'PAGES_NORMAL_WORKER_SLOT_EXPAND_BY'),
      'PAGES_NORMAL_WORKER_SLOT_EXPAND_BY'
    ),
    maxTotal: assertPositiveInteger(
      readTemplateVar(templateText, 'PAGES_NORMAL_WORKER_SLOT_MAX_TOTAL'),
      'PAGES_NORMAL_WORKER_SLOT_MAX_TOTAL'
    ),
    cleanupRetentionSeconds: assertNonNegativeInteger(
      readTemplateVar(templateText, 'PAGES_NORMAL_WORKER_SLOT_CLEANUP_RETENTION_SECONDS'),
      'PAGES_NORMAL_WORKER_SLOT_CLEANUP_RETENTION_SECONDS'
    ),
  };
}

class WranglerD1Client {
  constructor({ repoRoot, databaseName, env = process.env }) {
    this.repoRoot = repoRoot;
    this.databaseName = databaseName;
    this.env = env;
  }

  async listWorkerSlots(environment) {
    const results = await this.execute(
      `SELECT * FROM worker_slots WHERE environment = ${sqlString(environment)} ORDER BY slot_number ASC`
    );
    return results.map(mapSlotRow);
  }

  async listActiveSlotReferences(environment) {
    return this.execute(
      `SELECT slot_id, active_version_id
        FROM site_routes
        WHERE environment = ${sqlString(environment)}
          AND route_status = 'active'
          AND (slot_id IS NOT NULL OR active_version_id IS NOT NULL)`
    );
  }

  async insertPendingWorkerSlot(slot) {
    await this.execute(
      `INSERT OR IGNORE INTO worker_slots (
        id, environment, slot_number, worker_name, binding_name, status,
        assigned_site_id, assigned_route_id, assigned_version_id, assigned_at,
        last_deployed_version_id, last_seen_at, health_status, notes,
        created_at, updated_at
      ) VALUES (
        ${sqlString(slot.id)}, ${sqlString(slot.environment)}, ${slot.slotNumber},
        ${sqlString(slot.workerName)}, ${sqlString(slot.bindingName)}, ${sqlString(slot.status)},
        NULL, NULL, NULL, NULL, NULL, NULL, ${sqlString(slot.healthStatus)}, ${sqlString(slot.notes)},
        ${sqlString(slot.createdAt)}, ${sqlString(slot.updatedAt)}
      )`
    );
    return slot;
  }

  async activatePendingWorkerSlots({ environment, maxSlotNumber }) {
    await this.execute(
      `UPDATE worker_slots
        SET status = 'available', updated_at = ${sqlString(new Date().toISOString())}
        WHERE environment = ${sqlString(environment)}
          AND status = 'available_pending_router'
          AND slot_number <= ${Number(maxSlotNumber)}`
    );
    const rows = await this.execute(
      `SELECT COUNT(*) AS count
        FROM worker_slots
        WHERE environment = ${sqlString(environment)}
          AND status = 'available'
          AND slot_number <= ${Number(maxSlotNumber)}`
    );
    return Number(rows[0]?.count || 0);
  }

  async markWorkerSlotCleanupPending(slot) {
    await this.execute(
      `UPDATE worker_slots
        SET status = 'cleanup_pending',
          updated_at = ${sqlString(new Date().toISOString())},
          notes = 'cleanup pending by pages v2 slot cleanup'
        WHERE id = ${sqlString(slot.id)}
          AND environment = ${sqlString(slot.environment)}
          AND status = 'assigned'
          AND assigned_version_id = ${sqlString(slot.assignedVersionId)}
          AND assigned_at <= ${sqlString(slot.cutoff)}
          AND NOT EXISTS (
            SELECT 1 FROM site_routes
            WHERE site_routes.environment = worker_slots.environment
              AND site_routes.route_status = 'active'
              AND (
                site_routes.slot_id = worker_slots.id
                OR site_routes.active_version_id = worker_slots.assigned_version_id
              )
          )`
    );
    return this.getCleanupPendingSlot(slot);
  }

  async releaseCleanupWorkerSlot(slot) {
    await this.execute(
      `UPDATE worker_slots
        SET status = 'available',
          assigned_site_id = NULL,
          assigned_route_id = NULL,
          assigned_version_id = NULL,
          assigned_at = NULL,
          last_deployed_version_id = COALESCE(last_deployed_version_id, ${sqlString(slot.assignedVersionId)}),
          updated_at = ${sqlString(new Date().toISOString())},
          notes = 'cleaned by pages v2 slot cleanup'
        WHERE id = ${sqlString(slot.id)}
          AND environment = ${sqlString(slot.environment)}
          AND status = 'cleanup_pending'
          AND NOT EXISTS (
            SELECT 1 FROM site_routes
            WHERE site_routes.environment = worker_slots.environment
              AND site_routes.route_status = 'active'
              AND (
                site_routes.slot_id = worker_slots.id
                OR site_routes.active_version_id = ${sqlString(slot.assignedVersionId)}
              )
          )`
    );
    const rows = await this.execute(
      `SELECT * FROM worker_slots
        WHERE id = ${sqlString(slot.id)}
          AND environment = ${sqlString(slot.environment)}
        LIMIT 1`
    );
    return rows[0] ? mapSlotRow(rows[0]) : null;
  }

  async getCleanupPendingSlot(slot) {
    const rows = await this.execute(
      `SELECT * FROM worker_slots
        WHERE id = ${sqlString(slot.id)}
          AND environment = ${sqlString(slot.environment)}
          AND status = 'cleanup_pending'
        LIMIT 1`
    );
    return rows[0] ? mapSlotRow(rows[0]) : null;
  }

  async execute(command) {
    const result = spawnSync(
      'pnpm',
      ['--dir', 'apps/pages-api', 'exec', 'wrangler', 'd1', 'execute', this.databaseName, '--remote', '--json', '--command', command],
      {
        cwd: this.repoRoot,
        env: this.env,
        encoding: 'utf8',
      }
    );
    if (result.status !== 0) {
      throw new Error(`D1_EXECUTE_FAILED: ${result.stderr || result.stdout}`);
    }
    return extractWranglerResults(result.stdout);
  }
}

export class CloudflareWorkersClient {
  constructor({ accountId, apiToken, fetchImpl = globalThis.fetch, apiBaseUrl = DEFAULT_CF_API_BASE_URL }) {
    this.accountId = readRequired(accountId, 'CLOUDFLARE_ACCOUNT_ID');
    this.apiToken = readRequired(apiToken, 'CLOUDFLARE_API_TOKEN');
    this.fetch = fetchImpl;
    this.apiBaseUrl = normalizeApiBase(apiBaseUrl);
  }

  async putWorker({ workerName, environment }) {
    const metadata = {
      main_module: 'worker.mjs',
      compatibility_date: '2026-06-15',
      tags: ['pages-v2', environment, 'normal-worker-slot', 'placeholder'],
    };
    const form = new FormData();
    form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.set('worker.mjs', new Blob([PLACEHOLDER_WORKER_MODULE], { type: 'application/javascript+module' }), 'worker.mjs');

    const response = await this.fetch(
      `${this.apiBaseUrl}/accounts/${encodeURIComponent(this.accountId)}/workers/scripts/${encodeURIComponent(workerName)}`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${this.apiToken}` },
        body: form,
      }
    );
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.success === false) {
      throw new Error(`WORKER_SLOT_CREATE_FAILED: ${workerName}`);
    }
    await this.disableSubdomain(workerName);
    return payload?.result || payload;
  }

  async disableSubdomain(workerName) {
    const response = await this.fetch(
      `${this.apiBaseUrl}/accounts/${encodeURIComponent(this.accountId)}/workers/services/${encodeURIComponent(workerName)}/environments/production/subdomain`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ enabled: false }),
      }
    );
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.success === false) {
      throw new Error(`WORKER_SLOT_SUBDOMAIN_DISABLE_FAILED: ${workerName}`);
    }
    return payload?.result || payload;
  }
}

async function main() {
  const [environment, phase] = process.argv.slice(2);
  if (!SUPPORTED_ENVIRONMENTS.has(environment) || !SUPPORTED_PHASES.has(phase)) {
    usage();
    process.exitCode = 2;
    return;
  }

  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const template = await readFile(join(repoRoot, 'apps/pages-router', `wrangler.${environment}.template.toml`), 'utf8');
  const config = parseSlotCapacityConfig(template, environment);
  if (phase === 'activate') {
    config.bindingCount = process.env.PAGES_NORMAL_WORKER_SLOT_BINDING_COUNT;
  }

  const pagesApiTemplate = await readFile(join(repoRoot, 'apps/pages-api', `wrangler.${environment}.template.toml`), 'utf8');
  const d1 = new WranglerD1Client({
    repoRoot,
    databaseName: readTomlValue(pagesApiTemplate, 'database_name'),
    env: process.env,
  });
  const cloudflare =
    phase === 'plan' || phase === 'cleanup-plan'
      ? null
      : new CloudflareWorkersClient({
          accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
          apiToken: process.env.CLOUDFLARE_API_TOKEN,
        });
  const result = await provisionNormalWorkerSlots({ phase, config, d1, cloudflare });
  console.log(JSON.stringify(result, null, 2));
}

function normalizeSlot(slot) {
  return {
    ...slot,
    slotNumber: Number(slot.slotNumber ?? slot.slot_number),
    environment: slot.environment,
    status: slot.status,
    workerName: slot.workerName ?? slot.worker_name,
    bindingName: slot.bindingName ?? slot.binding_name,
    assignedSiteId: slot.assignedSiteId ?? slot.assigned_site_id ?? null,
    assignedRouteId: slot.assignedRouteId ?? slot.assigned_route_id ?? null,
    assignedVersionId: slot.assignedVersionId ?? slot.assigned_version_id ?? null,
    assignedAt: slot.assignedAt ?? slot.assigned_at ?? null,
    lastDeployedVersionId: slot.lastDeployedVersionId ?? slot.last_deployed_version_id ?? null,
  };
}

function mapSlotRow(row) {
  return normalizeSlot(row);
}

function maxSlotNumber(slots, environment) {
  return slots
    .filter((slot) => slot.environment === environment)
    .reduce((max, slot) => Math.max(max, Number(slot.slotNumber ?? slot.slot_number ?? 0)), 0);
}

function formatSlotNumber(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 999) throw new Error('SLOT_NUMBER_INVALID');
  return String(parsed).padStart(3, '0');
}

function assertPositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function assertNonNegativeInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function readTemplateVar(templateText, name) {
  return readTomlValue(templateText, name);
}

function readTomlValue(templateText, name) {
  const match = templateText.match(new RegExp(`^${name} = "([^"]+)"$`, 'm'));
  if (!match) throw new Error(`${name} is required`);
  return match[1];
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function cutoffIso(now, config) {
  const cutoffMs = Date.parse(now) - config.cleanupRetentionSeconds * 1000;
  if (!Number.isFinite(cutoffMs)) throw new Error('PAGES_NORMAL_WORKER_SLOT_CLEANUP_NOW_INVALID');
  return new Date(cutoffMs).toISOString();
}

function cleanupResult({
  phase,
  dryRun,
  plan,
  cleanedSlotIds = [],
  failedSlotIds = [],
  skippedSlotIds = [],
}) {
  return {
    phase,
    dryRun,
    cleanupRetentionSeconds: plan.cleanupRetentionSeconds,
    cleanupSlotIds: plan.cleanupSlots.map((slot) => slot.id),
    retainedSlots: plan.retainedSlots.map((slot) => ({ id: slot.id, reason: slot.reason })),
    cleanedSlotIds,
    failedSlotIds,
    skippedSlotIds,
  };
}

function extractWranglerResults(stdout) {
  const text = stdout.trim();
  if (!text) return [];
  const payload = JSON.parse(text);
  const results = [];
  collectResults(payload, results);
  return results;
}

function collectResults(value, results) {
  if (Array.isArray(value)) {
    for (const item of value) collectResults(item, results);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value.results)) {
    results.push(...value.results);
    return;
  }
  if (value.result) collectResults(value.result, results);
}

async function writeGithubEnv(env, values) {
  if (!env.GITHUB_ENV) return;
  const lines = Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  await appendFile(env.GITHUB_ENV, `${lines}\n`);
}

function normalizeApiBase(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/client/v4' || url.search || url.hash) {
    throw new Error('CF_API_BASE_URL is invalid');
  }
  return url.toString().replace(/\/$/, '');
}

function readRequired(value, name) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function usage() {
  console.error('Usage: node scripts/provision-pages-v2-slots.mjs <production|staging> <plan|prepare|activate|cleanup-plan|cleanup>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`provision-pages-v2-slots: ${error.message}`);
    process.exitCode = 1;
  });
}
