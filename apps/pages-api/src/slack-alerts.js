const GITHUB_ACTIONS_URL = 'https://github.com/xindong/pages-manager/actions';
const ALERT_FALLBACK_TEXT = 'Legacy Worker 池容量不足，需要迁移到 WFP';
const DEFAULT_MENTION_USER_ID = 'U06QLFY2XCK';

export async function notifyDeploymentCapacityExhausted(env, config, { store }) {
  const capacity = await readWorkerSlotCapacity(store, config.environment);
  const payload = buildCapacityExhaustedPayload({
    environment: config.environment,
    mentionUserId: env.SLACK_PAGES_ALERT_MENTION_USER_ID || DEFAULT_MENTION_USER_ID,
    currentCapacity: capacity,
  });

  try {
    return await sendSlackAlert(env, payload);
  } catch {
    return { sent: false, reason: 'send_failed' };
  }
}

export function buildCapacityExhaustedPayload({ environment, mentionUserId, currentCapacity }) {
  const mention = formatMention(mentionUserId);
  return {
    text: ALERT_FALLBACK_TEXT,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: 'Legacy Worker 池容量不足',
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${mention}*XD Cell legacy Worker 池不可用，请确认新发布走 WFP 并迁移存量站点。*`,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*环境*\n${escapeSlackText(environment)}` },
          { type: 'mrkdwn', text: `*容量*\n${formatWorkerCapacity(currentCapacity)}` },
          { type: 'mrkdwn', text: `*剩余*\n${formatAvailableWorkers(currentCapacity)}` },
          { type: 'mrkdwn', text: '*建议*\n迁移/重发到 WFP' },
        ],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: '打开运维 Actions',
              emoji: true,
            },
            url: GITHUB_ACTIONS_URL,
          },
        ],
      },
    ],
  };
}

export async function sendSlackAlert(env, payload) {
  const webhookUrl = normalizeSlackWebhookUrl(env.SLACK_PAGES_ALERT_WEBHOOK_URL);
  if (!webhookUrl) return { sent: false, reason: 'webhook_not_configured' };

  const fetchImpl = env.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return { sent: false, reason: 'fetch_unavailable' };

  const response = await fetchImpl(
    new Request(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  );
  if (!response.ok) throw new Error('SLACK_WEBHOOK_FAILED');
  return { sent: true, status: response.status };
}

async function readWorkerSlotCapacity(store, environment) {
  if (!store || typeof store.listWorkerSlots !== 'function') return null;
  try {
    const slots = await store.listWorkerSlots(environment);
    const total = slots.length;
    const used = slots.filter((slot) => slot.status !== 'available').length;
    const available = slots.filter((slot) => slot.status === 'available').length;
    return { used, total, available };
  } catch {
    return null;
  }
}

function normalizeSlackWebhookUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'hooks.slack.com' ||
    !url.pathname.startsWith('/services/') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return null;
  }
  return url.toString();
}

function formatMention(value) {
  const userId = String(value || '').trim();
  if (!/^U[A-Z0-9]+$/.test(userId)) return '';
  return `<@${userId}> `;
}

function formatWorkerCapacity(value) {
  if (!value || !Number.isFinite(value.used) || !Number.isFinite(value.total)) return 'unknown';
  return `已用 ${value.used} / 总计 ${value.total}`;
}

function formatAvailableWorkers(value) {
  if (!value || !Number.isFinite(value.available)) return 'unknown';
  return String(value.available);
}

function escapeSlackText(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
