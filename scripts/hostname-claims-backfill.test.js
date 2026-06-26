import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildHostnameClaimBackfillPlan,
  renderHostnameClaimBackfillSql,
  runHostnameClaimBackfillCli,
} from './hostname-claims-backfill.mjs';

test('builds hostname claims from v1 sites and v2 undeleted routes without leaking v1 tokens', () => {
  const plan = buildHostnameClaimBackfillPlan({
    environment: 'production',
    v1Sites: [
      {
        name: 'legacy',
        scriptName: 'pages-legacy',
        token: 'pages_owner@example.com',
        createdAt: '2026-05-14T02:43:13.845Z',
      },
    ],
    v2Routes: [
      {
        siteId: 'site_docs',
        routeId: 'route_docs',
        slug: 'docs',
        hostname: 'docs.pages.xd.team',
        routeStatus: 'disabled',
        siteDeletedAt: null,
      },
      {
        siteId: 'site_old',
        routeId: 'route_old',
        slug: 'old',
        hostname: 'old.pages.xd.team',
        siteDeletedAt: '2026-06-01T00:00:00.000Z',
      },
    ],
  });

  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(
    plan.claims.map((claim) => ({
      hostname: claim.hostname,
      normalizedSlug: claim.normalizedSlug,
      hostnameFamily: claim.hostnameFamily,
      ownerSystem: claim.ownerSystem,
      ownerId: claim.ownerId,
      ownerRef: claim.ownerRef,
      source: claim.source,
    })),
    [
      {
        hostname: 'legacy.workers.xd.team',
        normalizedSlug: 'legacy',
        hostnameFamily: 'workers',
        ownerSystem: 'v1',
        ownerId: 'v1:production:legacy',
        ownerRef: 'pages-legacy',
        source: 'backfill_v1_sites',
      },
      {
        hostname: 'docs.pages.xd.team',
        normalizedSlug: 'docs',
        hostnameFamily: 'pages',
        ownerSystem: 'v2',
        ownerId: 'site_docs',
        ownerRef: 'route_docs',
        source: 'backfill_v2_routes',
      },
    ]
  );
  assert.doesNotMatch(JSON.stringify(plan), /pages_owner@example\.com/);
});

test('renders insert-if-hostname-absent SQL without hiding live slug conflicts', () => {
  const plan = buildHostnameClaimBackfillPlan({
    environment: 'production',
    v1Sites: [{ name: 'legacy', scriptName: "pages-legacy's", token: 'pages_owner@example.com' }],
    v2Routes: [],
  });

  const { claimsSql, conflictsSql } = renderHostnameClaimBackfillSql(plan, { observedAt: '2026-06-15T00:00:00.000Z' });

  assert.match(claimsSql, /INSERT INTO hostname_claims/);
  assert.match(claimsSql, /WHERE NOT EXISTS \(/);
  assert.doesNotMatch(claimsSql, /INSERT OR IGNORE INTO hostname_claims/);
  assert.match(claimsSql, /pages-legacy''s/);
  assert.doesNotMatch(claimsSql, /pages_owner@example\.com/);
  assert.match(conflictsSql, /No hostname claim conflicts observed/);
});

test('blocks automatic claims when v1 and v2 share a normalized slug', () => {
  const plan = buildHostnameClaimBackfillPlan({
    environment: 'production',
    v1Sites: [{ name: 'docs', scriptName: 'pages-docs', token: 'pages_owner@example.com' }],
    v2Routes: [
      {
        siteId: 'site_docs',
        routeId: 'route_docs',
        slug: 'docs',
        hostname: 'docs.pages.xd.team',
        routeStatus: 'disabled',
        siteDeletedAt: null,
      },
    ],
  });

  assert.deepEqual(plan.claims, []);
  assert.deepEqual(
    plan.conflicts.map((conflict) => ({
      hostname: conflict.hostname,
      normalizedSlug: conflict.normalizedSlug,
      candidateSystem: conflict.candidateSystem,
      candidateOwnerId: conflict.candidateOwnerId,
      reason: conflict.reason,
    })),
    [
      {
        hostname: 'docs.workers.xd.team',
        normalizedSlug: 'docs',
        candidateSystem: 'v1',
        candidateOwnerId: 'v1:production:docs',
        reason: 'slug_duplicate',
      },
      {
        hostname: 'docs.pages.xd.team',
        normalizedSlug: 'docs',
        candidateSystem: 'v2',
        candidateOwnerId: 'site_docs',
        reason: 'slug_duplicate',
      },
    ]
  );
});

test('cli writes claim and conflict SQL, failing closed on conflicts by default', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hostname-claims-'));
  try {
    const v1Path = join(dir, 'v1.json');
    const v2Path = join(dir, 'v2.json');
    const outPath = join(dir, 'out');
    await writeFile(v1Path, JSON.stringify([{ name: 'docs', scriptName: 'pages-docs', token: 'pages_owner@example.com' }]));
    await writeFile(
      v2Path,
      JSON.stringify([{ siteId: 'site_docs', routeId: 'route_docs', slug: 'docs', hostname: 'docs.pages.xd.team' }])
    );

    const stdout = [];
    const code = await runHostnameClaimBackfillCli(
      ['--environment', 'production', '--v1-sites', v1Path, '--v2-routes', v2Path, '--out', outPath],
      { stdout: { write: (text) => stdout.push(text) } }
    );

    const summary = JSON.parse(await readFile(join(outPath, 'summary.json'), 'utf8'));
    const conflictsSql = await readFile(join(outPath, 'conflicts.sql'), 'utf8');
    const claimsSql = await readFile(join(outPath, 'claims.sql'), 'utf8');

    assert.equal(code, 1);
    assert.equal(summary.claims, 0);
    assert.equal(summary.conflicts, 2);
    assert.match(stdout.join(''), /conflicts=2/);
    assert.match(conflictsSql, /INSERT OR IGNORE INTO hostname_claim_conflicts/);
    assert.match(conflictsSql, /slug_duplicate/);
    assert.doesNotMatch(`${claimsSql}\n${conflictsSql}`, /pages_owner@example\.com/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
