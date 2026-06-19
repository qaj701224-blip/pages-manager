/* global document */

import { createPagesClient } from '../vendor/xd-pages-sdk/browser.js';

const DATA_KEY = 'smoke/latest-message';
const pages = createPagesClient();

const form = document.querySelector('#data-form');
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
  run('Site data set', async () => {
    await pages.data.site.set(DATA_KEY, value);
    return { key: DATA_KEY, value };
  });
});

readButton.addEventListener('click', () => {
  run('Site data get', async () => ({ key: DATA_KEY, value: await pages.data.site.get(DATA_KEY) }));
});

deleteButton.addEventListener('click', () => {
  run('Site data delete', async () => {
    await pages.data.site.delete(DATA_KEY);
    return { key: DATA_KEY, deleted: true };
  });
});
