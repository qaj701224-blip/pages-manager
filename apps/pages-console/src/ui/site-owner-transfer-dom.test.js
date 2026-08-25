/* global document, window */

import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const appRoot = new URL('../..', import.meta.url).pathname;
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'https://workers.xd.team/workspace/sites/site_1/settings',
});
const originalGlobals = new Map();
const originalFetch = globalThis.fetch;
let vite;
let SiteDetail;
let WorkspaceSites;
let PreferencesProvider;
let RouterProvider;
let createMemoryRouter;
let createRoot;

before(async () => {
  installDomGlobals();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vite = await createServer({
    appType: 'custom',
    configFile: false,
    root: appRoot,
    plugins: [react()],
    server: { middlewareMode: true, hmr: false },
  });
  ({ SiteDetail } = await vite.ssrLoadModule('/src/ui/pages/SiteDetail.jsx'));
  ({ WorkspaceSites } = await vite.ssrLoadModule('/src/ui/pages/WorkspaceSites.jsx'));
  ({ PreferencesProvider } = await vite.ssrLoadModule('/src/ui/preferences-context.jsx'));
  ({ RouterProvider, createMemoryRouter } = await import('react-router-dom'));
  ({ createRoot } = await import('react-dom/client'));
});

beforeEach(() => {
  document.body.replaceChildren();
  document.cookie = '__Host-xd_cell_csrf=csrf-test; Secure; Path=/';
});

after(async () => {
  await vite?.close();
  dom.window.close();
  globalThis.fetch = originalFetch;
  restoreDomGlobals();
});

test('ownership transfer freezes its target, PATCHes after confirmation, and replaces after access loss', async () => {
  const transfer = deferred();
  const patchBodies = [];
  globalThis.fetch = async (path, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    if (path === '/api/console/sites/site_1' && method === 'GET') return jsonResponse(siteResponse());
    if (path === '/api/console/users' && method === 'GET') {
      return jsonResponse({
        users: [
          activeUser('usr_owner', '当前 Owner'),
          activeUser('usr_target', '目标用户'),
          activeUser('usr_other', '其他用户'),
          { ...activeUser('usr_unknown', '未知状态用户'), employeeStatus: 'unknown' },
        ],
      });
    }
    if (path === '/api/console/sites/site_1/settings' && method === 'PATCH') {
      patchBodies.push(JSON.parse(init.body));
      return transfer.promise;
    }
    if (String(path).startsWith('/api/console/workspace/sites?') && method === 'GET') {
      return jsonResponse({ sites: [] });
    }
    throw new Error(`unexpected request: ${method} ${path}`);
  };

  const { router, unmount } = await renderWorkspaceSite();
  await waitFor(() => buttonByText('转移归属'));
  assert.equal(buttonByText('继续'), undefined);

  await click(buttonByText('转移归属'));
  const continueButton = await waitFor(() => buttonByText('继续'));
  await waitFor(() => ownerButton('目标用户'));
  assert.equal(textNode('未知状态用户'), undefined);
  assert.equal(continueButton.disabled, true, 'the current owner must not be a valid target');
  await click(ownerButton('目标用户'));
  assert.equal(continueButton.disabled, false);
  assert.equal(patchBodies.length, 0);

  await click(continueButton);
  await waitFor(() => textNode('确认转移站点归属'));
  assert.equal(patchBodies.length, 0, 'opening the dialog must not submit the transfer');
  await click(ownerButton('其他用户'));
  const confirmButton = buttonByText('确认转移');
  await click(confirmButton);
  await waitFor(() => patchBodies.length === 1);
  assert.deepEqual(patchBodies[0], { ownerType: 'user', ownerId: 'usr_target' });
  assert.equal(confirmButton.disabled, true);
  confirmButton.click();
  await settle();
  assert.equal(patchBodies.length, 1, 'a pending transfer cannot be submitted twice');

  transfer.resolve(
    jsonResponse({
      site: {
        ...siteResponse().site,
        owner: { type: 'user', id: 'usr_target', displayName: '目标用户', email: 'target@example.com' },
        permissions: { role: 'viewer', canManage: false, canManageAccess: false, canTransferOwnership: false },
      },
    })
  );
  await waitFor(() => router.state.location.pathname === '/workspace/published');
  assert.equal(router.state.historyAction, 'REPLACE');
  assert.ok(textNode('站点归属已转移。'));
  await unmount();
});

test('transfer failure stays in the confirmation dialog without a reauthentication action', async () => {
  let patchCount = 0;
  globalThis.fetch = async (path, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    if (path === '/api/console/sites/site_1' && method === 'GET') return jsonResponse(siteResponse());
    if (path === '/api/console/users' && method === 'GET') {
      return jsonResponse({ users: [activeUser('usr_owner', '当前 Owner'), activeUser('usr_target', '目标用户')] });
    }
    if (path === '/api/console/sites/site_1/settings' && method === 'PATCH') {
      patchCount += 1;
      return jsonResponse({ error: { code: 'SITE_POLICY_CONFLICT', message: 'Site policy changed.' } }, 409);
    }
    throw new Error(`unexpected request: ${method} ${path}`);
  };

  const { unmount } = await renderWorkspaceSite();
  await waitFor(() => buttonByText('转移归属'));
  await click(buttonByText('转移归属'));
  await click(await waitFor(() => ownerButton('目标用户')));
  await click(buttonByText('继续'));
  await click(await waitFor(() => buttonByText('确认转移')));

  const error = await waitFor(() => textNode('站点归属或权限已变化，请刷新后重试。'));
  assert.ok(error.closest('[role="alert"]'));
  assert.ok(document.querySelector('[role="alertdialog"]'), 'the dialog must remain open after an API error');
  assert.equal(document.querySelector('[role="alertdialog"] a'), null);
  assert.equal(patchCount, 1);
  await unmount();
});

test('a team transfer that retains access patches only ownership fields and keeps concurrent metadata', async () => {
  globalThis.fetch = async (path, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    if (path === '/api/console/sites/site_1' && method === 'GET') {
      return jsonResponse(siteResponse({ title: '当前名称', displayName: '当前名称' }));
    }
    if (path === '/api/console/teams' && method === 'GET') {
      return jsonResponse({
        teams: [
          {
            id: 'team_target',
            name: '目标团队',
            departmentPath: 'XD/Platform',
            status: 'active',
            currentUserRole: 'publisher',
          },
        ],
      });
    }
    if (path === '/api/console/sites/site_1/settings' && method === 'PATCH') {
      return jsonResponse({
        site: {
          ...siteResponse().site,
          title: '迟到的旧名称',
          slug: 'stale-slug',
          hostname: 'stale-slug.workers.xd.team',
          owner: { type: 'team', id: 'team_target', displayName: '目标团队', departmentPath: 'XD/Platform' },
          permissions: {
            role: 'publisher',
            canManage: true,
            canManageAccess: false,
            canTransferOwnership: false,
          },
        },
      });
    }
    throw new Error(`unexpected request: ${method} ${path}`);
  };

  const { router, unmount } = await renderWorkspaceSite();
  await waitFor(() => buttonByText('转移归属'));
  await click(buttonByText('转移归属'));
  await click(buttonByText('团队'));
  await click(await waitFor(() => ownerButton('目标团队')));
  await click(buttonByText('继续'));
  assert.equal(document.body.textContent.includes('你将无法继续访问或管理此站点'), false);
  await click(await waitFor(() => buttonByText('确认转移')));

  await waitFor(() => textNode('站点归属已转移'));
  assert.equal(router.state.location.pathname, '/workspace/sites/site_1/settings');
  assert.equal(document.querySelector('input[aria-label="站点名称"]').value, '当前名称');
  assert.equal(document.querySelector('input[aria-label="站点 URL slug"]').value, 'site-one');
  assert.ok(textNode('目标团队'));
  await unmount();
});

test('a team admin transferring ownership to their own user does not show an access-loss warning', async () => {
  globalThis.fetch = async (path, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    if (path === '/api/console/sites/site_1' && method === 'GET') {
      return jsonResponse(
        siteResponse({
          owner: { type: 'team', id: 'team_source', displayName: '源团队' },
          permissions: { role: 'admin', canManage: true, canManageAccess: true, canTransferOwnership: true },
        })
      );
    }
    if (path === '/api/console/users' && method === 'GET') {
      return jsonResponse({ users: [activeUser('usr_self', '当前用户'), activeUser('usr_other', '其他用户')] });
    }
    throw new Error(`unexpected request: ${method} ${path}`);
  };

  const { unmount } = await renderWorkspaceSite('usr_self');
  await waitFor(() => buttonByText('转移归属'));
  await click(buttonByText('转移归属'));
  await click(buttonByText('个人'));
  await click(await waitFor(() => ownerButton('当前用户')));
  await click(buttonByText('继续'));
  await waitFor(() => textNode('确认转移站点归属'));
  assert.equal(document.body.textContent.includes('你将无法继续访问或管理此站点'), false);
  await unmount();
});

test('the transfer action is absent when the dedicated capability is false', async () => {
  globalThis.fetch = async (path, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    if (path === '/api/console/sites/site_1' && method === 'GET') {
      return jsonResponse(
        siteResponse({
          permissions: { role: 'publisher', canManage: true, canManageAccess: false, canTransferOwnership: false },
        })
      );
    }
    throw new Error(`unexpected request: ${method} ${path}`);
  };

  const { unmount } = await renderWorkspaceSite();
  await waitFor(() => textNode('仅当前个人 Owner 或团队 admin 可转移站点归属。'));
  assert.equal(buttonByText('转移归属'), undefined);
  await unmount();
});

test('admin ownership picker includes every active team regardless of membership role', async () => {
  globalThis.fetch = async (path, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    if (path === '/api/console/admin/sites/site_1' && method === 'GET') return jsonResponse(siteResponse());
    if (String(path).startsWith('/api/console/admin/users?') && method === 'GET') return jsonResponse({ users: [] });
    if (path === '/api/console/admin/teams?status=active' && method === 'GET') {
      return jsonResponse({
        teams: [
          { id: 'team_viewer', name: 'Viewer Team', status: 'active', currentUserRole: 'viewer' },
          { id: 'team_outside', name: 'Outside Team', status: 'active' },
          { id: 'team_inactive', name: 'Inactive Team', status: 'inactive' },
        ],
      });
    }
    throw new Error(`unexpected request: ${method} ${path}`);
  };

  const { unmount } = await renderAdminSite();
  await waitFor(() => buttonByText('转移归属'));
  await click(buttonByText('转移归属'));
  await click(buttonByText('团队'));
  await waitFor(() => ownerButton('Viewer Team'));
  assert.ok(ownerButton('Outside Team'));
  assert.equal(ownerButton('Inactive Team'), undefined);
  await unmount();
});

async function renderWorkspaceSite(currentUserId = null) {
  const router = createMemoryRouter(
    [
      {
        path: '/workspace/sites/site_1/settings',
        element: React.createElement(SiteDetail, {
          embedded: true,
          siteId: 'site_1',
          tab: 'settings',
          sessionState: currentUserId
            ? { status: 'ready', session: { authenticated: true, user: { userId: currentUserId } } }
            : undefined,
        }),
      },
      { path: '/workspace/published', element: React.createElement(WorkspaceSites) },
    ],
    { initialEntries: ['/workspace/sites/site_1/settings'] }
  );
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(React.createElement(PreferencesProvider, null, React.createElement(RouterProvider, { router })))
  );
  await settle();
  return {
    router,
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

async function renderAdminSite() {
  const router = createMemoryRouter(
    [
      {
        path: '/admin/sites/site_1/settings',
        element: React.createElement(SiteDetail, {
          embedded: true,
          scope: 'admin',
          siteId: 'site_1',
          tab: 'settings',
        }),
      },
    ],
    { initialEntries: ['/admin/sites/site_1/settings'] }
  );
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(React.createElement(PreferencesProvider, null, React.createElement(RouterProvider, { router })))
  );
  await settle();
  return {
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

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitFor(read, message = 'condition was not met') {
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await settle();
  }
  assert.fail(message);
}

function buttonByText(label) {
  return [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === label);
}

function ownerButton(label) {
  return [...document.querySelectorAll('.owner-picker-row')].find((button) => button.textContent.includes(label));
}

function textNode(value) {
  return [...document.querySelectorAll('body *')].find(
    (element) => element.children.length === 0 && element.textContent.trim() === value
  );
}

function activeUser(id, realname) {
  return { id, realname, email: `${id}@example.com`, employeeStatus: 'active' };
}

function siteResponse(overrides = {}) {
  return {
    site: {
      id: 'site_1',
      slug: 'site-one',
      title: null,
      displayName: 'site-one',
      hostname: 'site-one.workers.xd.team',
      routingStatus: 'ready',
      owner: { type: 'user', id: 'usr_owner', displayName: '当前 Owner', email: 'usr_owner@example.com' },
      permissions: { role: 'admin', canManage: true, canManageAccess: true, canTransferOwnership: true },
      ...overrides,
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function jsonResponse(body, status = 200) {
  return Response.json(body, { status });
}

function installDomGlobals() {
  const properties = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    MutationObserver: dom.window.MutationObserver,
    CustomEvent: dom.window.CustomEvent,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
  };
  for (const [key, value] of Object.entries(properties)) {
    originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  window.scrollTo = () => {};
  window.requestAnimationFrame = globalThis.requestAnimationFrame;
  window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
  if (!window.PointerEvent) window.PointerEvent = window.MouseEvent;
}

function restoreDomGlobals() {
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  for (const [key, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
}
