import assert from 'node:assert/strict';
import test from 'node:test';

import { jsonResponse } from './index.js';

test('jsonResponse uses status 200 by default', () => {
  const response = jsonResponse({ status: 'ok' });

  assert.equal(response.status, 200);
});

test('jsonResponse uses a custom status', () => {
  const response = jsonResponse({ error: 'bad request' }, 400);

  assert.equal(response.status, 400);
});

test('jsonResponse returns application/json content type', () => {
  const response = jsonResponse({ status: 'ok' });

  assert.equal(response.headers.get('Content-Type'), 'application/json');
});

test('jsonResponse includes extra headers', () => {
  const response = jsonResponse({ status: 'ok' }, 200, {
    'Cache-Control': 'no-store',
  });

  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('jsonResponse prevents Content-Type override', () => {
  const response = jsonResponse({ status: 'ok' }, 200, {
    'Content-Type': 'text/plain',
  });

  assert.equal(response.headers.get('Content-Type'), 'application/json');
});
