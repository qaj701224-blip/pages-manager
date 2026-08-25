import assert from 'node:assert/strict';
import test from 'node:test';

import { logSiteMetadataEvent } from './site-metadata-diagnostics.js';

test('site metadata diagnostics emit only the bounded operational schema', () => {
  const lines = [];
  logSiteMetadataEvent(
    { logSiteMetadataEvent: (line) => lines.push(JSON.parse(line)) },
    {
      operation: 'update_slug',
      outcome: 'pending',
      environment: 'production',
      traceId: 'smt_1',
      siteId: 'site_1',
      slugRevision: 2,
      title: 'must not be logged',
      slug: 'must-not-be-logged',
    }
  );

  assert.deepEqual(lines, [
    {
      event: 'pages_site_metadata_event',
      operation: 'update_slug',
      outcome: 'pending',
      environment: 'production',
      traceId: 'smt_1',
      siteId: 'site_1',
      slugRevision: 2,
    },
  ]);
});

test('site metadata diagnostics isolate logger failures and sanitize dynamic values', () => {
  assert.doesNotThrow(() =>
    logSiteMetadataEvent(
      {
        logSiteMetadataEvent() {
          throw new Error('logger unavailable');
        },
      },
      {
        operation: 'unexpected',
        outcome: 'unexpected',
        environment: 'preview',
        traceId: 'bad trace',
        siteId: 'bad/site',
        errorCode: 'unsafe error',
      }
    )
  );
});
