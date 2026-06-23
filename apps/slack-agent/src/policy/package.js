export const SLACK_AGENT_POLICY_PACKAGE_VERSION = 'slack-agent-policy-2026-06-23.1';

export const SLACK_AGENT_POLICY_PACKAGE = {
  version: SLACK_AGENT_POLICY_PACKAGE_VERSION,
  fragments: [
    'role',
    'safety',
    'lanes',
    'intent-priority',
    'tool-contract',
    'output-schema',
    'product-language',
    'conversation-context',
    'repo-question',
    'diagnostics',
    'platform-dev',
    'site-publishing',
  ],
};
