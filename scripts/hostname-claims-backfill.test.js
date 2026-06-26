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

test('renders insert-if-hostname-absent SQL without overwriting existing hostname claims', () => {
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

test('backfills legacy v1 and v2 claims for the same owner on different hostnames', () => {
  const plan = buildHostnameClaimBackfillPlan({
    environment: 'production',
    v1Sites: [{ name: 'docs', scriptName: 'pages-docs', ownerId: 'site_docs', token: 'pages_owner@example.com' }],
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

  assert.equal(plan.conflicts.length, 0);
  assert.deepEqual(
    plan.claims.map((claim) => ({
      hostname: claim.hostname,
      normalizedSlug: claim.normalizedSlug,
      ownerSystem: claim.ownerSystem,
      ownerId: claim.ownerId,
      ownerRef: claim.ownerRef,
    })),
    [
      {
        hostname: 'docs.workers.xd.team',
        normalizedSlug: 'docs',
        ownerSystem: 'v1',
        ownerId: 'site_docs',
        ownerRef: 'pages-docs',
      },
      {
        hostname: 'docs.pages.xd.team',
        normalizedSlug: 'docs',
        ownerSystem: 'v2',
        ownerId: 'site_docs',
        ownerRef: 'route_docs',
      },
    ]
  );
  assert.deepEqual(
    plan.slugCoexistence.map((group) => ({
      normalizedSlug: group.normalizedSlug,
      candidates: group.candidates.map((candidate) => candidate.hostname),
    })),
    [
      {
        normalizedSlug: 'docs',
        candidates: ['docs.workers.xd.team', 'docs.pages.xd.team'],
      },
    ]
  );
});

test('backfills legacy v1 and v2 same-slug claims without requiring shared owner identity', () => {
  const plan = buildHostnameClaimBackfillPlan({
    environment: 'production',
    v1Sites: [{ name: 'docs', scriptName: 'pages-docs', token: 'pages_owner@example.com' }],
    v2Routes: [
      {
        siteId: 'site_docs',
        routeId: 'route_docs',
        slug: 'docs',
        hostname: 'docs.pages.xd.team',
        siteDeletedAt: null,
      },
    ],
  });

  assert.equal(plan.conflicts.length, 0);
  assert.equal(plan.claims.length, 2);
  assert.equal(plan.slugCoexistence.length, 1);
  assert.deepEqual(
    plan.slugCoexistence[0].candidates.map((candidate) => [candidate.hostname, candidate.ownerSystem, candidate.ownerId]),
    [
      ['docs.workers.xd.team', 'v1', 'v1:production:docs'],
      ['docs.pages.xd.team', 'v2', 'site_docs'],
    ]
  );
});

test('blocks same-system same-slug candidates on different hostnames', () => {
  const plan = buildHostnameClaimBackfillPlan({
    environment: 'production',
    v1Sites: [],
    v2Routes: [
      {
        siteId: 'site_docs_a',
        routeId: 'route_docs_a',
        slug: 'docs',
        hostname: 'docs.pages.xd.team',
        siteDeletedAt: null,
      },
      {
        siteId: 'site_docs_b',
        routeId: 'route_docs_b',
        slug: 'docs',
        hostname: 'docs.workers.xd.team',
        siteDeletedAt: null,
      },
    ],
  });

  assert.equal(plan.claims.length, 0);
  assert.equal(plan.slugCoexistence.length, 0);
  assert.equal(plan.conflicts.length, 2);
  assert.deepEqual(new Set(plan.conflicts.map((conflict) => conflict.reason)), new Set(['slug_duplicate']));
});

test('cli writes coexisting slug claims and reports them without blocking apply', async () => {
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
    const slugCoexistence = JSON.parse(await readFile(join(outPath, 'slug-coexistence.json'), 'utf8'));
    const conflictsSql = await readFile(join(outPath, 'conflicts.sql'), 'utf8');
    const claimsSql = await readFile(join(outPath, 'claims.sql'), 'utf8');

    assert.equal(code, 0);
    assert.equal(summary.claims, 2);
    assert.equal(summary.conflicts, 0);
    assert.equal(summary.slugCoexistence, 1);
    assert.deepEqual(slugCoexistence, [
      {
        environment: 'production',
        normalizedSlug: 'docs',
        candidates: [
          {
            hostname: 'docs.workers.xd.team',
            ownerSystem: 'v1',
            ownerId: 'v1:production:docs',
            ownerRef: 'pages-docs',
          },
          {
            hostname: 'docs.pages.xd.team',
            ownerSystem: 'v2',
            ownerId: 'site_docs',
            ownerRef: 'route_docs',
          },
        ],
      },
    ]);
    assert.match(stdout.join(''), /claims=2 conflicts=0 slugCoexistence=1/);
    assert.match(conflictsSql, /No hostname claim conflicts observed/);
    assert.match(claimsSql, /docs\.workers\.xd\.team/);
    assert.match(claimsSql, /docs\.pages\.xd\.team/);
    assert.doesNotMatch(`${claimsSql}\n${conflictsSql}`, /pages_owner@example\.com/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cli still fails closed when multiple owners claim the same hostname', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hostname-claims-'));
  try {
    const v1Path = join(dir, 'v1.json');
    const v2Path = join(dir, 'v2.json');
    const outPath = join(dir, 'out');
    await writeFile(v1Path, JSON.stringify([{ name: 'docs', scriptName: 'pages-docs', token: 'pages_owner@example.com' }]));
    await writeFile(
      v2Path,
      JSON.stringify([{ siteId: 'site_docs', routeId: 'route_docs', slug: 'docs', hostname: 'docs.workers.xd.team' }])
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
    assert.match(conflictsSql, /hostname_duplicate/);
    assert.doesNotMatch(`${claimsSql}\n${conflictsSql}`, /pages_owner@example\.com/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
