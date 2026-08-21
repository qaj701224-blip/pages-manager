import { readWfpConfig } from '@xd/wfp-client';

export function readWfpProviderConfig(env = {}, { environment = env.PAGES_ENV } = {}) {
  return {
    ...readWfpConfig(env, { environment }),
    compatibilityDate: env.WFP_COMPATIBILITY_DATE,
    userWorkerVpcTunnelId: String(env.PAGES_USER_WORKER_VPC_TUNNEL_ID || '').trim(),
  };
}
