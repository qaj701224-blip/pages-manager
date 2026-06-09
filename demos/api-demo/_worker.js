export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const res = await fetch('https://wttr.in/Shanghai?format=j1');
      const data = await res.json();
      const c = data.current_condition[0];

      const html = `<!DOCTYPE html>
<html lang="zh">
<head><meta charset="utf-8"><title>服务端渲染 Demo</title>
<style>
body{font-family:system-ui;max-width:600px;margin:40px auto;padding:0 20px;color:#333}
.card{background:#f0f9ff;border-radius:8px;padding:20px;margin:20px 0}
.card h2{margin-top:0}
.meta{color:#666;font-size:.9em;margin-top:20px}
</style></head>
<body>
<h1>服务端渲染示例</h1>
<p>此页面由 Worker 在服务端生成。浏览器打开后<strong>不会发起任何 API 请求</strong>，数据已经在 HTML 里了。</p>
<div class="card">
  <h2>上海实时天气</h2>
  <p>🌡 温度: ${c.temp_C}°C / ${c.temp_F}°F</p>
  <p>🤔 体感: ${c.FeelsLikeC}°C</p>
  <p>☁ 天气: ${c.weatherDesc[0].value}</p>
  <p>💧 湿度: ${c.humidity}%</p>
  <p>🌬 风速: ${c.windspeedKmph} km/h</p>
</div>
<p class="meta">
  生成时间: ${new Date().toISOString()}<br>
  数据来源: wttr.in (Worker fetch，非浏览器请求)<br>
  <a href="/about.html">关于本 Demo (静态资源)</a>
</p>
</body></html>`;

      return new Response(html, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    return env.ASSETS.fetch(request);
  },
};
