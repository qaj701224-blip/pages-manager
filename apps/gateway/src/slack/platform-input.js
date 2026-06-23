import { slackUserIdFromBody, surfaceForSlackBody } from './session.js';

const HIGH_RISK_TYPE_SET = new Set(['type:ci', 'type:ops', 'type:security']);
const FEEDBACK_TYPE_SET = new Set(['type:feedback', 'type:question']);

function normalizeLabel(value, prefix, fallback) {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  const normalized = raw.startsWith(`${prefix}:`) ? raw : `${prefix}:${raw}`;
  return normalized.toLowerCase().replaceAll(/\s+/g, '-');
}

export function normalizePlatformIssueType(value) {
  const normalized = normalizeLabel(value, 'type', 'type:dev');
  if (
    [
      'type:dev',
      'type:bug',
      'type:docs',
      'type:feedback',
      'type:question',
      'type:ci',
      'type:ops',
      'type:security',
    ].includes(normalized)
  ) {
    return normalized;
  }
  return 'type:dev';
}

export function normalizePlatformRisk(value, issueType = 'type:dev') {
  if (HIGH_RISK_TYPE_SET.has(issueType)) return 'risk:high';
  const normalized = normalizeLabel(value, 'risk', 'risk:medium');
  if (['risk:low', 'risk:medium', 'risk:high'].includes(normalized)) return normalized;
  return 'risk:medium';
}

export function normalizePlatformAreas(value) {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const areas = raw
    .map((item) => normalizeLabel(item, 'area', ''))
    .filter(Boolean)
    .filter((item, index, list) => list.indexOf(item) === index)
    .slice(0, 16);
  return areas.length ? areas : ['area:platform'];
}

export function platformDevInput(body = {}) {
  const event = body.event || {};
  const analysis = body.slackAgentAnalysis || {};
  const slackSession = body.slackSession || null;
  const teamId = body.team_id || body.team?.id || 'unknown-team';
  const slackUserId = slackUserIdFromBody(body);
  const intake = body.intake || {};
  const surface = surfaceForSlackBody(body);
  const text = intake.text || event.text || body.text || analysis.summary || '';
  const idempotencyKey =
    body.idempotencyKey ||
    body.idempotency_key ||
    body.event_id ||
    body.trigger_id ||
    `${teamId}:${event.ts || body.event_ts || Date.now()}`;
  const issueType = normalizePlatformIssueType(analysis.issueType || analysis.issue_type || body.issueType || body.issue_type);
  const risk = normalizePlatformRisk(analysis.risk || body.risk, issueType);
  const agentEligible =
    typeof analysis.agentEligible === 'boolean'
      ? analysis.agentEligible
      : typeof analysis.agent_eligible === 'boolean'
        ? analysis.agent_eligible
        : !FEEDBACK_TYPE_SET.has(issueType);
  const requiresHumanGate =
    typeof analysis.requiresHumanGate === 'boolean'
      ? analysis.requiresHumanGate
      : typeof analysis.requires_human_gate === 'boolean'
        ? analysis.requires_human_gate
        : risk === 'risk:high' || HIGH_RISK_TYPE_SET.has(issueType);
  const requesterProfile = body.requesterProfile || body.requester_profile || null;

  return {
    source: 'slack',
    requestedByType: 'user',
    requestedById: `slack:${teamId}:${slackUserId}`,
    idempotencyKey,
    title: body.title || analysis.title || String(text).slice(0, 100) || 'pages-manager 平台改造需求',
    summary: body.summary || analysis.summary || text,
    issueType,
    areas: normalizePlatformAreas(analysis.areas || analysis.areaLabels || analysis.area_labels || body.areas),
    risk,
    agentEligible,
    requiresHumanGate,
    gateStatus: requiresHumanGate ? 'pending' : 'not_required',
    gateReason: requiresHumanGate ? '高风险或敏感范围需要人工确认后再进入自动开发。' : null,
    requesterProfile,
    slackSessionId: slackSession?.id || body.slackSessionId || null,
    slackSessionKey: slackSession?.sessionKey || body.slackSessionKey || null,
    slackThread: {
      teamId,
      channelId: surface.channelId,
      channelType: surface.channelType,
      messageTs: surface.messageTs,
      threadTs: surface.threadTs,
      userId: slackUserId,
    },
  };
}
