const DEFAULT_MENTION_USER_ID = 'U06QLFY2XCK';

export function readWebhookEncryptionConfig(env = {}) {
  const encryptionKey = env.WEBHOOK_URL_ENCRYPTION_KEY;
  if (typeof encryptionKey !== 'string' || !encryptionKey) {
    throw new Error('WEBHOOK_URL_ENCRYPTION_KEY_REQUIRED');
  }
  return { encryptionKey };
}

export function readAlertConfig(env = {}) {
  return {
    webhookUrl: env.SLACK_PAGES_ALERT_WEBHOOK_URL,
    mentionUserId: env.SLACK_PAGES_ALERT_MENTION_USER_ID || DEFAULT_MENTION_USER_ID,
    fetchImpl: env.fetch || globalThis.fetch,
  };
}
