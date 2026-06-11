export default {
  async fetch(request) {
    const url = new URL(request.url);
    const host = url.hostname;

    // pages-api.xd-ads.com → api.workers.xd.team
    if (host === 'pages-api.xd-ads.com') {
      const newUrl = `https://api.workers.xd.team${url.pathname}${url.search}`;
      return Response.redirect(newUrl, 308);
    }

    // {name}-page.xd-ads.com → {name}.workers.xd.team
    const match = host.match(/^(.+)-page\.xd-ads\.com$/);
    if (match) {
      const newUrl = `https://${match[1]}.workers.xd.team${url.pathname}${url.search}`;
      return Response.redirect(newUrl, 308);
    }

    return new Response('Not found', { status: 404 });
  },
};
