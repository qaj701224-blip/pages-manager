import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { fetchJson } from '../api.js';
import { sitePublicUrl } from '../site-display-model.js';

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
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  if (state.status === 'loading') return <div className="placeholder">加载中</div>;
  if (state.status === 'error') return <div className="placeholder">无法加载站点</div>;
  if (!state.sites.length) return <div className="placeholder">暂无站点</div>;
  const visibleSites = filterSites(state.sites, { query, status });

  return (
    <>
      <div className="list-toolbar site-list-toolbar" aria-label="站点筛选">
        <label className="list-search">
          <span>搜索站点</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、URL、Owner" />
        </label>
        <div className="segmented compact-segmented" role="tablist" aria-label="站点状态">
          {[
            ['all', '全部'],
            ['active', 'Active'],
            ['disabled', 'Disabled'],
          ].map(([value, label]) => (
            <button className={status === value ? 'active' : ''} key={value} type="button" onClick={() => setStatus(value)}>
              {label}
            </button>
          ))}
        </div>
        <span className="toolbar-count">{visibleSites.length} / {state.sites.length}</span>
      </div>
      {visibleSites.length ? (
        <section className="site-grid" aria-label="站点列表">
          {visibleSites.map((site) => (
            <SiteCard key={site.id} site={site} />
          ))}
        </section>
      ) : (
        <div className="placeholder">没有匹配的站点</div>
      )}
    </>
  );
}

export function SiteCard({ site }) {
  const navigate = useNavigate();
  const ownerType = site.owner?.type === 'team' ? '团队' : '个人';
  const ownerText = site.owner?.displayName || ownerType;
  const publicUrl = sitePublicUrl(site.hostname);
  const visibility = site.visibility || site.access?.visibility || 'internal';
  const status = site.status || (visibility === 'disabled' ? 'disabled' : 'active');
  const statusKind = status === 'disabled' || visibility === 'disabled' ? 'disabled' : 'active';
  const title = site.slug || site.hostname || site.id;
  const detailPath = `/workspace/sites/${encodeURIComponent(site.id)}`;
  const openDetail = () => navigate(detailPath);
  const onKeyDown = (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    openDetail();
  };

  return (
    <article className="site-card" role="button" tabIndex={0} onClick={openDetail} onKeyDown={onKeyDown}>
      <div className="site-card__content">
        <div className="site-card__title-row">
          <span className={`status-dot ${statusKind}`} aria-hidden="true" />
          <h2 title={title}>{title}</h2>
        </div>
        <p title={publicUrl || site.slug}>{publicUrl || site.slug}</p>
      </div>
      <div className="site-card__footer">
        <div className="tag-row site-card__tags">
          <span className="tag" title={ownerText}>{ownerType}</span>
          <span className="tag" title={ownerText}>{ownerText}</span>
          <span className="tag">{visibility}</span>
          <span className={statusKind === 'active' ? 'tag tag-success' : 'tag tag-disabled'}>{status}</span>
        </div>
        {publicUrl ? (
          <a
            className="site-card__open"
            href={publicUrl}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(event) => event.stopPropagation()}
            aria-label={`打开站点 ${title}`}
          >
            <span>打开</span>
            <ExternalLink size={14} />
          </a>
        ) : null}
      </div>
    </article>
  );
}

function filterSites(sites, { query, status }) {
  const normalizedQuery = query.trim().toLowerCase();
  return sites.filter((site) => {
    const visibility = site.visibility || site.access?.visibility || 'internal';
    const siteStatus = site.status || (visibility === 'disabled' ? 'disabled' : 'active');
    if (status !== 'all' && siteStatus !== status) return false;
    if (!normalizedQuery) return true;
    const haystack = [
      site.slug,
      site.hostname,
      sitePublicUrl(site.hostname),
      site.owner?.displayName,
      site.owner?.email,
      site.owner?.departmentPath,
      site.owner?.type,
      visibility,
      siteStatus,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(normalizedQuery);
  });
}

export function PageHeading({ title, meta }) {
  return (
    <div className="page-heading">
      <h1>{title}</h1>
      <p>{meta}</p>
    </div>
  );
}
