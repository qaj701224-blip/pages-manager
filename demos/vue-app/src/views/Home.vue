<template>
  <main class="home-page">
    <section class="intro-panel">
      <h2>首页</h2>
      <p>这是首页。点击上方导航切换页面，然后刷新浏览器测试路由回退。</p>
      <div class="counter-row">
        <span>Count: {{ count }}</span>
        <button type="button" @click="count++">+1</button>
      </div>
    </section>

    <section class="kv-panel" aria-labelledby="kv-title">
      <h2 id="kv-title">Pages KV</h2>
      <p>发布到 XD Pages 后，可在这里验证浏览器 SDK 的 KV get / set / delete 链路。</p>

      <label class="field">
        Key
        <input v-model="kvKey" autocomplete="off" spellcheck="false" />
      </label>

      <label class="field">
        Value
        <textarea v-model="kvValue" rows="5" spellcheck="false" />
      </label>

      <div class="button-row">
        <button type="button" :disabled="kvBusy" @click="saveKv">Set</button>
        <button type="button" :disabled="kvBusy" @click="loadKv">Get</button>
        <button type="button" :disabled="kvBusy" class="danger" @click="deleteKv">Delete</button>
      </div>

      <p class="kv-status" :data-state="kvState">{{ kvStatus }}</p>
    </section>
  </main>
</template>

<script setup>
import { ref } from 'vue';
import { createPagesClient, PagesSDKError } from '../../../xd-pages-kv-smoke/vendor/xd-pages-sdk/browser.js';

const count = ref(0);
const pages = createPagesClient();
const kvKey = ref('demo/vue-app/message');
const kvValue = ref(JSON.stringify({ message: 'hello from XD Pages KV' }, null, 2));
const kvBusy = ref(false);
const kvStatus = ref('等待操作');
const kvState = ref('idle');

async function runKvAction(action, successMessage) {
  kvBusy.value = true;
  kvState.value = 'idle';
  kvStatus.value = '请求中...';
  try {
    await action();
    kvState.value = 'ok';
    kvStatus.value = successMessage;
  } catch (error) {
    kvState.value = 'error';
    kvStatus.value = formatKvError(error);
  } finally {
    kvBusy.value = false;
  }
}

async function saveKv() {
  await runKvAction(async () => {
    await pages.kv.set(kvKey.value.trim(), parseKvValue(kvValue.value));
  }, '写入成功');
}

async function loadKv() {
  await runKvAction(async () => {
    const value = await pages.kv.get(kvKey.value.trim());
    kvValue.value = value === null ? '' : JSON.stringify(value, null, 2);
  }, '读取成功');
}

async function deleteKv() {
  await runKvAction(async () => {
    await pages.kv.delete(kvKey.value.trim());
    kvValue.value = '';
  }, '删除成功');
}

function parseKvValue(value) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed);
}

function formatKvError(error) {
  if (error instanceof SyntaxError) return 'Value 必须是合法 JSON';
  if (error instanceof PagesSDKError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : 'KV 请求失败';
}
</script>

<style scoped>
.home-page {
  max-width: 760px;
}

.intro-panel {
  margin-bottom: 24px;
}

.kv-panel {
  border-top: 1px solid #e2e8f0;
  display: grid;
  gap: 14px;
  padding-top: 24px;
}

.counter-row {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
}

.field {
  display: grid;
  gap: 6px;
  font-weight: 600;
}

input,
textarea {
  box-sizing: border-box;
  width: 100%;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  padding: 9px 10px;
  color: #0f172a;
  font: inherit;
}

textarea {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  resize: vertical;
}

.button-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

button {
  min-width: 78px;
  border: 1px solid #0f172a;
  border-radius: 6px;
  padding: 8px 12px;
  background: #0f172a;
  color: white;
  cursor: pointer;
  font: inherit;
}

button.danger {
  border-color: #b91c1c;
  background: #b91c1c;
}

button:disabled {
  cursor: wait;
  opacity: 0.55;
}

.kv-status {
  min-height: 24px;
  margin: 0;
  color: #475569;
}

.kv-status[data-state='ok'] {
  color: #166534;
}

.kv-status[data-state='error'] {
  color: #b91c1c;
}

@media (max-width: 640px) {
  .counter-row {
    align-items: stretch;
    flex-direction: column;
  }

  button {
    flex: 1 1 100%;
  }
}
</style>
