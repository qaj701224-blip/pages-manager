import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';

import { fetchJson } from '../api.js';

export function SitesDirectory() {
  const [state, setState] = useState({ status: 'loading', sites: [], error: null });

  useEffect(() => {
    let active = true;
    fetchJson('/api/console/directory')
      .then((data) => {
        if (active) setState({ status: 'ready', sites: data.sites || [], error: null });
      })
      .catch((error) => {
        if (active) setState({ status: 'error', sites: [], error });
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <main className="page">
      <PageHeading title="站点目录" meta="Sites" />
      <SiteWaterfall state={state} />
    </main>
  );
}

export function SiteWaterfall({ state }) {
  if (state.status === 'loading') return <div className="placeholder">加载中</div>;
  if (state.status === 'error') return <div className="placeholder">无法加载站点</div>;
  if (!state.sites.length) return <div className="placeholder">暂无站点</div>;

  return (
    <section className="site-grid" aria-label="站点列表">
      {state.sites.map((site) => (
        <SiteCard key={site.id} site={site} />
      ))}
    </section>
  );
}

export function SiteCard({ site }) {
  const ownerText = site.owner?.displayName || (site.owner?.type === 'team' ? '团队' : '个人');
  return (
    <article className="site-card">
      <div className="site-card__top">
        <div>
          <h2>
            <a href={`/workspace/sites/${encodeURIComponent(site.id)}`}>{site.slug || site.hostname}</a>
          </h2>
          <p>{site.hostname || site.slug}</p>
        </div>
        {site.hostname ? (
          <a className="icon-button compact" href={`https://${site.hostname}`} aria-label="打开站点">
            <ExternalLink size={16} />
          </a>
        ) : null}
      </div>
      <div className="tag-row">
        <span className="tag">{ownerText}</span>
        <span className="tag">{site.visibility || 'internal'}</span>
        <span className="tag muted">{site.status || 'unknown'}</span>
      </div>
    </article>
  );
}

export function PageHeading({ title, meta }) {
  return (
    <div className="page-heading">
      <h1>{title}</h1>
      <p>{meta}</p>
    </div>
  );
}
