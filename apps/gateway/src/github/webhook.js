import { parseJsonText } from '../http/body.js';
import { bytesToHex, timingSafeEqualString } from '../utils/crypto.js';

function flagFromEnv(value) {
  if (value === undefined || value === null || value === '') return null;
  if (['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(String(value).toLowerCase())) return false;
  return null;
}

function shouldRequireGithubWebhookSignature(env = {}) {
  const configured = flagFromEnv(env.GITHUB_WEBHOOK_SIGNATURE_REQUIRED);
  if (configured !== null) return configured;
  return env.NODE_ENV === 'production';
}

function unauthorized(message) {
  const error = new Error(message);
  error.status = 401;
  return error;
}

export async function verifyGithubWebhookSignature(request, env, rawBody) {
  if (!env.GITHUB_WEBHOOK_SECRET) {
    if (shouldRequireGithubWebhookSignature(env)) {
      throw unauthorized('GitHub webhook secret is not configured');
    }
    return;
  }

  const header = request.headers.get('X-Hub-Signature-256') || '';
  if (!header.startsWith('sha256=')) {
    throw unauthorized('Missing GitHub webhook signature');
  }

  const key = await crypto.subtle.importKey(
    'raw',
    new globalThis.TextEncoder().encode(env.GITHUB_WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const digest = await crypto.subtle.sign('HMAC', key, new globalThis.TextEncoder().encode(rawBody));
  const expected = `sha256=${bytesToHex(digest)}`;

  if (!timingSafeEqualString(header, expected)) {
    throw unauthorized('Invalid GitHub webhook signature');
  }
}

export function parseGithubWebhookBody(rawBody) {
  return parseJsonText(rawBody);
}

export function publishingJobIdFromIssueBody(body) {
  const text = String(body || '');
  const htmlCommentMatch = text.match(/<!--\s*pages-manager:job_id=(job_[A-Za-z0-9_]{1,80})\s*-->/);
  if (htmlCommentMatch) return htmlCommentMatch[1];

  const match = text.match(/^PublishingJob:\s*(job_[A-Za-z0-9_]{1,80})\s*$/m);
  return match ? match[1] : '';
}

export function platformDevItemIdFromIssueBody(body) {
  const text = String(body || '');
  const htmlCommentMatch = text.match(/<!--\s*pages-manager:platform_dev_item_id=(pdev_[A-Za-z0-9_]{1,80})\s*-->/);
  if (htmlCommentMatch) return htmlCommentMatch[1];

  const match = text.match(/^PlatformDevItem:\s*(pdev_[A-Za-z0-9_]{1,80})\s*$/m);
  return match ? match[1] : '';
}

export function issueUrl(issue = {}) {
  return issue.html_url || issue.url || null;
}
