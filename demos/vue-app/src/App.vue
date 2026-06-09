<template>
  <div>
    <h1>Vue Router Demo</h1>
    <nav>
      <router-link to="/">首页</router-link> |
      <router-link to="/about">关于</router-link>
    </nav>
    <hr />
    <router-view />
  </div>
</template>
