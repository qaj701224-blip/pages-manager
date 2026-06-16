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

  match(method, pathname) {
    const segments = pathname.split('/').filter(Boolean);

    for (const route of this.routes) {
      if (route.method !== method && !(method === 'HEAD' && route.method === 'GET')) continue;
      if (route.parts.length !== segments.length) continue;

      const params = {};
      let matched = true;

      for (let i = 0; i < route.parts.length; i++) {
        const part = route.parts[i];
        if (part.startsWith(':')) {
          params[part.slice(1)] = segments[i];
        } else if (part !== segments[i]) {
          matched = false;
          break;
        }
      }

      if (matched) return { handler: route.handler, params };
    }

    return null;
  }
}
