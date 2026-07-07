import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('console html exposes the XD Cell favicon asset', async () => {
  const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');

  assert.match(
    html,
    /<link\s+rel="icon"\s+type="image\/svg\+xml"\s+href="\/favicon\.svg"\s*\/?>/,
  );

  const favicon = await readFile(new URL('../../public/favicon.svg', import.meta.url), 'utf8');
  assert.match(favicon, /<svg[^>]+viewBox="0 0 64 64"/);
  assert.match(favicon, />XD</);
});
