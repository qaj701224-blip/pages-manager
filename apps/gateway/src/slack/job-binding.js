import { redactSecretLikeText } from './text.js';
import { slackWorkItemTargetLabel } from './work-items.js';

export function slackThreadForSession(session = {}, fallback = {}) {
  const surface = session.surfaceContext || {};
  return {
    ...(fallback || {}),
    teamId: session.teamId || fallback.teamId || null,
    channelId: session.channelId || surface.channelId || fallback.channelId || null,
    channelType: surface.channelType || fallback.channelType || (session.dmChannelId ? 'im' : null),
    messageTs: surface.messageTs || fallback.messageTs || session.threadTs || null,
    threadTs: session.threadTs || surface.threadTs || fallback.threadTs || null,
    userId: session.primarySlackUserId || fallback.userId || null,
  };
}

export function slackJobBindingPatchForSession(job = {}, session = {}) {
  return {
    slackSessionId: session.id || job.slackSessionId || null,
    slackSessionKey: session.sessionKey || job.slackSessionKey || null,
    slackThread: slackThreadForSession(session, job.slackThread || {}),
  };
}

export function sessionMemoryForSelectedJob(job = {}) {
  const summary = redactSecretLikeText(job.summary || job.title || job.siteSlug || '');
  return {
    summary,
    requirements: {
      intent: job.intent || 'modify_existing_preview',
      title: redactSecretLikeText(job.title || ''),
      summary,
      siteSlug: job.siteSlug || null,
      issueNumber: job.issueNumber || null,
      prNumber: job.prNumber || null,
      previewUrl: job.previewUrl || null,
    },
    pendingQuestions: [],
    lastPreviewFeedback: null,
    lastAgentResponse: `已切换到 ${slackWorkItemTargetLabel(job)}，后续回复会继续修改这个任务。`,
  };
}

export async function activateJobForSlackSession(store, job, session) {
  if (!job?.id || !session?.id) return job || null;
  const slackBindingPatch = slackJobBindingPatchForSession(job, session);
  const updatedJob = (await store.patchJob(job.id, slackBindingPatch)) || { ...job, ...slackBindingPatch };
  await store.linkJobToSlackSession(updatedJob, session);
  await store.updateSessionMemory(session.id, sessionMemoryForSelectedJob(updatedJob));
  return updatedJob;
}
