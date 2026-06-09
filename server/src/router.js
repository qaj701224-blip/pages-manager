export class Router {
  constructor() {
    this.routes = [];
  }

  on(method, pattern, handler) {
    const parts = pattern.split('/').filter(Boolean);
    this.routes.push({ method, parts, handler });
    return this;
  }

  get(pattern, handler) {
    return this.on('GET', pattern, handler);
  }
  post(pattern, handler) {
    return this.on('POST', pattern, handler);
  }
  delete(pattern, handler) {
    return this.on('DELETE', pattern, handler);
  }

  match(method, pathname) {
    const segments = pathname.split('/').filter(Boolean);

    for (const route of this.routes) {
      if (route.method !== method && !(method === 'HEAD' && route.method === 'GET')) continue;
      if (route.parts.length !== segments.length) continue;

      const params = {};
      let matched = true;

      for (let i = 0; i < route.parts.length; i++) {
        if (route.parts[i].startsWith(':')) {
          params[route.parts[i].slice(1)] = segments[i];
        } else if (route.parts[i] !== segments[i]) {
          matched = false;
          break;
        }
      }

      if (matched) return { handler: route.handler, params };
    }

    return null;
  }
}
