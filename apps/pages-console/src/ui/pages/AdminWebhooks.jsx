import { AlertTriangle, CheckCircle2, FileClock, Plus, Power, RefreshCw, Send, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  createAdminWebhook,
  disableAdminWebhook,
  listAdminWebhookDeliveries,
  listAdminWebhooks,
  updateAdminWebhook,
} from '../api.js';

const EVENT_OPTIONS = [
  { value: 'site.deployed', label: 'site.deployed' },
];

const DEFAULT_TEMPLATE = JSON.stringify(
  {
    text: 'XD Cell: {{site.slug}} {{deployment.status}} by {{actor.email}}',
  },
  null,
  2
);

const STANDARD_PAYLOAD_PREVIEW = JSON.stringify(
  {
    event: {
      id: '<event.id>',
      type: '<event.type>',
      environment: '<event.environment>',
      occurredAt: '<event.occurredAt>',
    },
    actor: {
      type: '<actor.type>',
      userId: '<actor.userId>',
      email: '<actor.email>',
    },
    site: {
      id: '<site.id>',
      slug: '<site.slug>',
      hostname: '<site.hostname>',
      ownerType: '<site.ownerType>',
      visibility: '<site.visibility>',
      status: '<site.status>',
    },
    deployment: {
      id: '<deployment.id>',
      status: '<deployment.status>',
      source: '<deployment.source>',
      operation: '<deployment.operation>',
    },
  },
  null,
  2
);

const TEMPLATE_PREVIEW_VALUES = new Map([
  ['event.id', '<event.id>'],
  ['event.type', '<event.type>'],
  ['event.environment', '<event.environment>'],
  ['event.occurredAt', '<event.occurredAt>'],
  ['actor.type', '<actor.type>'],
  ['actor.userId', '<actor.userId>'],
  ['actor.email', '<actor.email>'],
  ['actor.name', '<actor.name>'],
  ['site.id', '<site.id>'],
  ['site.slug', '<site.slug>'],
  ['site.hostname', '<site.hostname>'],
  ['site.ownerType', '<site.ownerType>'],
  ['site.ownerId', '<site.ownerId>'],
  ['site.visibility', '<site.visibility>'],
  ['site.status', '<site.status>'],
  ['team.id', '<team.id>'],
  ['team.name', '<team.name>'],
  ['team.teamType', '<team.teamType>'],
  ['deployment.id', '<deployment.id>'],
  ['deployment.status', '<deployment.status>'],
  ['deployment.source', '<deployment.source>'],
  ['deployment.operation', '<deployment.operation>'],
  ['deployment.createdAt', '<deployment.createdAt>'],
  ['deployment.completedAt', '<deployment.completedAt>'],
]);

export function AdminWebhooks() {
  const [state, setState] = useState({ status: 'loading', webhooks: [], error: null });
  const [dialog, setDialog] = useState(null);
  const [deliveries, setDeliveries] = useState({ status: 'idle', webhook: null, items: [], error: null });

  const loadWebhooks = useCallback(() => {
    setState((current) => ({ ...current, status: 'loading', error: null }));
    return listAdminWebhooks()
      .then((data) => {
        setState({ status: 'ready', webhooks: data.webhooks || [], error: null });
      })
      .catch((error) => {
        setState({ status: 'error', webhooks: [], error });
      });
  }, []);

  useEffect(() => {
    let active = true;
    listAdminWebhooks()
      .then((data) => {
        if (active) setState({ status: 'ready', webhooks: data.webhooks || [], error: null });
      })
      .catch((error) => {
        if (active) setState({ status: 'error', webhooks: [], error });
      });
    return () => {
      active = false;
    };
  }, []);

  const openDeliveries = (webhook) => {
    setDeliveries({ status: 'loading', webhook, items: [], error: null });
    listAdminWebhookDeliveries(webhook.id)
      .then((data) => {
        setDeliveries({ status: 'ready', webhook, items: data.deliveries || [], error: null });
      })
      .catch((error) => {
        setDeliveries({ status: 'error', webhook, items: [], error });
      });
  };

  const handleDisable = async (webhook) => {
    if (typeof window !== 'undefined' && !window.confirm(`停用 ${webhook.name}？`)) return;
    await disableAdminWebhook(webhook.id);
    await loadWebhooks();
  };

  return (
    <div className="admin-stack">
      <div className="admin-toolbar">
        <button className="primary-button" type="button" onClick={() => setDialog({ mode: 'create', webhook: null })}>
          <Plus size={16} />
          <span>新建 Webhook</span>
        </button>
        <button className="secondary-button" type="button" onClick={loadWebhooks}>
          <RefreshCw size={15} />
          <span>刷新</span>
        </button>
      </div>

      {state.status === 'loading' ? (
        <div className="placeholder">加载中</div>
      ) : state.status === 'error' ? (
        <div className="empty-panel warning">
          <AlertTriangle size={18} />
          <strong>Webhook 加载失败</strong>
          <span>{state.error?.code || 'API_REQUEST_FAILED'}</span>
        </div>
      ) : state.webhooks.length === 0 ? (
        <div className="empty-panel">
          <Send size={22} />
          <strong>还没有 Webhook</strong>
          <button className="secondary-button" type="button" onClick={() => setDialog({ mode: 'create', webhook: null })}>
            <Plus size={15} />
            <span>新建 Webhook</span>
          </button>
        </div>
      ) : (
        <WebhookTable
          webhooks={state.webhooks}
          onEdit={(webhook) => setDialog({ mode: 'edit', webhook })}
          onDeliveries={openDeliveries}
          onDisable={handleDisable}
        />
      )}

      {deliveries.webhook ? (
        <DeliveriesPanel
          state={deliveries}
          onClose={() => setDeliveries({ status: 'idle', webhook: null, items: [], error: null })}
        />
      ) : null}

      {dialog ? (
        <WebhookDialog
          dialog={dialog}
          onClose={() => setDialog(null)}
          onSaved={async () => {
            setDialog(null);
            await loadWebhooks();
          }}
        />
      ) : null}
    </div>
  );
}

function WebhookTable({ webhooks, onEdit, onDeliveries, onDisable }) {
  return (
    <div className="table-shell">
      <table className="admin-table">
        <thead>
          <tr>
            <th>名称</th>
            <th>Target</th>
            <th>事件</th>
            <th>Payload</th>
            <th>状态</th>
            <th>最后投递</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {webhooks.map((webhook) => (
            <tr key={webhook.id}>
              <td data-label="名称">
                <strong>{webhook.name}</strong>
                <span>{webhook.urlMasked}</span>
              </td>
              <td data-label="Target">{webhook.urlHost}</td>
              <td data-label="事件">
                <div className="chip-row">
                  {webhook.events.map((event) => (
                    <span className="tag muted" key={event}>
                      {event}
                    </span>
                  ))}
                </div>
              </td>
              <td data-label="Payload">{webhook.payloadMode === 'template' ? '受限模板' : '标准 payload'}</td>
              <td data-label="状态">
                <StatusTag active={webhook.enabled} />
              </td>
              <td data-label="最后投递">{webhook.lastDeliveryStatus || '暂无'}</td>
              <td data-label="操作">
                <div className="action-row">
                  <button className="icon-button compact" type="button" title="编辑" onClick={() => onEdit(webhook)}>
                    <Send size={14} />
                  </button>
                  <button className="icon-button compact" type="button" title="投递记录" onClick={() => onDeliveries(webhook)}>
                    <FileClock size={14} />
                  </button>
                  {webhook.enabled ? (
                    <button className="icon-button compact" type="button" title="停用" onClick={() => onDisable(webhook)}>
                      <Power size={14} />
                    </button>
                  ) : null}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WebhookDialog({ dialog, onClose, onSaved }) {
  const editing = dialog.mode === 'edit';
  const [form, setForm] = useState(() => initialForm(dialog.webhook));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const preview = useMemo(
    () => buildTemplatePreview(form.payloadMode, form.restrictedTemplate),
    [form.payloadMode, form.restrictedTemplate]
  );

  const setField = (name, value) => setForm((current) => ({ ...current, [name]: value }));
  const toggleEvent = (event) => {
    setForm((current) => {
      const nextEvents = current.events.includes(event)
        ? current.events.filter((item) => item !== event)
        : [...current.events, event];
      return { ...current, events: nextEvents };
    });
  };

  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const body = buildSubmitBody(form, { editing });
      if (editing) {
        await updateAdminWebhook(dialog.webhook.id, body);
      } else {
        await createAdminWebhook(body);
      }
      await onSaved();
    } catch (submitError) {
      setError(submitError);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="webhook-dialog-title">
        <div className="dialog-head">
          <div>
            <p>{editing ? '编辑 Webhook' : '新建 Webhook'}</p>
            <h2 id="webhook-dialog-title">{form.name || 'Webhook'}</h2>
          </div>
          <button className="icon-button compact" type="button" title="关闭" onClick={onClose}>
            <X size={15} />
          </button>
        </div>

        <form className="dialog-body" onSubmit={submit}>
          <div className="form-grid">
            <label className="field">
              <span>名称</span>
              <input value={form.name} onChange={(event) => setField('name', event.target.value)} required />
            </label>
            <label className="field">
              <span>Webhook URL</span>
              <input
                value={form.url}
                onChange={(event) => setField('url', event.target.value)}
                placeholder={editing ? '留空则不更新 URL' : 'https://hooks.slack.com/services/...'}
                required={!editing}
              />
            </label>
          </div>

          <fieldset className="field-set">
            <legend>订阅事件</legend>
            <div className="checkbox-row">
              {EVENT_OPTIONS.map((option) => (
                <label key={option.value}>
                  <input
                    checked={form.events.includes(option.value)}
                    type="checkbox"
                    onChange={() => toggleEvent(option.value)}
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="segmented webhook-payload-mode" role="tablist" aria-label="Payload mode">
            <button
              className={form.payloadMode === 'standard' ? 'active' : ''}
              type="button"
              onClick={() => setField('payloadMode', 'standard')}
            >
              标准 payload
            </button>
            <button
              className={form.payloadMode === 'template' ? 'active' : ''}
              type="button"
              onClick={() => setField('payloadMode', 'template')}
            >
              受限模板
            </button>
          </div>

          <div className="split-grid">
            {form.payloadMode === 'template' ? (
              <label className="field">
                <span>模板 JSON</span>
                <textarea
                  value={form.restrictedTemplate}
                  onChange={(event) => setField('restrictedTemplate', event.target.value)}
                />
              </label>
            ) : (
              <div className="field">
                <span>标准 payload</span>
                <pre className="code-preview">{STANDARD_PAYLOAD_PREVIEW}</pre>
              </div>
            )}
            <div className="field">
              <span>预览</span>
              <pre className={preview.error ? 'code-preview error' : 'code-preview'}>{preview.text}</pre>
            </div>
          </div>

          {error ? <div className="form-error">{error.code || error.message}</div> : null}

          <div className="dialog-actions">
            <button className="secondary-button" type="button" onClick={onClose}>
              取消
            </button>
            <button className="primary-button" type="submit" disabled={saving}>
              <CheckCircle2 size={15} />
              <span>{saving ? '保存中' : '保存'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function DeliveriesPanel({ state, onClose }) {
  return (
    <section className="delivery-panel">
      <div className="panel-head">
        <div>
          <p>投递记录</p>
          <h2>{state.webhook.name}</h2>
        </div>
        <button className="icon-button compact" type="button" title="关闭" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      {state.status === 'loading' ? (
        <div className="panel-empty">加载中</div>
      ) : state.status === 'error' ? (
        <div className="panel-empty">{state.error?.code || 'API_REQUEST_FAILED'}</div>
      ) : state.items.length === 0 ? (
        <div className="panel-empty">暂无投递记录</div>
      ) : (
        <div className="delivery-list">
          {state.items.map((delivery) => (
            <div className="delivery-row" key={delivery.id}>
              <div>
                <strong>{delivery.eventType}</strong>
                <span>{delivery.id}</span>
              </div>
              <span>{delivery.deliveryStatus}</span>
              <span>{delivery.renderStatus}</span>
              <span>{delivery.httpStatus ?? '无'}</span>
              <span>{formatDate(delivery.createdAt)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function StatusTag({ active }) {
  return <span className={active ? 'tag' : 'tag muted'}>{active ? 'enabled' : 'disabled'}</span>;
}

function initialForm(webhook) {
  return {
    name: webhook?.name || '',
    url: '',
    events: webhook?.events?.length ? webhook.events : ['site.deployed'],
    payloadMode: webhook?.payloadMode || 'standard',
    restrictedTemplate: webhook?.restrictedTemplate ? JSON.stringify(webhook.restrictedTemplate, null, 2) : DEFAULT_TEMPLATE,
  };
}

function buildSubmitBody(form, { editing }) {
  const body = {
    name: form.name.trim(),
    events: form.events,
    payloadMode: form.payloadMode,
  };
  if (form.payloadMode === 'template') body.restrictedTemplate = JSON.parse(form.restrictedTemplate || '{}');
  if (!editing || form.url.trim()) body.url = form.url.trim();
  return body;
}

function buildTemplatePreview(payloadMode, templateText) {
  if (payloadMode === 'standard') return { text: STANDARD_PAYLOAD_PREVIEW, error: false };
  try {
    const parsed = JSON.parse(templateText || '{}');
    return {
      text: JSON.stringify(renderPreviewValue(parsed), null, 2),
      error: false,
    };
  } catch {
    return {
      text: 'JSON_INVALID',
      error: true,
    };
  }
}

function renderPreviewValue(value) {
  if (typeof value === 'string') {
    return value.replace(/{{\s*([A-Za-z0-9_.]+)\s*}}/g, (_match, variable) => TEMPLATE_PREVIEW_VALUES.get(variable) || '');
  }
  if (Array.isArray(value)) return value.map(renderPreviewValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entryValue]) => [key, renderPreviewValue(entryValue)]));
  }
  return value;
}

function formatDate(value) {
  if (!value) return '无';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  } catch {
    return value;
  }
}
