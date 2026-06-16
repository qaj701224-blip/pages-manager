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
  </main>
</template>

<script setup>
import { ref } from 'vue';

const count = ref(0);
</script>

<style scoped>
.home-page {
  max-width: 760px;
}

.intro-panel {
  margin-bottom: 24px;
}

.counter-row {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
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

@media (max-width: 640px) {
  .counter-row {
    align-items: stretch;
    flex-direction: column;
  }

  button {
    width: 100%;
  }
}
</style>
