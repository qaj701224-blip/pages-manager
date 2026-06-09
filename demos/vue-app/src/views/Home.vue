<template>
  <div>
    <h2>首页</h2>
    <p>这是首页。点击上方导航切换页面，然后刷新浏览器测试路由回退。</p>
    <p>Count: {{ count }}</p>
    <button @click="count++">+1</button>
  </div>
</template>

<script setup>
import { ref } from 'vue';
const count = ref(0);
</script>
