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
      <div class="panel-heading">
        <div>
          <h2 id="kv-title">Pages KV 测试</h2>
          <p>站点级 KV 读写面板。</p>
        </div>
        <span class="mode-badge">{{ kvType }}</span>
      </div>

      <div class="form-grid">
        <label class="field field-wide">
          <span>Key</span>
          <input v-model.trim="kvKey" type="text" spellcheck="false" />
        </label>

        <label class="field">
          <span>Value Type</span>
          <select v-model="kvType">
            <option value="json">json</option>
            <option value="text">text</option>
          </select>
        </label>
      </div>

      <label class="field">
        <span>Value</span>
        <textarea v-model="kvValue" rows="8" spellcheck="false" />
      </label>

      <div class="button-row">
        <button type="button" :disabled="isBusy" @click="readKv">Read</button>
        <button type="button" :disabled="isBusy" @click="writeKv">Write</button>
        <button type="button" :disabled="isBusy" @click="deleteKv">Delete</button>
        <button type="button" :disabled="isBusy" @click="resetSample">Sample</button>
      </div>

      <p class="status-line" :class="statusClass">{{ statusText }}</p>
      <pre v-if="resultText" class="result-box">{{ resultText }}</pre>
    </section>
  </main>
</template>

<script setup>
import { computed, ref } from 'vue';
import { createPagesClient, PagesSDKError } from '../../../../apps/pages-sdk/dist/browser.js';

const pages = createPagesClient();
const count = ref(0);
const kvKey = ref('demo/vue-app/message');
const kvType = ref('json');
const kvValue = ref('');
const resultText = ref('');
const statusText = ref('等待操作');
const statusKind = ref('idle');
const busyAction = ref('');

const isBusy = computed(() => busyAction.value !== '');
const statusClass = computed(() => ({
  'is-error': statusKind.value === 'error',
  'is-success': statusKind.value === 'success',
}));

resetSample();

function resetSample() {
  kvType.value = 'json';
  kvValue.value = JSON.stringify(
    {
      message: 'hello from vue demo',
      updatedAt: new Date().toISOString(),
    },
    null,
    2
  );
  resultText.value = '';
  setStatus('已填入示例 JSON', 'idle');
}

async function readKv() {
  await runKvAction('read', async () => {
    const value = await pages.kv.get(kvKey.value, { type: kvType.value });
    resultText.value = formatValue(value);
    setStatus(value === null ? '读取成功：key 不存在' : '读取成功', 'success');
  });
}

async function writeKv() {
  await runKvAction('write', async () => {
    await pages.kv.put(kvKey.value, parseInputValue(), { type: kvType.value });
    resultText.value = '';
    setStatus('写入成功', 'success');
  });
}

async function deleteKv() {
  await runKvAction('delete', async () => {
    await pages.kv.delete(kvKey.value);
    resultText.value = '';
    setStatus('删除成功', 'success');
  });
}

async function runKvAction(action, task) {
  if (!kvKey.value) {
    setStatus('Key 不能为空', 'error');
    return;
  }

  busyAction.value = action;
  setStatus(`${action} 中...`, 'idle');
  try {
    await task();
  } catch (error) {
    setStatus(describeError(error), 'error');
  } finally {
    busyAction.value = '';
  }
}

function parseInputValue() {
  if (kvType.value === 'text') return kvValue.value;
  return JSON.parse(kvValue.value);
}

function formatValue(value) {
  if (value === null) return 'null';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function describeError(error) {
  if (error instanceof PagesSDKError) {
    const status = error.status ? ` HTTP ${error.status}` : '';
    return `${error.code}${status}: ${error.message}`;
  }
  if (error instanceof SyntaxError) return `JSON 格式错误: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

function setStatus(message, kind) {
  statusText.value = message;
  statusKind.value = kind;
}
</script>

<style scoped>
.home-page {
  max-width: 760px;
}

.intro-panel,
.kv-panel {
  margin-bottom: 24px;
}

.counter-row,
.button-row,
.panel-heading,
.form-grid {
  display: flex;
  gap: 12px;
}

.counter-row,
.panel-heading {
  align-items: center;
  justify-content: space-between;
}

.kv-panel {
  border: 1px solid #d7dde7;
  border-radius: 8px;
  padding: 18px;
  background: #f8fafc;
}

.panel-heading {
  margin-bottom: 16px;
}

.panel-heading h2 {
  margin: 0 0 6px;
}

.panel-heading p {
  margin: 0;
  color: #475569;
}

.mode-badge {
  min-width: 52px;
  border-radius: 999px;
  padding: 4px 10px;
  background: #1f2937;
  color: white;
  text-align: center;
  font-size: 13px;
}

.form-grid {
  align-items: end;
  margin-bottom: 12px;
}

.field {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
}

.field-wide {
  flex: 2;
}

.field span {
  color: #334155;
  font-size: 13px;
  font-weight: 600;
}

input,
select,
textarea {
  box-sizing: border-box;
  width: 100%;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  padding: 9px 10px;
  background: white;
  color: #0f172a;
  font: inherit;
}

textarea {
  resize: vertical;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
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

button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.status-line {
  min-height: 22px;
  color: #475569;
}

.status-line.is-success {
  color: #047857;
}

.status-line.is-error {
  color: #b42318;
}

.result-box {
  overflow: auto;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  padding: 12px;
  background: #0f172a;
  color: #e2e8f0;
}

@media (max-width: 640px) {
  .counter-row,
  .button-row,
  .panel-heading,
  .form-grid {
    align-items: stretch;
    flex-direction: column;
  }

  button {
    width: 100%;
  }
}
</style>
