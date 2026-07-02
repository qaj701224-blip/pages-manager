import { LogIn, ShieldCheck } from 'lucide-react';

export function LoginPage() {
  const returnTo = normalizeReturnTo(new URLSearchParams(window.location.search).get('returnTo'));
  const loginUrl = `/api/console/auth/login?returnTo=${encodeURIComponent(returnTo)}`;

  return (
    <main className="auth-page">
      <section className="auth-panel" aria-labelledby="login-title">
        <div className="auth-panel__mark">
          <ShieldCheck size={22} />
        </div>
        <p className="auth-panel__eyebrow">XD Cell</p>
        <h1 id="login-title">登录工作台</h1>
        <p className="auth-panel__text">使用公司 SSO 进入个人站点、团队协作和平台控制台。</p>
        <a className="primary-button" href={loginUrl}>
          <LogIn size={18} />
          <span>登录</span>
        </a>
      </section>
    </main>
  );
}

function normalizeReturnTo(value) {
  const raw = String(value || '').trim() || '/workspace/published';
  if (raw.startsWith('//')) return '/workspace/published';
  let url;
  try {
    url = new URL(raw, window.location.origin);
  } catch {
    return '/workspace/published';
  }
  if (url.origin !== window.location.origin || url.username || url.password || url.hash) return '/workspace/published';
  const path = `${url.pathname}${url.search}`;
  if (url.pathname === '/workspace' || url.pathname.startsWith('/workspace/')) return path;
  if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return path;
  return '/workspace/published';
}
