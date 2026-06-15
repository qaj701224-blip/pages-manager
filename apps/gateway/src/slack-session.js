const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const SESSION_ID_RE = /\bsess_[A-Za-z0-9_]+\b/;
const JOB_ID_RE = /\bjob_[A-Za-z0-9_]+\b/;

function numberFromEnv(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function addMs(now, durationMs) {
  return new Date(now.getTime() + durationMs).toISOString();
}

export function readSlackSessionConfig(env = {}) {
  const activeContextTtlHours =
    env.SLACK_AGENT_ACTIVE_CONTEXT_TTL_HOURS !== undefined
      ? numberFromEnv(env.SLACK_AGENT_ACTIVE_CONTEXT_TTL_HOURS, 2)
      : numberFromEnv(env.SLACK_AGENT_ACTIVE_CONTEXT_TTL_DAYS, 0) * 24 || 2;

  return {
    activeContextTtlMs: activeContextTtlHours * HOUR_MS,
    waitingClarificationTtlMs: numberFromEnv(env.SLACK_AGENT_WAITING_CLARIFICATION_TTL_DAYS, 1) * DAY_MS,
    recentSessionWindowMs: numberFromEnv(env.SLACK_AGENT_RECENT_SESSION_DAYS, 14) * DAY_MS,
    archiveAfterMs: numberFromEnv(env.SLACK_AGENT_ARCHIVE_AFTER_DAYS, 90) * DAY_MS,
    slackAgentTurnTimeoutMs: numberFromEnv(env.SLACK_AGENT_TURN_TIMEOUT_SECONDS, 120) * 1000,
    slackAgentSessionLeaseMs: numberFromEnv(env.SLACK_AGENT_SESSION_LEASE_SECONDS, 180) * 1000,
    providerThreadTtlMs: numberFromEnv(env.SLACK_AGENT_PROVIDER_THREAD_TTL_HOURS, 24) * HOUR_MS,
    codingAgentRunTimeoutMs: numberFromEnv(env.CODING_AGENT_RUN_TIMEOUT_MINUTES, 30) * 60 * 1000,
  };
}

export function slackActorFromBody(body = {}) {
  const event = body.event || {};
  const teamId = body.team_id || body.team?.id || event.team || 'unknown-team';
  const slackUserId = slackUserIdFromBody(body);

  return {
    teamId,
    slackUserId,
    requestedById: `slack:${teamId}:${slackUserId}`,
  };
}

function slackIdValue(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, 255) : null;
  }
  if (value && typeof value === 'object') {
    return slackIdValue(value.id || value.user_id || value.user);
  }
  return null;
}

export function slackUserIdFromBody(body = {}, fallback = 'unknown-user') {
  const event = body.event || {};
  return (
    slackIdValue(event.user) ||
    slackIdValue(body.user_id) ||
    slackIdValue(body.user) ||
    slackIdValue(body.source_user_id) ||
    fallback
  );
}

function inferSlackChannelType(channelType, channelId) {
  if (channelType) return channelType;
  return String(channelId || '').startsWith('D') ? 'im' : null;
}

export function surfaceForSlackBody(body = {}) {
  const event = body.event || {};
  const channelId = event.channel || body.channel_id || null;
  const channelType = inferSlackChannelType(event.channel_type || body.channel_type || null, channelId);
  const messageTs = event.ts || body.event_ts || null;
  const threadTs = event.thread_ts || messageTs;
  const dmChannelId = channelType === 'im' ? channelId : null;

  return {
    channelId,
    channelType,
    messageTs,
    threadTs,
    dmChannelId,
    surfaceContext: {
      channelId,
      channelType,
      messageTs,
      threadTs,
      dmChannelId,
    },
  };
}

function explicitReferences(text = '') {
  return {
    sessionId: text.match(SESSION_ID_RE)?.[0] || null,
    jobId: text.match(JOB_ID_RE)?.[0] || null,
  };
}

function isActiveSession(session, now) {
  return (
    session &&
    session.status === 'active' &&
    session.activeContextExpiresAt &&
    new Date(session.activeContextExpiresAt).getTime() > now.getTime()
  );
}

function isRecentSession(session, now, config) {
  if (!session || ['closed', 'archived'].includes(session.status)) return false;
  const lastActiveAt = new Date(session.lastActiveAt || session.updatedAt || session.createdAt || 0).getTime();
  return now.getTime() - lastActiveAt <= config.recentSessionWindowMs;
}

function selectionReply(sessions) {
  const lines = [
    '我找到了多个最近的会话，需要你指定要继续哪一个。',
    '',
    ...sessions.slice(0, 5).map((session, index) => `${index + 1}. ${session.sessionTitle || '未命名会话'}`),
    '',
    '可以继续在对应对话里回复，或者直接描述一个新需求。',
  ];
  return lines.join('\n');
}

function forbiddenReferenceReply(kind) {
  return kind === 'job'
    ? '这个发布任务不属于当前 Slack 用户，不能查看或继续操作。'
    : '这个会话不属于当前 Slack 用户，不能查看或继续操作。';
}

function sessionInputFrom(body, intake, sessionKey, config, now) {
  const actor = slackActorFromBody(body);
  const surface = surfaceForSlackBody(body);

  return {
    teamId: actor.teamId,
    primarySlackUserId: actor.slackUserId,
    sessionKey,
    sessionTitle: intake?.text ? String(intake.text).slice(0, 80) : 'Slack conversation',
    channelId: surface.channelId,
    threadTs: surface.threadTs,
    dmChannelId: surface.dmChannelId,
    surfaceContext: surface.surfaceContext,
    lastIntent: intake?.action || 'unknown',
    activeContextExpiresAt: addMs(now, config.activeContextTtlMs),
    status: 'active',
    closedAt: null,
  };
}

export async function selectSlackSession(store, body = {}, intake = {}, env = {}, options = {}) {
  const now = options.now || new Date();
  const config = readSlackSessionConfig(env);
  const actor = slackActorFromBody(body);
  const surface = surfaceForSlackBody(body);
  const references = explicitReferences(intake.text || body.event?.text || body.text || '');

  if (references.sessionId) {
    const byId = await store.getSlackSession(references.sessionId);
    if (byId && (byId.teamId !== actor.teamId || byId.primarySlackUserId !== actor.slackUserId)) {
      return {
        forbidden: true,
        replyText: forbiddenReferenceReply('session'),
        config,
        action: 'forbidden_cross_user_session',
      };
    }

    if (byId) {
      return {
        session: await store.upsertSlackSession(
          {
            ...byId,
            status: 'active',
            closedAt: null,
            lastIntent: intake.action || byId.lastIntent,
            activeContextExpiresAt: addMs(now, config.activeContextTtlMs),
          },
          now
        ),
        memory: await store.getSessionMemory(references.sessionId),
        config,
        action: 'selected_explicit_session',
      };
    }
  }

  if (references.jobId) {
    const linked = await store.findIssueLinkByJobId(references.jobId);
    const linkedSession = linked ? await store.getSlackSession(linked.slackSessionId) : null;
    if (linkedSession && (linkedSession.teamId !== actor.teamId || linkedSession.primarySlackUserId !== actor.slackUserId)) {
      return {
        forbidden: true,
        replyText: forbiddenReferenceReply('job'),
        config,
        action: 'forbidden_cross_user_job',
      };
    }

    if (linkedSession) {
      const session = await store.upsertSlackSession(
        {
          ...linkedSession,
          status: 'active',
          closedAt: null,
          lastIntent: intake.action || linkedSession.lastIntent,
          activeContextExpiresAt: addMs(now, config.activeContextTtlMs),
        },
        now
      );
      return {
        session,
        memory: await store.getSessionMemory(session.id),
        config,
        action: 'selected_linked_job',
      };
    }
  }

  if (
    surface.channelType === 'im' &&
    surface.threadTs &&
    !['help', 'ping', 'status', 'cancel', 'empty'].includes(intake.action)
  ) {
    const dmThreadKey = `dm-thread:${surface.dmChannelId || 'unknown'}:${surface.threadTs}`;
    const session = await store.upsertSlackSession(sessionInputFrom(body, intake, dmThreadKey, config, now), now);
    return {
      session,
      memory: await store.getSessionMemory(session.id),
      config,
      action: 'selected_dm_thread',
    };
  }

  if (surface.channelType !== 'im') {
    const threadKey = `thread:${surface.channelId || 'unknown'}:${surface.threadTs || surface.messageTs || 'unknown'}`;
    const session = await store.upsertSlackSession(sessionInputFrom(body, intake, threadKey, config, now), now);
    return {
      session,
      memory: await store.getSessionMemory(session.id),
      config,
      action: 'selected_thread',
    };
  }

  if (intake.shouldCreateJob) {
    const messageKey = surface.messageTs || body.event_id || body.trigger_id || String(now.getTime());
    const dmJobKey = `dm:${surface.dmChannelId || 'unknown'}:${messageKey}`;
    const session = await store.upsertSlackSession(sessionInputFrom(body, intake, dmJobKey, config, now), now);
    return {
      session,
      memory: await store.getSessionMemory(session.id),
      config,
      action: 'created_dm_job_session',
    };
  }

  const userSessions = await store.findSlackSessionsForUser(actor.teamId, actor.slackUserId);
  const activeSessions = userSessions.filter((session) => isActiveSession(session, now));
  if (activeSessions.length > 0 && ['help', 'ping', 'status', 'cancel', 'empty'].includes(intake.action)) {
    const session = await store.upsertSlackSession(
      {
        ...activeSessions[0],
        channelId: surface.channelId,
        dmChannelId: surface.dmChannelId,
        surfaceContext: surface.surfaceContext,
        lastIntent: intake.action || activeSessions[0].lastIntent,
        activeContextExpiresAt: addMs(now, config.activeContextTtlMs),
      },
      now
    );
    return {
      session,
      memory: await store.getSessionMemory(session.id),
      config,
      action: 'selected_active_dm_session',
    };
  }

  if (activeSessions.length === 1) {
    const session = await store.upsertSlackSession(
      {
        ...activeSessions[0],
        channelId: surface.channelId,
        dmChannelId: surface.dmChannelId,
        surfaceContext: surface.surfaceContext,
        lastIntent: intake.action || activeSessions[0].lastIntent,
        activeContextExpiresAt: addMs(now, config.activeContextTtlMs),
      },
      now
    );
    return {
      session,
      memory: await store.getSessionMemory(session.id),
      config,
      action: 'selected_active_dm_session',
    };
  }

  if (activeSessions.length > 1 && !['help', 'ping', 'status', 'cancel', 'empty'].includes(intake.action)) {
    return {
      ambiguous: true,
      sessions: activeSessions,
      replyText: selectionReply(activeSessions),
      config,
      action: 'ambiguous_active_dm_sessions',
    };
  }

  const recentSessions = userSessions.filter((session) => isRecentSession(session, now, config));
  if (recentSessions.length > 0 && !['help', 'ping', 'status', 'cancel', 'empty'].includes(intake.action)) {
    return {
      ambiguous: true,
      sessions: recentSessions,
      replyText: selectionReply(recentSessions),
      config,
      action: 'ambiguous_recent_dm_sessions',
    };
  }

  const currentKey = `dm:${surface.dmChannelId || 'unknown'}:current`;
  const session = await store.upsertSlackSession(sessionInputFrom(body, intake, currentKey, config, now), now);
  return {
    session,
    memory: await store.getSessionMemory(session.id),
    config,
    action: 'selected_dm_current',
  };
}
