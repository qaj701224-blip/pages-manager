import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function buildHostnameClaimBackfillPlan({ environment, v1Sites = [], v2Routes = [] }) {
  const claims = [];
  const candidatesByHostname = new Map();
  const candidatesBySlug = new Map();

  for (const site of v1Sites) {
    const name = normalizeSlug(site?.name);
    if (!name) continue;
    const hostname = environment === 'staging' ? `${name}-staging.workers.xd.team` : `${name}.workers.xd.team`;
    const candidate = {
      environment,
      hostname,
      normalizedSlug: name,
      hostnameFamily: 'workers',
      ownerSystem: 'v1',
      ownerId: normalizeOptionalString(site.ownerId) || `v1:${environment}:${name}`,
      ownerRef: normalizeOptionalString(site.scriptName) || null,
      source: 'backfill_v1_sites',
    };
    addCandidate(candidate, candidatesByHostname, candidatesBySlug);
  }

  for (const route of v2Routes) {
    if (route?.siteDeletedAt) continue;
    const hostname = normalizeHostname(route?.hostname);
    const normalizedSlug = normalizeSlug(route?.slug || slugFromHostname(hostname, environment));
    if (!hostname || !normalizedSlug) continue;
    const candidate = {
      environment,
      hostname,
      normalizedSlug,
      hostnameFamily: hostnameFamilyForHostname(hostname),
      ownerSystem: 'v2',
      ownerId: normalizeOptionalString(route.siteId),
      ownerRef: normalizeOptionalString(route.routeId) || null,
      source: 'backfill_v2_routes',
    };
    if (!candidate.ownerId) continue;
    addCandidate(candidate, candidatesByHostname, candidatesBySlug);
  }

  const conflicts = [];
  const blockedHostnames = new Set();
  const slugCoexistence = [];
  for (const [hostname, candidates] of candidatesByHostname.entries()) {
    if (hasMultipleOwners(candidates)) {
      blockedHostnames.add(hostname);
      for (const candidate of candidates) conflicts.push(conflictFromCandidate(candidate, 'hostname_duplicate'));
    }
  }
  for (const [slugKey, candidates] of candidatesBySlug.entries()) {
    const liveCandidates = candidates.filter((candidate) => !blockedHostnames.has(candidate.hostname));
    if (!hasMultipleOwners(liveCandidates)) continue;
    if (isAllowedLegacySlugCoexistence(liveCandidates)) {
      slugCoexistence.push(coexistenceFromCandidates(slugKey, liveCandidates));
      continue;
    }
    for (const candidate of liveCandidates) {
      blockedHostnames.add(candidate.hostname);
      conflicts.push(conflictFromCandidate(candidate, 'slug_duplicate'));
    }
  }

  for (const [hostname, candidates] of candidatesByHostname.entries()) {
    const candidate = candidates[0];
    if (blockedHostnames.has(hostname)) continue;
    claims.push(candidate);
  }

  return { claims, conflicts, slugCoexistence };
}

export function renderHostnameClaimBackfillSql(plan, { observedAt = new Date().toISOString() } = {}) {
  return {
    claimsSql:
      plan.claims.map((claim) => renderClaimInsert(claim, observedAt)).join('\n') ||
      '-- No hostname claims to backfill.',
    conflictsSql:
      plan.conflicts.map((conflict) => renderConflictInsert(conflict, observedAt)).join('\n') ||
      '-- No hostname claim conflicts observed.',
  };
}

export async function runHostnameClaimBackfillCli(argv = process.argv.slice(2), io = {}) {
  const { environment, v1SitesPath, v2RoutesPath, outputDir, allowConflicts } = parseArgs(argv);
  const [v1Sites, v2Routes] = await Promise.all([readJsonArray(v1SitesPath, 'v1-sites'), readJsonArray(v2RoutesPath, 'v2-routes')]);
  const plan = buildHostnameClaimBackfillPlan({ environment, v1Sites, v2Routes });
  const observedAt = new Date().toISOString();
  const sql = renderHostnameClaimBackfillSql(plan, { observedAt });
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(resolve(outputDir, 'claims.sql'), `${sql.claimsSql}\n`),
    writeFile(resolve(outputDir, 'conflicts.sql'), `${sql.conflictsSql}\n`),
    writeFile(resolve(outputDir, 'slug-coexistence.json'), `${JSON.stringify(plan.slugCoexistence, null, 2)}\n`),
    writeFile(
      resolve(outputDir, 'summary.json'),
      `${JSON.stringify(
        {
          environment,
          v1Sites: v1Sites.length,
          v2Routes: v2Routes.length,
          claims: plan.claims.length,
          conflicts: plan.conflicts.length,
          slugCoexistence: plan.slugCoexistence.length,
          observedAt,
        },
        null,
        2
      )}\n`
    ),
  ]);

  const summary =
    `hostname-claims-backfill ${environment}: claims=${plan.claims.length} ` +
    `conflicts=${plan.conflicts.length} slugCoexistence=${plan.slugCoexistence.length}`;
  if (io.stdout?.write) io.stdout.write(`${summary}\n`);
  else console.log(summary);
  if (plan.conflicts.length > 0 && !allowConflicts) return 1;
  return 0;
}

function addCandidate(candidate, candidatesByHostname, candidatesBySlug) {
  appendMap(candidatesByHostname, candidate.hostname, candidate);
  appendMap(candidatesBySlug, `${candidate.environment}:${candidate.normalizedSlug}`, candidate);
}

function appendMap(map, key, value) {
  const values = map.get(key) || [];
  values.push(value);
  map.set(key, values);
}

function hasMultipleOwners(candidates) {
  return new Set(candidates.map((candidate) => `${candidate.ownerSystem}:${candidate.ownerId}`)).size > 1;
}

function isAllowedLegacySlugCoexistence(candidates) {
  if (candidates.length !== 2) return false;
  const [first, second] = candidates;
  return (
    new Set(candidates.map((candidate) => candidate.ownerSystem)).size === 2 &&
    candidates.every((candidate) => ['v1', 'v2'].includes(candidate.ownerSystem)) &&
    new Set(candidates.map((candidate) => candidate.hostnameFamily)).size === 2 &&
    candidates.every((candidate) => ['workers', 'pages'].includes(candidate.hostnameFamily)) &&
    first.hostname !== second.hostname
  );
}

function conflictFromCandidate(candidate, reason) {
  return {
    environment: candidate.environment,
    hostname: candidate.hostname,
    normalizedSlug: candidate.normalizedSlug,
    candidateSystem: candidate.ownerSystem,
    candidateOwnerId: candidate.ownerId,
    candidateRef: candidate.ownerRef,
    candidateHostname: candidate.hostname,
    reason,
  };
}

function coexistenceFromCandidates(slugKey, candidates) {
  const [environment, normalizedSlug] = slugKey.split(':');
  return {
    environment,
    normalizedSlug,
    candidates: candidates.map((candidate) => ({
      hostname: candidate.hostname,
      ownerSystem: candidate.ownerSystem,
      ownerId: candidate.ownerId,
      ownerRef: candidate.ownerRef,
    })),
  };
}

function normalizeSlug(value) {
  return normalizeOptionalString(value).toLowerCase();
}

function normalizeHostname(value) {
  return normalizeOptionalString(value).toLowerCase();
}

function normalizeOptionalString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function hostnameFamilyForHostname(hostname) {
  if (hostname.endsWith('.workers.xd.team')) return 'workers';
  if (hostname.endsWith('.pages.xd.team')) return 'pages';
  return 'custom';
}

function slugFromHostname(hostname, environment) {
  if (!hostname) return '';
  for (const suffix of ['.workers.xd.team', '.pages.xd.team']) {
    if (!hostname.endsWith(suffix)) continue;
    const label = hostname.slice(0, -suffix.length);
    if (environment === 'staging' && label.endsWith('-staging')) return label.slice(0, -'-staging'.length);
    return label;
  }
  return '';
}

function renderClaimInsert(claim, observedAt) {
  const id = `claim_${claim.ownerRef || claim.ownerId}`;
  return `INSERT INTO hostname_claims (
  id, environment, hostname, normalized_slug, hostname_family, owner_system, owner_id,
  owner_ref, status, source, acquired_at, lease_expires_at, released_at, reuse_hold_until,
  release_reason, created_at, updated_at
) SELECT
  ${sqlString(id)}, ${sqlString(claim.environment)}, ${sqlString(claim.hostname)}, ${sqlString(claim.normalizedSlug)},
  ${sqlString(claim.hostnameFamily)}, ${sqlString(claim.ownerSystem)}, ${sqlString(claim.ownerId)},
  ${sqlString(claim.ownerRef)}, 'active', ${sqlString(claim.source)}, ${sqlString(observedAt)},
  NULL, NULL, NULL, NULL, ${sqlString(observedAt)}, ${sqlString(observedAt)}
WHERE NOT EXISTS (
  SELECT 1 FROM hostname_claims WHERE hostname = ${sqlString(claim.hostname)}
);`;
}

function renderConflictInsert(conflict, observedAt) {
  const id = `conflict_${conflict.reason}_${conflict.candidateSystem}_${conflict.candidateOwnerId}_${conflict.hostname}`;
  return `INSERT OR IGNORE INTO hostname_claim_conflicts (
  id, environment, hostname, normalized_slug, candidate_system, candidate_owner_id,
  candidate_ref, candidate_hostname, reason, observed_at, resolved_at, resolution
) VALUES (
  ${sqlString(id)}, ${sqlString(conflict.environment)}, ${sqlString(conflict.hostname)}, ${sqlString(conflict.normalizedSlug)},
  ${sqlString(conflict.candidateSystem)}, ${sqlString(conflict.candidateOwnerId)}, ${sqlString(conflict.candidateRef)},
  ${sqlString(conflict.candidateHostname)}, ${sqlString(conflict.reason)}, ${sqlString(observedAt)}, NULL, NULL
);`;
}

async function readJsonArray(path, label) {
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.results)) return parsed.results;
  if (Array.isArray(parsed?.items)) return parsed.items;
  if (parsed && typeof parsed === 'object') return Object.values(parsed);
  throw new Error(`${label} input must be a JSON array or object`);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--allow-conflicts') {
      options.allowConflicts = true;
      continue;
    }
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    options[key] = value;
    index += 1;
  }
  const environment = options.environment;
  if (environment !== 'production' && environment !== 'staging') {
    throw new Error('Usage: node scripts/hostname-claims-backfill.mjs --environment <production|staging> --v1-sites <json> --v2-routes <json> --out <dir> [--allow-conflicts]');
  }
  if (!options['v1-sites'] || !options['v2-routes'] || !options.out) {
    throw new Error('Usage: node scripts/hostname-claims-backfill.mjs --environment <production|staging> --v1-sites <json> --v2-routes <json> --out <dir> [--allow-conflicts]');
  }
  return {
    environment,
    v1SitesPath: options['v1-sites'],
    v2RoutesPath: options['v2-routes'],
    outputDir: options.out,
    allowConflicts: Boolean(options.allowConflicts),
  };
}

function sqlString(value) {
  if (value == null || value === '') return 'NULL';
  return `'${String(value).replaceAll("'", "''")}'`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runHostnameClaimBackfillCli().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error.message);
      process.exitCode = 2;
    }
  );
}
