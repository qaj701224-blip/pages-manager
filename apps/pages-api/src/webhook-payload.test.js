import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildStandardWebhookPayload,
  payloadHash,
  renderRestrictedTemplate,
  validateRestrictedTemplate,
} from './webhook-payload.js';

test('standard webhook payload keeps only public allowlisted fields', async () => {
  const payload = buildStandardWebhookPayload({
    id: 'evt_1',
    type: 'site.deployed',
    environment: 'production',
    occurredAt: '2026-07-01T00:00:00.000Z',
    actor: {
      type: 'user',
      userId: 'usr_1',
      email: 'owner@example.com',
      token: 'secret-token',
    },
    site: {
      id: 'site_1',
      slug: 'docs',
      hostname: 'docs.pages.xd.team',
      ownerType: 'team',
      ownerId: 'team_1',
      visibility: 'internal',
      status: 'active',
      providerResourceId: 'cf-worker-secret-id',
      routeId: 'route_1',
    },
    deployment: {
      id: 'dep_1',
      status: 'succeeded',
      source: 'cli',
      operation: 'publish',
      createdAt: '2026-07-01T00:00:00.000Z',
      completedAt: null,
      internalRouteId: 'route_1',
    },
    secret: 'top-secret',
  });

  assert.deepEqual(payload, {
    event: {
      id: 'evt_1',
      type: 'site.deployed',
      environment: 'production',
      occurredAt: '2026-07-01T00:00:00.000Z',
    },
    actor: {
      type: 'user',
      userId: 'usr_1',
      email: 'owner@example.com',
    },
    site: {
      id: 'site_1',
      slug: 'docs',
      hostname: 'docs.pages.xd.team',
      ownerType: 'team',
      ownerId: 'team_1',
      visibility: 'internal',
      status: 'active',
    },
    deployment: {
      id: 'dep_1',
      status: 'succeeded',
      source: 'cli',
      operation: 'publish',
      createdAt: '2026-07-01T00:00:00.000Z',
      completedAt: null,
    },
  });

  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /secret-token|top-secret|cf-worker-secret-id|route_1/);
  assert.match(await payloadHash(payload), /^sha256:[a-f0-9]{64}$/);
});

test('lifecycle payloads expose only safe failure and visibility-change fields', () => {
  const failed = buildStandardWebhookPayload({
    id: 'evt_failed',
    type: 'site.failed',
    environment: 'production',
    occurredAt: '2026-07-01T00:00:00.000Z',
    site: { id: 'site_1', slug: 'docs', ownerType: 'user' },
    deployment: {
      id: 'dep_1',
      status: 'failed',
      operation: 'deploy',
      failureStage: 'upload_worker',
      errorCode: 'DEPLOYMENT_UPLOAD_FAILED',
      errorMessage: 'raw provider failure',
      failureDiagnostics: { workerName: 'provider-worker' },
    },
    errorMessage: 'raw event failure',
  });
  assert.equal(failed.deployment.failureStage, 'upload_worker');
  assert.equal(failed.deployment.errorCode, 'DEPLOYMENT_UPLOAD_FAILED');
  assert.equal(failed.deployment.errorMessage, undefined);
  assert.equal(failed.deployment.failureDiagnostics, undefined);
  assert.equal(failed.site.status, undefined);

  const disabled = buildStandardWebhookPayload({
    id: 'evt_disabled',
    type: 'site.disabled',
    environment: 'production',
    occurredAt: '2026-07-01T00:00:00.000Z',
    actor: { type: 'user', userId: 'usr_1' },
    site: { id: 'site_1', slug: 'docs', ownerType: 'user', visibility: 'disabled' },
    change: { field: 'visibility', previousValue: 'org', currentValue: 'disabled', routeId: 'route_1' },
  });
  assert.deepEqual(disabled.change, {
    field: 'visibility',
    previousValue: 'org',
    currentValue: 'disabled',
  });
  assert.equal(disabled.change.routeId, undefined);

  const deleted = buildStandardWebhookPayload({
    id: 'evt_deleted',
    type: 'site.deleted',
    environment: 'production',
    occurredAt: '2026-07-01T00:00:00.000Z',
    actor: { type: 'user', userId: 'usr_1' },
    site: { id: 'site_1', slug: 'docs', ownerType: 'user', status: 'deleted', providerResourceId: 'provider-1' },
    cleanupTaskId: 'cleanup-1',
  });
  assert.equal(deleted.site.status, 'deleted');
  assert.equal(deleted.site.providerResourceId, undefined);
  assert.equal(deleted.cleanupTaskId, undefined);
});

test('restricted template renders Slack Incoming Webhook payloads', () => {
  const payload = buildStandardWebhookPayload({
    id: 'evt_1',
    type: 'site.deployed',
    environment: 'production',
    occurredAt: '2026-07-01T00:00:00.000Z',
    actor: { type: 'user', userId: 'usr_1', email: 'owner@example.com' },
    site: { id: 'site_1', slug: 'docs', hostname: 'docs.pages.xd.team' },
    deployment: { id: 'dep_1', status: 'succeeded' },
  });
  const template = {
    text: 'XD Cell: {{site.slug}} deployed by {{actor.email}}',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*{{site.slug}}* deployment {{deployment.status}}',
        },
      },
    ],
  };

  validateRestrictedTemplate(template);

  assert.deepEqual(renderRestrictedTemplate(template, payload), {
    text: 'XD Cell: docs deployed by owner@example.com',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*docs* deployment succeeded',
        },
      },
    ],
  });
});

test('restricted template rejects variables outside standard payload', () => {
  const payload = buildStandardWebhookPayload({
    id: 'evt_1',
    type: 'site.deployed',
    environment: 'production',
    site: { id: 'site_1', slug: 'docs' },
  });

  assert.throws(
    () => renderRestrictedTemplate({ text: '{{site.providerResourceId}}' }, payload),
    /WEBHOOK_TEMPLATE_VARIABLE_FORBIDDEN/
  );
});

test('restricted template treats missing values differently for string and typed slots', () => {
  const payload = buildStandardWebhookPayload({
    id: 'evt_1',
    type: 'site.deployed',
    environment: 'production',
    site: { id: 'site_1', slug: 'docs' },
    deployment: { id: 'dep_1', status: 'running', completedAt: null },
  });

  assert.deepEqual(renderRestrictedTemplate({ text: 'completed={{deployment.completedAt}}' }, payload), {
    text: 'completed=',
  });
  assert.throws(
    () => renderRestrictedTemplate({ completedAt: '{{deployment.completedAt}}' }, payload),
    /WEBHOOK_TEMPLATE_MISSING_VALUE/
  );
});
