import { deliverWebhookEventToSubscriptions } from '../../../webhooks.js';

export function createDeploymentWebhookDispatcher({ store, env, config }) {
  return {
    deliver(event, { now } = {}) {
      return deliverWebhookEventToSubscriptions({
        store,
        env,
        config,
        event,
        fetchImpl: typeof env?.WEBHOOK_FETCH === 'function' ? env.WEBHOOK_FETCH : undefined,
        resolveHost: typeof env?.resolveWebhookHost === 'function' ? env.resolveWebhookHost : undefined,
        now,
      });
    },
  };
}
