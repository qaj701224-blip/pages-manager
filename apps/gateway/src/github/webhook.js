import { parseJsonText } from '../http/body.js';
import { bytesToHex, timingSafeEqualString } from '../utils/crypto.js';

export async function verifyGithubWebhookSignature(request, env, rawBody) {
  if (!env.GITHUB_WEBHOOK_SECRET) return;

  const header = request.headers.get('X-Hub-Signature-256') || '';
  if (!header.startsWith('sha256=')) {
    const error = new Error('Missing GitHub webhook signature');
    error.status = 401;
    throw error;
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
    const error = new Error('Invalid GitHub webhook signature');
    error.status = 401;
    throw error;
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

export function issueUrl(issue = {}) {
  return issue.html_url || issue.url || null;
}
