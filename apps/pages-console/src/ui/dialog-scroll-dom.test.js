/* global document, window */

import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act, useRef, useState } from 'react';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const appRoot = new URL('../..', import.meta.url).pathname;
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'https://workers.xd.team/workspace/sites/site_1/config',
});
const originalGlobals = new Map();
const animationFrames = new Map();
let nextAnimationFrameId = 1;
let vite;
let AppDialog;
let SiteDetail;
let MemoryRouter;
let createRoot;
const originalFetch = globalThis.fetch;

before(async () => {
  installDomGlobals();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vite = await createServer({
    appType: 'custom',
    configFile: false,
    root: appRoot,
    plugins: [react()],
    server: { middlewareMode: true },
  });
  ({ AppDialog } = await vite.ssrLoadModule('/src/ui/components/RadixPrimitives.jsx'));
  ({ SiteDetail } = await vite.ssrLoadModule('/src/ui/pages/SiteDetail.jsx'));
  ({ MemoryRouter } = await import('react-router-dom'));
  ({ createRoot } = await import('react-dom/client'));
});

beforeEach(() => {
  document.body.replaceChildren();
  animationFrames.clear();
  window.scrollTo(0, 0);
  document.cookie = '__Host-xd_cell_csrf=csrf-test; Secure; Path=/';
});

after(async () => {
  await vite?.close();
  dom.window.close();
  globalThis.fetch = originalFetch;
  restoreDomGlobals();
});

test('shared dialog preserves document scroll and restores focus to its opener', async () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    const inputRef = useRef(null);
    return React.createElement(
      React.Fragment,
      null,
      React.createElement('button', { type: 'button', onClick: () => setOpen(true) }, '打开'),
      React.createElement(
        AppDialog,
        {
          open,
          title: '测试弹窗',
          initialFocusRef: inputRef,
          onOpenChange: setOpen,
        },
        React.createElement('input', { ref: inputRef, 'aria-label': '名称' })
      )
    );
  }

  const view = await render(React.createElement(Harness));
  const opener = buttonByText('打开');
  window.scrollTo(0, 420);
  opener.focus();

  await click(opener);
  const input = await waitFor(() => document.querySelector('input[aria-label="名称"]'));
  await flushAnimationFrames();
  assert.strictEqual(document.activeElement, input);
  assert.equal(window.scrollY, 420);

  const closeButton = document.querySelector('button[title="关闭"]');
  await click(closeButton);
  window.scrollTo(0, 0);
  await waitFor(() => !document.querySelector('[role="dialog"]'));
  await waitFor(() => document.activeElement === opener);
  await flushAnimationFrames();

  assert.strictEqual(document.activeElement, opener);
  assert.equal(window.scrollY, 420);
  await view.unmount();
});

test('runtime variable refresh keeps the list mounted, reports refresh failure, and rejects a stale tab response', async () => {
  const delayedRefresh = deferred();
  const staleRefresh = deferred();
  const deployments = deferred();
  let configReads = 0;

  globalThis.fetch = async (path, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    if (path === '/api/console/sites/site_1' && method === 'GET') {
      return jsonResponse({ site: siteFixture() });
    }
    if (path === '/api/console/sites/site_1/config' && method === 'GET') {
      configReads += 1;
      if (configReads === 1) return jsonResponse(configFixture('OLD_VALUE'));
      if (configReads === 2) return delayedRefresh.promise;
      if (configReads === 3) return jsonResponse({ error: { code: 'CONFIG_REFRESH_FAILED' } }, 503);
      return staleRefresh.promise;
    }
    if (path === '/api/console/sites/site_1/deployments' && method === 'GET') {
      return deployments.promise;
    }
    if (String(path).startsWith('/api/console/sites/site_1/config/vars/') && method === 'PUT') {
      return jsonResponse({ ok: true });
    }
    throw new Error(`unexpected request: ${method} ${path}`);
  };

  const view = await renderSiteDetail('config');
  const oldValue = await waitFor(() => textNode('OLD_VALUE'));
  const originalRow = oldValue.closest('.runtime-row');
  const opener = buttonByText('添加变量');
  window.scrollTo(0, 560);
  opener.focus();

  await openAndSubmitVariable(opener, 'NEW_VAR', 'new-value');
  await waitFor(() => configReads === 2);
  assert.equal(originalRow.isConnected, true, 'the existing list row must remain mounted while refresh is pending');
  assert.ok(textNode('OLD_VALUE'));
  await waitFor(() => document.activeElement === opener);
  await flushAnimationFrames();
  assert.equal(window.scrollY, 560);

  delayedRefresh.resolve(jsonResponse(configFixture('OLD_VALUE', { name: 'NEW_VAR', value: 'new-value' })));
  await waitFor(() => textNode('NEW_VAR'));

  const secondOpener = buttonByText('添加变量');
  await openAndSubmitVariable(secondOpener, 'FAIL_REFRESH', 'saved-value');
  await waitFor(() => textNode('配置已保留，但最新列表刷新失败，请稍后重试。'));
  assert.ok(textNode('OLD_VALUE'));
  assert.ok(textNode('NEW_VAR'));

  const thirdOpener = buttonByText('添加变量');
  await openAndSubmitVariable(thirdOpener, 'STALE_REFRESH', 'saved-value');
  await waitFor(() => configReads === 4);
  await view.rerender(siteDetailElement('deployments'));
  await waitFor(() => document.body.textContent.includes('加载中'));

  staleRefresh.resolve(
    jsonResponse({
      ...configFixture('STALE_CONFIG_VALUE'),
      deployments: [{ id: 'stale-deployment', status: 'success' }],
    })
  );
  await settle();
  assert.equal(document.body.textContent.includes('stale-deployment'), false);

  deployments.resolve(jsonResponse({ deployments: [{ id: 'current-deployment', status: 'success' }] }));
  await waitFor(() => textNode('current-deployment'));
  assert.equal(document.body.textContent.includes('stale-deployment'), false);
  await view.unmount();
});

async function renderSiteDetail(tab) {
  return render(siteDetailElement(tab));
}

function siteDetailElement(tab) {
  return React.createElement(
    MemoryRouter,
    { initialEntries: [`/workspace/sites/site_1/${tab}`] },
    React.createElement(SiteDetail, {
      embedded: true,
      siteId: 'site_1',
      tab,
    })
  );
}

async function openAndSubmitVariable(opener, name, value) {
  await click(opener);
  const inputs = await waitFor(() => {
    const dialogInputs = [...document.querySelectorAll('[role="dialog"] input')];
    return dialogInputs.length === 2 ? dialogInputs : null;
  });
  const [nameInput, valueInput] = inputs;
  await inputValue(nameInput, name);
  await inputValue(valueInput, value);
  const form = nameInput.closest('form');
  await act(async () => {
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
  await waitFor(() => !document.querySelector('[role="dialog"]'));
}

async function render(element) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  await settle();
  return {
    async rerender(nextElement) {
      await act(async () => {
        root.render(nextElement);
      });
      await settle();
    },
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

async function click(element) {
  assert.ok(element, 'expected a clickable element');
  await act(async () => element.click());
  await settle();
}

async function inputValue(input, value) {
  assert.ok(input, 'expected an input');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitFor(read, message = 'condition was not met') {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await settle();
  }
  assert.fail(message);
}

async function flushAnimationFrames() {
  const pending = [...animationFrames.entries()];
  animationFrames.clear();
  await act(async () => {
    for (const [, callback] of pending) callback(window.performance.now());
  });
}

function buttonByText(label) {
  return [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === label);
}

function textNode(value) {
  return [...document.querySelectorAll('body *')].find(
    (element) => element.children.length === 0 && element.textContent.trim() === value
  );
}

function siteFixture() {
  return {
    id: 'site_1',
    slug: 'site-one',
    title: null,
    displayName: 'site-one',
    hostname: 'site-one.workers.xd.team',
    routingStatus: 'ready',
    owner: { type: 'user', id: 'user_1' },
    permissions: { role: 'admin', canManage: true, canManageAccess: true },
  };
}

function configFixture(value, ...vars) {
  return {
    config: {
      vars: [{ name: 'EXISTING_VAR', value, revision: 1, updatedAt: '2026-08-25T00:00:00.000Z' }, ...vars],
      secrets: [],
    },
  };
}

function jsonResponse(body, status = 200) {
  return Response.json(body, { status });
}

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function installDomGlobals() {
  const properties = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: undefined,
    cancelAnimationFrame: undefined,
  };
  for (const [key, value] of Object.entries(properties)) {
    originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.defineProperties(dom.window, {
    scrollX: { configurable: true, writable: true, value: 0 },
    scrollY: { configurable: true, writable: true, value: 0 },
  });
  dom.window.scrollTo = (x, y) => {
    dom.window.scrollX = Number(x) || 0;
    dom.window.scrollY = Number(y) || 0;
  };
  dom.window.requestAnimationFrame = (callback) => {
    const id = nextAnimationFrameId++;
    animationFrames.set(id, callback);
    return id;
  };
  dom.window.cancelAnimationFrame = (id) => animationFrames.delete(id);
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame;
  globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame;
  if (!dom.window.PointerEvent) dom.window.PointerEvent = dom.window.MouseEvent;
}

function restoreDomGlobals() {
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  for (const [key, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
}
