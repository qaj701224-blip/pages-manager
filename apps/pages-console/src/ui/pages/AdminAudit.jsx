import { useEffect, useMemo, useState } from 'react';

import { listAdminAuditEvents } from '../api.js';
import { AdminError, formatDate } from './AdminDashboard.jsx';

export function AdminAudit() {
  const [state, setState] = useState({ status: 'loading', events: [], error: null });
  const [query, setQuery] = useState('');
  const [decision, setDecision] = useState('all');

  useEffect(() => {
    let active = true;
    listAdminAuditEvents()
      .then((data) => {
        if (active) setState({ status: 'ready', events: data.events || [], error: null });
      })
      .catch((error) => {
        if (active) setState({ status: 'error', events: [], error });
      });
    return () => {
      active = false;
    };
  }, []);
  const visibleEvents = useMemo(
    () => filterAuditEvents(state.events, { query, decision }),
    [state.events, query, decision]
  );

  if (state.status === 'loading') return <div className="placeholder">加载中</div>;
  if (state.status === 'error') return <AdminError title="审计日志加载失败" error={state.error} />;
  if (state.events.length === 0) return <div className="placeholder">暂无审计日志</div>;

  return (
    <>
      <div className="list-toolbar admin-list-toolbar" aria-label="审计日志筛选">
        <label className="list-search">
          <span>搜索审计</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索事件、Actor、摘要" />
        </label>
        <div className="segmented compact-segmented" role="tablist" aria-label="审计结果">
          {[
            ['all', '全部'],
            ['allow', 'Allow'],
            ['deny', 'Deny'],
          ].map(([value, label]) => (
            <button className={decision === value ? 'active' : ''} key={value} type="button" onClick={() => setDecision(value)}>
              {label}
            </button>
          ))}
        </div>
        <span className="toolbar-count">{visibleEvents.length} / {state.events.length}</span>
      </div>
      {visibleEvents.length ? (
        <div className="table-shell">
          <table className="admin-table">
            <thead>
              <tr>
                <th>事件</th>
                <th>Actor</th>
                <th>Decision</th>
                <th>摘要</th>
                <th>时间</th>
              </tr>
            </thead>
            <tbody>
              {visibleEvents.map((event) => (
                <tr key={event.id}>
                  <td data-label="事件">
                    <strong>{event.eventType}</strong>
                    <span>{shortId(event.id)}</span>
                  </td>
                  <td data-label="Actor">
                    <strong>{actorLabel(event)}</strong>
                    <span>{shortId(event.actorUserId || event.actorType)}</span>
                  </td>
                  <td data-label="Decision">
                    <span className={event.decision === 'allow' ? 'tag tag-success' : 'tag tag-disabled'}>{event.decision}</span>
                  </td>
                  <td data-label="摘要">
                    <span className="metadata-summary">{auditMetadataSummary(event.metadata)}</span>
                  </td>
                  <td data-label="时间">{formatDate(event.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="placeholder">没有匹配的审计日志</div>
      )}
    </>
  );
}

function filterAuditEvents(events, { query, decision }) {
  const normalizedQuery = query.trim().toLowerCase();
  return events.filter((event) => {
    if (decision !== 'all' && event.decision !== decision) return false;
    if (!normalizedQuery) return true;
    return [event.eventType, event.id, event.actorUserId, event.actorType, event.decision, auditMetadataSummary(event.metadata)]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(normalizedQuery);
  });
}

function actorLabel(event) {
  if (event.actorType === 'system') return '系统';
  if (event.actorType === 'access_key') return 'Access Key';
  return event.actorUserId ? '用户' : event.actorType || '未知';
}

function auditMetadataSummary(metadata) {
  if (!metadata || typeof metadata !== 'object') return '无附加信息';
  const keys = Object.keys(metadata);
  if (!keys.length) return '无附加信息';
  const preferred = ['siteSlug', 'siteId', 'teamId', 'targetTeamId', 'userId', 'action', 'reason'];
  const parts = preferred.filter((key) => metadata[key]).map((key) => `${key}: ${metadata[key]}`);
  if (parts.length) return parts.slice(0, 2).join(' · ');
  return `${keys.length} 个字段`;
}

function shortId(value) {
  const text = String(value || '').trim();
  if (!text) return '-';
  return text.length > 18 ? `${text.slice(0, 10)}...${text.slice(-5)}` : text;
}
