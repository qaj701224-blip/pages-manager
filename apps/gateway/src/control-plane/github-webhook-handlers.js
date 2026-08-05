import { jsonResponse } from '@xd/worker-kit';
import { parseGithubWebhookBody, verifyGithubWebhookSignature } from '../github/webhook.js';
import {
  isAllowedPlatformCiRun,
  isAllowedReviewAgent,
  isAllowedSiteCheckRun,
  normalizeReviewAgentWebhook,
  normalizeSiteCheckRunWebhook,
} from '../github/review.js';
import { handleGithubReviewAgentWebhook } from '../github/review-webhooks.js';
import { handleGithubIssueWebhook, handleGithubPullRequestWebhook } from '../github/resource-webhooks.js';
import { handleGithubSiteCheckWebhook } from '../github/site-check-webhooks.js';
import { getStore, required } from './context.js';

const TERMINAL_GITHUB_DELIVERY_STATUSES = new Set(['processed', 'ignored']);

function shouldRetryRecordedGithubDelivery(delivery = {}) {
  return !TERMINAL_GITHUB_DELIVERY_STATUSES.has(delivery.status || 'received');
}

async function markGithubDelivery(store, result, patch = {}) {
  const delivery = result?.delivery;
  if (!delivery?.repoFullName || !delivery?.deliveryId || !store?.updateGithubDelivery) return null;
  return await store.updateGithubDelivery(
    {
      repoFullName: delivery.repoFullName,
      deliveryId: delivery.deliveryId,
    },
    patch
  );
}

async function responseHasIgnoredPayload(response) {
  if (!response?.clone) return false;
  const payload = await response
    .clone()
    .json()
    .catch(() => null);
  return Boolean(payload?.ignored);
}

async function completeGithubDelivery(store, result, response) {
  await markGithubDelivery(store, result, {
    status: (await responseHasIgnoredPayload(response)) ? 'ignored' : 'processed',
  });
  return response;
}

function githubWebhookRepoAllowed(repoFullName, env = {}) {
  const configured = env.GITHUB_REPO || env.GITHUB_REPOSITORY || '';
  if (!configured) return true;
  return String(repoFullName || '').toLowerCase() === String(configured).toLowerCase();
}

export async function handleGithubWebhook(request, env, options = {}) {
  const rawBody = await request.text();
  await verifyGithubWebhookSignature(request, env, rawBody);
  const body = parseGithubWebhookBody(rawBody);
  const repoFullName = body.repository?.full_name || request.headers.get('X-GitHub-Repository') || 'unknown/repo';
  const deliveryId = required(request.headers.get('X-GitHub-Delivery') || body.deliveryId, 'deliveryId');
  const eventName = request.headers.get('X-GitHub-Event') || body.eventName || 'unknown';
  const action = body.action || null;
  const store = getStore(env);
  const result = await store.recordGithubDelivery({ repoFullName, deliveryId, eventName, action });

  if (!result.created) {
    if (!shouldRetryRecordedGithubDelivery(result.delivery)) {
      return jsonResponse({ ok: true, created: false, delivery: result.delivery });
    }
    await markGithubDelivery(store, result, {
      status: 'processing',
      requestId: request.headers.get('X-GitHub-Hook-Installation-Target-ID') || null,
    });
  }

  if (result.created) {
    await markGithubDelivery(store, result, {
      status: 'processing',
      requestId: request.headers.get('X-GitHub-Hook-Installation-Target-ID') || null,
    });
  }

  if (!githubWebhookRepoAllowed(repoFullName, env)) {
    return await completeGithubDelivery(
      store,
      result,
      jsonResponse({ ok: true, created: result.created, delivery: result.delivery, ignored: 'repo_not_allowed', repoFullName })
    );
  }

  try {
    if (eventName === 'issues') {
      return await completeGithubDelivery(
        store,
        result,
        await handleGithubIssueWebhook({
          body,
          action,
          store,
          env,
          result,
          retireSitePublishing: options.retireSitePublishing !== false,
        })
      );
    }

    if (eventName === 'pull_request') {
      return await completeGithubDelivery(
        store,
        result,
        await handleGithubPullRequestWebhook({
          body,
          action,
          store,
          env,
          result,
          retireSitePublishing: options.retireSitePublishing !== false,
        })
      );
    }

    const siteCheckRun = normalizeSiteCheckRunWebhook(body, eventName, deliveryId, repoFullName);
    if (siteCheckRun) {
      const allowedSiteCheck = isAllowedSiteCheckRun(siteCheckRun, env);
      const allowedPlatformCi = isAllowedPlatformCiRun(siteCheckRun, env);
      if (allowedSiteCheck || allowedPlatformCi) {
        return await completeGithubDelivery(
          store,
          result,
          await handleGithubSiteCheckWebhook({
            siteCheckRun: { ...siteCheckRun, platformCiOnly: allowedPlatformCi && !allowedSiteCheck },
            store,
            env,
            result,
            retireSitePublishing: options.retireSitePublishing !== false,
          })
        );
      }
    }

    const normalized = normalizeReviewAgentWebhook(body, eventName, deliveryId, repoFullName);
    if (!normalized) {
      return await completeGithubDelivery(
        store,
        result,
        jsonResponse({ ok: true, created: true, delivery: result.delivery, ignored: 'unsupported_event' })
      );
    }

    if (!isAllowedReviewAgent(normalized, env)) {
      return await completeGithubDelivery(
        store,
        result,
        jsonResponse({
          ok: true,
          created: true,
          delivery: result.delivery,
          ignored: 'review_agent_not_allowed',
          reviewAgentLogin: normalized.reviewAgentLogin,
        })
      );
    }

    return await completeGithubDelivery(
      store,
      result,
      await handleGithubReviewAgentWebhook({
        normalized,
        repoFullName,
        store,
        env,
        result,
        retireSitePublishing: options.retireSitePublishing !== false,
      })
    );
  } catch (err) {
    await markGithubDelivery(store, result, {
      status: 'failed',
      requestId: request.headers.get('X-GitHub-Hook-Installation-Target-ID') || null,
    });
    throw err;
  }
}
