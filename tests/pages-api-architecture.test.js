import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPS_ROOT = path.join(REPO_ROOT, 'apps');
const PAGES_API_SRC = path.join(APPS_ROOT, 'pages-api', 'src');
const KNOWN_CROSS_APP_IMPORTS = new Set([
  'apps/pages-auth/src/oauth-endpoints.js -> apps/pages-api/src/department-hydration.js',
  'apps/pages-auth/src/oauth-endpoints.js -> apps/pages-api/src/store.js',
]);

test('pages-api production imports follow the declared layer direction', () => {
  const violations = [];
  for (const source of productionJavaScriptFiles(PAGES_API_SRC)) {
    for (const specifier of moduleSpecifiers(readFileSync(source, 'utf8'))) {
      const target = resolveLocalModule(source, specifier);
      if (!target || !isInside(target, PAGES_API_SRC)) continue;
      const reason = pagesApiLayerViolation(source, target);
      if (reason) violations.push(`${relative(source)} -> ${relative(target)}: ${reason}`);
    }
  }

  assert.deepEqual(violations, []);
});

test('production cross-app source imports stay limited to the metadata migration exception', () => {
  const imports = new Set();
  for (const source of productionJavaScriptFiles(APPS_ROOT)) {
    for (const specifier of moduleSpecifiers(readFileSync(source, 'utf8'))) {
      const target = resolveLocalModule(source, specifier);
      if (!target || !isInside(target, APPS_ROOT)) continue;
      const sourceApp = appName(source);
      const targetApp = appName(target);
      if (sourceApp && targetApp && sourceApp !== targetApp) {
        imports.add(`${relative(source)} -> ${relative(target)}`);
      }
    }
  }

  assert.deepEqual([...imports].sort(), [...KNOWN_CROSS_APP_IMPORTS].sort());
});

test('layer classifier rejects reverse and cross-transport dependencies', () => {
  const file = (value) => path.join(PAGES_API_SRC, value);

  assert.match(pagesApiLayerViolation(file('domain/sites/site.js'), file('application/sites/create-site.js')), /domain/);
  assert.match(
    pagesApiLayerViolation(file('application/sites/create-site.js'), file('infrastructure/store/sites.js')),
    /application/
  );
  assert.match(pagesApiLayerViolation(file('infrastructure/store/sites.js'), file('transport/shared/http.js')), /infrastructure/);
  assert.match(pagesApiLayerViolation(file('transport/public/sites.js'), file('transport/console/sites.js')), /transport lane/);
  assert.equal(pagesApiLayerViolation(file('transport/public/sites.js'), file('application/sites/create-site.js')), null);
  assert.equal(pagesApiLayerViolation(file('application/sites/create-site.js'), file('domain/sites/site.js')), null);
  assert.equal(pagesApiLayerViolation(file('infrastructure/store/sites.js'), file('domain/sites/site.js')), null);
  assert.equal(pagesApiLayerViolation(file('transport/router.js'), file('transport/public/sites.js')), null);
  assert.equal(pagesApiLayerViolation(file('transport/public/sites.js'), file('transport/shared/http.js')), null);
});

function pagesApiLayerViolation(source, target) {
  const sourceLayer = layer(source);
  const targetLayer = layer(target);
  if (!sourceLayer || !targetLayer) return null;

  if (sourceLayer === 'domain' && ['application', 'transport', 'infrastructure'].includes(targetLayer)) {
    return `domain must not import ${targetLayer}`;
  }
  if (sourceLayer === 'application' && ['transport', 'infrastructure'].includes(targetLayer)) {
    return `application must not import ${targetLayer}`;
  }
  if (sourceLayer === 'infrastructure' && targetLayer === 'transport') {
    return 'infrastructure must not import transport';
  }
  if (sourceLayer === 'transport' && targetLayer === 'transport') {
    const sourceLane = transportLane(source);
    const targetLane = transportLane(target);
    if (sourceLane && targetLane && sourceLane !== targetLane && targetLane !== 'shared') {
      return `transport lane ${sourceLane} must not import ${targetLane}`;
    }
  }
  return null;
}

function layer(file) {
  const [value] = relativeToPagesApi(file).split('/');
  return ['transport', 'application', 'domain', 'infrastructure'].includes(value) ? value : null;
}

function transportLane(file) {
  const [root, lane] = relativeToPagesApi(file).split('/');
  return root === 'transport' && ['public', 'console', 'internal', 'shared'].includes(lane) ? lane : null;
}

function relativeToPagesApi(file) {
  return path.relative(PAGES_API_SRC, file).split(path.sep).join('/');
}

function productionJavaScriptFiles(root) {
  const files = [];
  for (const name of readdirSync(root)) {
    const file = path.join(root, name);
    const stat = statSync(file);
    if (stat.isDirectory()) files.push(...productionJavaScriptFiles(file));
    else if (name.endsWith('.js') && !name.endsWith('.test.js')) files.push(file);
  }
  return files;
}

function moduleSpecifiers(source) {
  const values = [];
  const patterns = [
    /\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) values.push(match[1]);
  }
  return values;
}

function resolveLocalModule(source, specifier) {
  if (!specifier.startsWith('.')) return null;
  const resolved = path.resolve(path.dirname(source), specifier);
  if (path.extname(resolved)) return resolved;
  return `${resolved}.js`;
}

function appName(file) {
  const parts = path.relative(APPS_ROOT, file).split(path.sep);
  return parts.length > 1 ? parts[0] : null;
}

function isInside(file, root) {
  const value = path.relative(root, file);
  return value !== '' && !value.startsWith(`..${path.sep}`) && value !== '..' && !path.isAbsolute(value);
}

function relative(file) {
  return path.relative(REPO_ROOT, file).split(path.sep).join('/');
}
