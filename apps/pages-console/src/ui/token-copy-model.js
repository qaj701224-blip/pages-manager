export function buildTokenCopyFeedback(state, t) {
  if (state === 'copied') {
    return {
      label: t('tokenCopied'),
      className: 'token-copy-feedback success',
      ariaLive: 'polite',
    };
  }
  if (state === 'failed') {
    return {
      label: t('tokenCopyFailed'),
      className: 'token-copy-feedback error',
      ariaLive: 'assertive',
    };
  }
  return {
    label: t('copyToken'),
    className: 'token-copy-feedback',
    ariaLive: 'polite',
  };
}
