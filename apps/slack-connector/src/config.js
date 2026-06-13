function required(value, name) {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function flag(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

export function readConfig(env = process.env) {
  return {
    botToken: required(env.SLACK_BOT_TOKEN, 'SLACK_BOT_TOKEN'),
    appToken: required(env.SLACK_APP_TOKEN, 'SLACK_APP_TOKEN'),
    gatewaySlackUrl: env.PAGES_GATEWAY_SLACK_URL || 'http://localhost:8788/integrations/slack/events',
    gatewayConnectorToken: env.PAGES_GATEWAY_CONNECTOR_TOKEN || env.SLACK_CONNECTOR_SHARED_SECRET || '',
    employeeSlug: env.PAGES_EMPLOYEE_SLUG || 'smoke',
    siteSlug: env.PAGES_SITE_SLUG || 'profile',
    acceptBotEvents: flag(env.SLACK_CONNECTOR_ACCEPT_BOT_EVENTS, false),
    acceptThreadMessages: flag(env.SLACK_CONNECTOR_ACCEPT_THREAD_MESSAGES, false),
    replyOnReceive: flag(env.SLACK_CONNECTOR_REPLY_ON_RECEIVE, true),
    botUserId: env.SLACK_BOT_USER_ID || null,
  };
}
