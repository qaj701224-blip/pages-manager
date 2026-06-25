import assert from 'node:assert/strict';
import test from 'node:test';

import { reviewCommentToRow } from '../../../apps/gateway/src/db/rows/review-row.js';

test('review comments redact fallback bodies before persistence', () => {
  const row = reviewCommentToRow({
    repoFullName: 'org/pages-manager',
    prNumber: 82,
    githubCommentNodeId: 'PRRC_secret',
    sourceType: 'inline_comment',
    reviewAgentLogin: 'chatgpt-codex-connector[bot]',
    status: 'open',
    body: 'Reviewer quoted token=ghp_abcdefghijklmnopqrstuvwxyz1234567890',
  });

  assert.equal(row.body_redacted, 'Reviewer quoted token=[REDACTED_SECRET]');
  assert.doesNotMatch(row.body_redacted, /ghp_/);
});
