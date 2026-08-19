import assert from 'node:assert/strict';
import test from 'node:test';

import { SUPPORTED_WEBHOOK_EVENTS, getWebhookEventCatalog, getWebhookTemplateVariablePaths } from './webhook-events.js';

test('webhook catalog has four real lifecycle events and disjoint variable partitions', () => {
  const catalog = getWebhookEventCatalog();
  assert.deepEqual(
    catalog.map((event) => event.type),
    ['site.deployed', 'site.failed', 'site.disabled', 'site.deleted']
  );
  assert.deepEqual(
    [...SUPPORTED_WEBHOOK_EVENTS],
    catalog.map((event) => event.type)
  );
  for (const event of catalog) {
    const required = new Set(event.requiredTemplateVariables);
    const optional = new Set(event.optionalTemplateVariables);
    assert.equal(
      [...required].some((path) => optional.has(path)),
      false,
      event.type
    );
    assert.deepEqual(new Set(event.templateVariables), new Set([...required, ...optional]), event.type);
  }
});

test('site.deployed keeps every existing allowlisted variable', () => {
  const paths = getWebhookTemplateVariablePaths();
  for (const path of [
    'event.id',
    'event.type',
    'event.environment',
    'event.occurredAt',
    'actor.type',
    'actor.userId',
    'actor.email',
    'actor.name',
    'site.id',
    'site.slug',
    'site.hostname',
    'site.ownerType',
    'site.ownerId',
    'site.visibility',
    'site.status',
    'team.id',
    'team.name',
    'team.teamType',
    'deployment.id',
    'deployment.status',
    'deployment.source',
    'deployment.operation',
    'deployment.createdAt',
    'deployment.completedAt',
  ])
    assert.equal(paths.has(path), true, path);
});
