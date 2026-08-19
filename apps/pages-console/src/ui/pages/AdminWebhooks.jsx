import { AlertTriangle, CheckCircle2, FileClock, Plus, Power, RefreshCw, Send, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  createAdminWebhook,
  disableAdminWebhook,
  listAdminWebhookDeliveries,
  listAdminWebhooks,
  updateAdminWebhook,
} from '../api.js';
import { getTemplateVariableWarnings } from '../admin-webhook-model.js';

const DEFAULT_TEMPLATE = JSON.stringify(
  {
    text: 'XD Cell: {{event.type}} {{site.slug}}',
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
  ['deployment.failureStage', '<deployment.failureStage>'],
  ['deployment.errorCode', '<deployment.errorCode>'],
  ['change.field', '<change.field>'],
  ['change.previousValue', '<change.previousValue>'],
  ['change.currentValue', '<change.currentValue>'],
]);

export function AdminWebhooks() {
  const [state, setState] = useState({ status: 'loading', webhooks: [], supportedEvents: [], error: null });
  const [dialog, setDialog] = useState(null);
  const [deliveries, setDeliveries] = useState({ status: 'idle', webhook: null, items: [], error: null });

  const loadWebhooks = useCallback(() => {
    setState((current) => ({ ...current, status: 'loading', error: null }));
    return listAdminWebhooks()
      .then((data) => {
        setState({ status: 'ready', webhooks: data.webhooks || [], supportedEvents: data.supportedEvents || [], error: null });
      })
      .catch((error) => {
        setState({ status: 'error', webhooks: [], supportedEvents: [], error });
      });
  }, []);

  useEffect(() => {
    let active = true;
    listAdminWebhooks()
      .then((data) => {
        if (active)
          setState({ status: 'ready', webhooks: data.webhooks || [], supportedEvents: data.supportedEvents || [], error: null });
      })
      .catch((error) => {
        if (active) setState({ status: 'error', webhooks: [], supportedEvents: [], error });
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
          supportedEvents={state.supportedEvents}
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
          supportedEvents={state.supportedEvents}
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

function WebhookTable({ webhooks, supportedEvents, onEdit, onDeliveries, onDisable }) {
  const labels = new Map(supportedEvents.map((event) => [event.type, event.label]));
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
                      {labels.get(event) || event}
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

function WebhookDialog({ dialog, supportedEvents, onClose, onSaved }) {
  const editing = dialog.mode === 'edit';
  const [form, setForm] = useState(() => initialForm(dialog.webhook));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [previewEvent, setPreviewEvent] = useState(() => dialog.webhook?.events?.[0] || 'site.deployed');
  const supportedEventMap = useMemo(() => new Map(supportedEvents.map((item) => [item.type, item])), [supportedEvents]);
  const unsupportedEvents = useMemo(
    () => form.events.filter((event) => !supportedEventMap.has(event)),
    [form.events, supportedEventMap]
  );
  const selectedDescriptor =
    supportedEventMap.get(previewEvent) || supportedEventMap.get(form.events.find((event) => supportedEventMap.has(event)));
  const preview = useMemo(
    () => buildTemplatePreview(form.payloadMode, form.restrictedTemplate, selectedDescriptor),
    [form.payloadMode, form.restrictedTemplate, selectedDescriptor]
  );
  const templateWarnings = useMemo(
    () =>
      form.payloadMode === 'template' ? getTemplateVariableWarnings(form.restrictedTemplate, form.events, supportedEvents) : [],
    [form.payloadMode, form.restrictedTemplate, form.events, supportedEvents]
  );

  useEffect(() => {
    if (!form.events.includes(previewEvent) || !supportedEventMap.has(previewEvent)) {
      setPreviewEvent(form.events.find((event) => supportedEventMap.has(event)) || 'site.deployed');
    }
  }, [form.events, previewEvent, supportedEventMap]);

  const setField = (name, value) => setForm((current) => ({ ...current, [name]: value }));
  const toggleEvent = (event) => {
    setForm((current) => {
      const nextEvents = current.events.includes(event)
        ? current.events.filter((item) => item !== event)
        : [...current.events, event];
      return { ...current, events: nextEvents };
    });
  };

  const removeUnsupportedEvent = (event) => {
    setForm((current) => ({ ...current, events: current.events.filter((item) => item !== event) }));
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
              {supportedEvents.map((option) => (
                <label key={option.type}>
                  <input checked={form.events.includes(option.type)} type="checkbox" onChange={() => toggleEvent(option.type)} />
                  <span>
                    <strong>{option.label}</strong>
                    <small>
                      {option.type} · {option.description}
                    </small>
                  </span>
                </label>
              ))}
            </div>
            {unsupportedEvents.length ? (
              <div className="form-warning historical-webhook-events" role="alert">
                <AlertTriangle size={15} />
                <div>
                  <strong>历史不支持事件</strong>
                  <span>请先移除后再保存此订阅。</span>
                  <div className="chip-row">
                    {unsupportedEvents.map((event) => (
                      <span className="tag tag-disabled" key={event}>
                        {event}
                        <button type="button" onClick={() => removeUnsupportedEvent(event)} aria-label={`移除历史事件 ${event}`}>
                          <X size={12} />
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}
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
                {templateWarnings.length ? (
                  <div className="form-warning historical-webhook-events" role="alert">
                    <AlertTriangle size={15} />
                    <div>
                      <strong>模板变量可能缺失</strong>
                      <span>以下变量在列出的事件中可能不存在，使用精确变量模板时该次投递会失败：</span>
                      <ul>
                        {templateWarnings.map(({ path, events }) => (
                          <li key={path}>
                            <code>{`{{${path}}}`}</code>：{events.map((event) => `${event.label} (${event.type})`).join('、')}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                ) : null}
              </label>
            ) : (
              <div className="field">
                <span>标准 payload</span>
                {form.events.filter((event) => supportedEventMap.has(event)).length > 1 ? (
                  <select
                    value={previewEvent}
                    onChange={(event) => setPreviewEvent(event.target.value)}
                    aria-label="选择预览事件"
                  >
                    {form.events
                      .filter((event) => supportedEventMap.has(event))
                      .map((event) => (
                        <option key={event} value={event}>
                          {supportedEventMap.get(event).label} · {event}
                        </option>
                      ))}
                  </select>
                ) : null}
                <pre className="code-preview">{preview.standardText}</pre>
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
            <button
              className="primary-button"
              type="submit"
              disabled={saving || unsupportedEvents.length > 0 || form.events.length === 0}
            >
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

function buildTemplatePreview(payloadMode, templateText, descriptor) {
  const standardText = descriptor ? JSON.stringify(buildStandardPreview(descriptor), null, 2) : STANDARD_PAYLOAD_PREVIEW;
  if (payloadMode === 'standard') return { text: standardText, standardText, error: false };
  try {
    const parsed = JSON.parse(templateText || '{}');
    return {
      text: JSON.stringify(renderPreviewValue(parsed), null, 2),
      standardText,
      error: false,
    };
  } catch {
    return {
      text: 'JSON_INVALID',
      standardText,
      error: true,
    };
  }
}

function buildStandardPreview(descriptor) {
  const payload = {};
  const paths = [...(descriptor.requiredTemplateVariables || []), ...(descriptor.optionalTemplateVariables || [])];
  for (const path of paths) {
    const parts = path.split('.');
    let cursor = payload;
    for (const part of parts.slice(0, -1)) cursor = cursor[part] ||= {};
    cursor[parts.at(-1)] = TEMPLATE_PREVIEW_VALUES.get(path) || `<${path}>`;
  }
  return payload;
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
