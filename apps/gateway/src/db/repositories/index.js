import { agentRunRepositoryMethods } from './agent-runs.js';
import { githubDeliveryRepositoryMethods } from './github-deliveries.js';
import { platformDevRepositoryMethods } from './platform-dev.js';
import { publishingJobRepositoryMethods } from './publishing-jobs.js';
import { reviewGateRepositoryMethods } from './review-gates.js';
import { slackDeliveryRepositoryMethods } from './slack-deliveries.js';
import { slackNotificationRepositoryMethods } from './slack-notifications.js';
import { slackSessionRepositoryMethods } from './slack-sessions.js';

const METHOD_GROUPS = [
  publishingJobRepositoryMethods,
  githubDeliveryRepositoryMethods,
  slackDeliveryRepositoryMethods,
  reviewGateRepositoryMethods,
  slackNotificationRepositoryMethods,
  slackSessionRepositoryMethods,
  agentRunRepositoryMethods,
  platformDevRepositoryMethods,
];

export function bindMysqlRepositoryMethods(store) {
  for (const methods of METHOD_GROUPS) {
    for (const [name, method] of Object.entries(methods)) {
      store[name] = method.bind(store);
    }
  }
}
