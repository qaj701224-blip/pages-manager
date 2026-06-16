export function redactSecretLikeText(text = '') {
  return String(text || '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED_TOKEN]')
    .replace(/\b(xox[baprs]-[A-Za-z0-9-]{8,})\b/g, '[REDACTED_SLACK_TOKEN]')
    .replace(/\b(xapp-[A-Za-z0-9-]{8,})\b/g, '[REDACTED_SLACK_APP_TOKEN]')
    .replace(/\b(ghp_[A-Za-z0-9_]{20,})\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\b(github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\b(sk-[A-Za-z0-9_-]{20,})\b/g, '[REDACTED_API_KEY]')
    .replace(/("(?:api[_-]?key|token|secret|password|passwd|pwd)"\s*:\s*")[^"]+(")/gi, '$1[REDACTED_SECRET]$2')
    .replace(/\b(api[_-]?key|token|secret|password|passwd|pwd)\b\s*[:=]\s*["']?[^"',\s}]+/gi, '$1=[REDACTED_SECRET]');
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
