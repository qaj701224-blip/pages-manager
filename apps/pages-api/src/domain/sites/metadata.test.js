import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeSiteMetadataPatch } from './metadata.js';

test('normalizes title and slug independently', () => {
  assert.deepEqual(
    normalizeSiteMetadataPatch({ title: '  Cafe\u0301 文档  ', slug: '  Product-Docs  ' }, { environment: 'production' }),
    { title: 'Café 文档', slug: 'product-docs' }
  );
  assert.deepEqual(normalizeSiteMetadataPatch({ title: null }, { environment: 'production' }), { title: null });
});

test('rejects invalid metadata patch shapes', () => {
  for (const patch of [null, [], {}, { unknown: true }, { title: 'Docs', unknown: true }]) {
    assert.throws(
      () => normalizeSiteMetadataPatch(patch, { environment: 'production' }),
      (error) => error.code === 'SITE_METADATA_INVALID'
    );
  }
});

test('rejects invalid titles before trimming control characters', () => {
  const invalidTitles = [
    '',
    '   ',
    '\ntrimmed newline',
    'line\nbreak',
    'line\u0085break',
    'line\u2028break',
    'line\u2029break',
    `x${'a'.repeat(80)}`,
    42,
  ];
  for (const title of invalidTitles) {
    assert.throws(
      () => normalizeSiteMetadataPatch({ title }, { environment: 'production' }),
      (error) => error.code === 'SITE_TITLE_INVALID'
    );
  }
  assert.equal(normalizeSiteMetadataPatch({ title: '😀'.repeat(80) }, { environment: 'production' }).title, '😀'.repeat(80));
});

test('returns stable slug validation errors', () => {
  assert.throws(
    () => normalizeSiteMetadataPatch({ slug: 'x' }, { environment: 'production' }),
    (error) => error.code === 'SITE_SLUG_INVALID'
  );
  assert.throws(
    () => normalizeSiteMetadataPatch({ slug: 'docs' }, { environment: 'production' }),
    (error) => error.code === 'SITE_SLUG_RESERVED'
  );
});
