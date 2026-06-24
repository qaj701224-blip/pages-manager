const SECRET_FIELD_NAME_PATTERN =
  [
    '(?:[A-Za-z0-9]+[_-])*',
    '(?:api[_-]?key|secret(?:[_-]access)?[_-]?key|private[_-]?key|secret|token|password|passwd|pwd)',
    '(?:[_-][A-Za-z0-9]+)*',
  ].join('');
const jsonSecretFieldPattern = new RegExp(`("(?:${SECRET_FIELD_NAME_PATTERN})"\\s*:\\s*)(["'])[^"']*\\2`, 'gi');
const quotedSecretAssignmentPattern = new RegExp(
  `\\b(${SECRET_FIELD_NAME_PATTERN})\\b\\s*([:=])\\s*(["'])[^"']*\\3`,
  'gi'
);
const secretAssignmentPattern = new RegExp(
  `\\b(${SECRET_FIELD_NAME_PATTERN})\\b\\s*([:=])\\s*[^"',\\s}]+`,
  'gi'
);

export function redactSecretLikeText(text = '') {
  return String(text || '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED_TOKEN]')
    .replace(/\b(xox[baprs]-[A-Za-z0-9-]{8,})\b/g, '[REDACTED_SLACK_TOKEN]')
    .replace(/\b(xapp-[A-Za-z0-9-]{8,})\b/g, '[REDACTED_SLACK_APP_TOKEN]')
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{20,})\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\b(github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\b(sk-[A-Za-z0-9_-]{20,})\b/g, '[REDACTED_API_KEY]')
    .replace(jsonSecretFieldPattern, '$1$2[REDACTED_SECRET]$2')
    .replace(quotedSecretAssignmentPattern, '$1$2$3[REDACTED_SECRET]$3')
    .replace(secretAssignmentPattern, '$1$2[REDACTED_SECRET]');
}

export function compactUserFacingText(text = '') {
  const internalContextFieldRe = new RegExp(
    [
      '\\b(?:activeJobId|activeIssueNumber|activePrNumber|activePreviewUrl',
      '|issueLinkCount|slackSessionId|sessionKey)\\s*[:=]\\s*[^，。；;、\\s)）]+',
    ].join(''),
    'gi'
  );
  const redacted = redactSecretLikeText(text)
    .replace(internalContextFieldRe, '')
    .replace(/\b(?:employeeSlug|previewUrl)\s*[:=]\s*[^，。；;、\s)）]+/gi, '')
    .replace(/\bjob_[A-Za-z0-9_]{1,80}\b/g, '')
    .replace(/\bsess_[A-Za-z0-9_]{1,80}\b/g, '')
    .replace(/https?:\/\/pm-pr-[^\s)）]+/gi, '');

  const parts = redacted
    .split(/(?<=[。！？!?；;])\s*|\n+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter(
      (part) =>
        !/(active(?:Job|Issue|Pr|Preview)|slackSession|sessionKey|issueLinkCount|previewUrl|gateway 根据|历史关联 PR)/i.test(part)
    );

  return parts
    .join('')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/([：:，,；;、]){2,}/g, '$1')
    .replace(/\s+([，。；：])/g, '$1')
    .trim();
}
