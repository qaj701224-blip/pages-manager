import { classifySlackIntake } from './intake.js';
import { slackUserIdFromBody, surfaceForSlackBody } from './session.js';

export function stableSlugHash(value = '') {
  let hash = 2166136261;
  for (const char of String(value || '')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).padStart(6, '0').slice(0, 6);
}

function slugSegment(value, fallback, maxLength = 48) {
  const normalized = String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replaceAll(/[\u0300-\u036f]/g, '')
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .replaceAll(/-{2,}/g, '-');
  const slug = normalized || fallback;
  return slug.slice(0, maxLength).replaceAll(/-+$/g, '') || fallback;
}

function requesterSlugBase(profileInput = {}, slackUserId) {
  const profile = profileInput || {};
  const email = String(profile.email || '')
    .trim()
    .toLowerCase();
  if (email.includes('@')) return email.split('@')[0].split('+')[0];
  return profile.displayName || profile.display_name || profile.realName || profile.real_name || profile.name || slackUserId;
}

export function employeeSlugForSlack({ teamId, slackUserId, requesterProfile }) {
  const identityKey = `${teamId || 'unknown-team'}:${slackUserId || 'unknown-user'}`;
  const suffix = stableSlugHash(identityKey);
  const base = slugSegment(requesterSlugBase(requesterProfile, slackUserId), 'slack-user', 40);
  return `${base}-${suffix}`;
}

export function siteSlugForSlack(analysis = {}, body = {}) {
  return slugSegment(analysis.siteSlug || analysis.site_slug || body.siteSlug || body.site_slug || 'profile', 'profile', 72);
}

export function slackJobInput(body) {
  const event = body.event || {};
  const analysis = body.slackAgentAnalysis || {};
  const slackSession = body.slackSession || null;
  const teamId = body.team_id || body.team?.id || 'unknown-team';
  const slackUserId = slackUserIdFromBody(body);
  const intake = body.intake || classifySlackIntake(body);
  const surface = surfaceForSlackBody(body);
  const text = intake.text || event.text || body.text || '';
  const idempotencyKey =
    body.idempotencyKey ||
    body.idempotency_key ||
    body.event_id ||
    body.trigger_id ||
    `${teamId}:${event.ts || body.event_ts || Date.now()}`;
  const requesterProfile = body.requesterProfile || body.requester_profile || null;

  return {
    source: 'slack',
    requestedByType: 'user',
    requestedById: `slack:${teamId}:${slackUserId}`,
    idempotencyKey,
    employeeSlug: employeeSlugForSlack({ teamId, slackUserId, requesterProfile }),
    siteSlug: siteSlugForSlack(analysis, body),
    intent: analysis.intent || 'create_site',
    approvalMode: analysis.approvalMode || body.approvalMode || body.approval_mode || 'manual_required',
    title: body.title || analysis.title || text.slice(0, 80) || 'Slack publishing request',
    summary: body.summary || analysis.summary || text,
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
