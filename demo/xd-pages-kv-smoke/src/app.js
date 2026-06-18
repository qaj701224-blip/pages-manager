/* global document */

import { createPagesClient } from '../vendor/xd-pages-sdk/browser.js';

const KV_KEY = 'smoke/latest-message';
const pages = createPagesClient();

const form = document.querySelector('#kv-form');
const input = document.querySelector('#message');
const readButton = document.querySelector('#read');
const deleteButton = document.querySelector('#delete');
const log = document.querySelector('#log');

function writeLog(label, payload) {
  log.textContent = `${label}\n${JSON.stringify(payload, null, 2)}`;
}

async function run(label, action) {
  try {
    const result = await action();
    writeLog(label, result ?? { ok: true });
  } catch (error) {
    writeLog(`${label} failed`, {
      name: error?.name,
      code: error?.code,
      message: error?.message,
      status: error?.status,
    });
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const value = {
    message: input.value,
    updatedAt: new Date().toISOString(),
  };
  run('KV set', async () => {
    await pages.kv.set(KV_KEY, value);
    return { key: KV_KEY, value };
  });
});

readButton.addEventListener('click', () => {
  run('KV get', async () => ({ key: KV_KEY, value: await pages.kv.get(KV_KEY) }));
});

deleteButton.addEventListener('click', () => {
  run('KV delete', async () => {
    await pages.kv.delete(KV_KEY);
    return { key: KV_KEY, deleted: true };
  });
});
