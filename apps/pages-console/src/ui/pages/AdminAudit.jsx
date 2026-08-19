import { Copy, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import {
  auditActorView,
  auditEventLabel,
  auditMetadataSummary,
  filterAuditEvents,
  serializeAuditMetadata,
  shortId,
} from '../admin-audit-model.js';
import { listAdminAuditEvents } from '../api.js';
import { AdminError, formatDate } from './AdminDashboard.jsx';

export function AdminAudit() {
  const [state, setState] = useState({ status: 'loading', events: [], error: null });
  const [query, setQuery] = useState('');
  const [decision, setDecision] = useState('all');
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [copyState, setCopyState] = useState(null);

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

  const visibleEvents = useMemo(() => filterAuditEvents(state.events, { query, decision }), [state.events, query, decision]);

  const copyValue = async (label, value) => {
    try {
      if (!value || !navigator.clipboard?.writeText) throw new Error('CLIPBOARD_UNAVAILABLE');
      await navigator.clipboard.writeText(value);
      setCopyState(label);
      setTimeout(() => setCopyState(null), 1600);
    } catch {
      setCopyState('复制失败');
      setTimeout(() => setCopyState(null), 1600);
    }
  };

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
        <span className="toolbar-count">
          {visibleEvents.length} / {state.events.length}
        </span>
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
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {visibleEvents.map((event) => {
                const actor = auditActorView(event);
                const label = auditEventLabel(event.eventType);
                return (
                  <tr key={event.id}>
                    <td data-label="事件">
                      <strong>{label.title}</strong>
                      <span>{label.technical}</span>
                      <span>{shortId(event.id)}</span>
                    </td>
                    <td data-label="操作人">
                      <strong>{actor.primary}</strong>
                      <span>{actor.secondary}</span>
                    </td>
                    <td data-label="Decision">
                      <span className={event.decision === 'allow' ? 'tag tag-success' : 'tag tag-disabled'}>
                        {event.decision}
                      </span>
                    </td>
                    <td data-label="摘要">
                      <span className="metadata-summary">{auditMetadataSummary(event)}</span>
                    </td>
                    <td data-label="时间">{formatDate(event.createdAt)}</td>
                    <td data-label="操作">
                      <button
                        className="secondary-button compact"
                        type="button"
                        aria-label="查看审计事件详情"
                        onClick={() => setSelectedEvent(event)}
                      >
                        查看详情
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="placeholder">没有匹配的审计日志</div>
      )}

      {selectedEvent ? (
        <AuditDetailDialog
          event={selectedEvent}
          copyState={copyState}
          onCopy={copyValue}
          onClose={() => setSelectedEvent(null)}
        />
      ) : null}
    </>
  );
}

function AuditDetailDialog({ event, copyState, onCopy, onClose }) {
  const label = auditEventLabel(event.eventType);
  const metadataText = serializeAuditMetadata(event.metadata);
  const actor = auditActorView(event);
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="dialog audit-detail-panel" role="dialog" aria-modal="true" aria-labelledby="audit-detail-title">
        <div className="dialog-head">
          <div>
            <p>{label.technical}</p>
            <h2 id="audit-detail-title">{label.title}</h2>
          </div>
          <button className="icon-button compact" type="button" title="关闭" aria-label="关闭详情" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
        <div className="dialog-body">
          <div className="detail-grid">
            <DetailField label="操作人" value={`${actor.primary} · ${actor.secondary}`} />
            <DetailField label="Decision" value={`${event.decision} · ${event.statusCode ?? '无 HTTP status'}`} />
            <DetailField label="发生时间" value={formatDate(event.createdAt)} />
            <CopyField label="事件 ID" value={event.id} onCopy={onCopy} />
            {event.siteId ? <CopyField label="siteId" value={event.siteId} onCopy={onCopy} /> : null}
            {event.routeId ? <CopyField label="routeId" value={event.routeId} onCopy={onCopy} /> : null}
            {event.versionId ? <CopyField label="versionId" value={event.versionId} onCopy={onCopy} /> : null}
          </div>
          <div className="field">
            <span>脱敏 metadata</span>
            <pre className="code-preview audit-detail-metadata">{metadataText}</pre>
            <button className="secondary-button compact" type="button" onClick={() => onCopy('复制 metadata', metadataText)}>
              <Copy size={14} />
              {copyState === '复制 metadata' ? '已复制' : '复制 metadata'}
            </button>
          </div>
          {copyState === '复制失败' ? <div className="form-error">复制失败，请检查浏览器权限。</div> : null}
        </div>
      </section>
    </div>
  );
}

function DetailField({ label, value }) {
  return (
    <div className="detail-field">
      <span>{label}</span>
      <strong>{value || '-'}</strong>
    </div>
  );
}

function CopyField({ label, value, onCopy }) {
  return (
    <div className="detail-field detail-field-copy">
      <span>{label}</span>
      <div>
        <strong>{value}</strong>
        <button
          className="icon-button compact"
          type="button"
          title={`复制${label}`}
          aria-label={`复制${label}`}
          onClick={() => onCopy(`复制${label}`, value)}
        >
          <Copy size={13} />
        </button>
      </div>
    </div>
  );
}
