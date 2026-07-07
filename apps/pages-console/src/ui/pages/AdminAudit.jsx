import { useEffect, useMemo, useState } from 'react';

import { auditActorView, auditMetadataSummary, filterAuditEvents, shortId } from '../admin-audit-model.js';
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
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索事件、操作人、摘要" />
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
                <th>操作人</th>
                <th>Decision</th>
                <th>摘要</th>
                <th>时间</th>
              </tr>
            </thead>
            <tbody>
              {visibleEvents.map((event) => {
                const actor = auditActorView(event);
                return (
                  <tr key={event.id}>
                    <td data-label="事件">
                      <strong>{event.eventType}</strong>
                      <span>{shortId(event.id)}</span>
                    </td>
                    <td data-label="操作人">
                      <strong>{actor.primary}</strong>
                      <span>{actor.secondary}</span>
                    </td>
                    <td data-label="Decision">
                      <span className={event.decision === 'allow' ? 'tag tag-success' : 'tag tag-disabled'}>{event.decision}</span>
                    </td>
                    <td data-label="摘要">
                      <span className="metadata-summary">{auditMetadataSummary(event.metadata)}</span>
                    </td>
                    <td data-label="时间">{formatDate(event.createdAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="placeholder">没有匹配的审计日志</div>
      )}
    </>
  );
}
