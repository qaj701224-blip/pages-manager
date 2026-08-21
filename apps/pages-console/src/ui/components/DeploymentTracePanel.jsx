import { useEffect, useRef, useState } from 'react';

import { getAdminDeploymentTrace } from '../api.js';
import { deploymentTraceEventView } from '../site-display-model.js';

const TRACE_STATUS_TONES = new Set(['succeeded', 'failed', 'compensated', 'skipped']);

export function DeploymentTracePanel({ deploymentId, open }) {
  const mounted = useRef(true);
  const activeDeploymentId = useRef(deploymentId);
  const activeRequest = useRef(null);
  const [state, setState] = useState({ status: 'idle', data: null, error: null });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (activeDeploymentId.current === deploymentId) return;
    activeDeploymentId.current = deploymentId;
    activeRequest.current = null;
    setState({ status: 'idle', data: null, error: null });
  }, [deploymentId]);

  useEffect(() => {
    if (!open || state.status !== 'idle') return;
    if (activeRequest.current?.deploymentId === deploymentId) return;
    setState({ status: 'loading', data: null, error: null });
    const request = getAdminDeploymentTrace(deploymentId);
    activeRequest.current = { deploymentId, request };
    request
      .then((data) => {
        if (mounted.current && activeRequest.current?.request === request) {
          setState({ status: 'ready', data, error: null });
        }
      })
      .catch((error) => {
        if (activeRequest.current?.request !== request) return;
        activeRequest.current = null;
        if (mounted.current) setState({ status: 'error', data: null, error });
      });
  }, [deploymentId, open, state.status]);

  if (!open) return null;

  if (state.status === 'loading') {
    return <div className="deployment-trace-panel placeholder">加载部署时间线…</div>;
  }

  if (state.status === 'error') {
    return (
      <div className="deployment-trace-panel deployment-trace-error" role="alert">
        <strong>部署时间线加载失败</strong>
        <span>{state.error?.code || 'API_REQUEST_FAILED'}</span>
        {state.error?.message ? <span>{state.error.message}</span> : null}
        {state.error?.action ? <span>{state.error.action}</span> : null}
        <button className="secondary-button" type="button" onClick={() => setState({ status: 'idle', data: null, error: null })}>
          重试
        </button>
      </div>
    );
  }

  if (state.status !== 'ready') return null;

  const deployment = state.data?.deployment || {};
  const events = Array.isArray(state.data?.events) ? state.data.events : [];

  return (
    <section className="deployment-trace-panel" aria-label={`部署 ${deploymentId} 时间线`}>
      <DeploymentTraceSummary deployment={deployment} />
      {events.length === 0 ? (
        <div className="deployment-trace-empty">该部署没有阶段事件，仅可查看终态摘要</div>
      ) : (
        <div className="deployment-trace-table-shell">
          <table className="deployment-trace-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>阶段</th>
                <th>状态</th>
                <th>耗时</th>
                <th>操作</th>
                <th>错误 / 影响</th>
                <th>Provider Request ID</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <DeploymentTraceEventRow event={event} key={event.id} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function DeploymentTraceSummary({ deployment }) {
  const rows = [
    ['Trace ID', deployment.traceId],
    ['Inbound Ray ID', deployment.inboundRayId],
    ['终态', deployment.status],
    ['失败阶段', deployment.failureStage],
    ['错误码', deployment.errorCode],
    ['错误说明', deployment.errorMessage],
  ].filter(([, value]) => value);

  if (!rows.length) return null;
  return (
    <div className="deployment-trace-summary">
      {rows.map(([label, value]) => (
        <span key={label} title={String(value)}>
          <strong>{label}</strong>
          {value}
        </span>
      ))}
    </div>
  );
}

function DeploymentTraceEventRow({ event }) {
  const view = deploymentTraceEventView(event);
  const statusTone = TRACE_STATUS_TONES.has(view.statusCode) ? view.statusCode : 'unknown';
  const impactRows = [
    ['错误', view.error, view.errorTitle],
    ['Provider', view.provider, view.providerTitle],
    ['影响', view.impact, view.impact === '-' ? '' : view.impact],
    ['建议', view.operatorAction, view.operatorAction === '-' ? '' : view.operatorAction],
    ['清理', view.cleanup, view.cleanup === '-' ? '' : view.cleanup],
    ['补偿', view.compensation, view.compensation === '-' ? '' : view.compensation],
  ].filter(([, value]) => value !== '-');

  return (
    <tr>
      <td data-label="时间" title={view.timeTitle}>
        {formatTraceTime(view.time)}
      </td>
      <td data-label="阶段">{view.stage}</td>
      <td data-label="状态">
        <span className={`deployment-trace-status ${statusTone}`}>{view.status}</span>
      </td>
      <td data-label="耗时">{view.duration}</td>
      <td className="deployment-trace-value" data-label="操作" title={view.operation === '-' ? '' : view.operation}>
        {view.operation}
      </td>
      <td data-label="错误 / 影响">
        {impactRows.length ? (
          <div className="deployment-trace-impact">
            {impactRows.map(([label, value, title]) => (
              <span key={label} title={title}>
                <strong>{label}</strong>
                {value}
              </span>
            ))}
          </div>
        ) : (
          '—'
        )}
      </td>
      <td className="deployment-trace-value" data-label="Provider Request ID" title={view.providerRequestIdTitle}>
        {view.providerRequestId}
      </td>
    </tr>
  );
}

function formatTraceTime(value) {
  if (!value || value === '-') return '-';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(value));
  } catch {
    return value;
  }
}
