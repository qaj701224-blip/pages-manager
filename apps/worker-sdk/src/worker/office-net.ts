import type { Fetcher, OfficeNet, RuntimeEnv } from '../types.js';

const OFFICE_NET_BINDING = 'XD_OFFICE_NET';

export function createOfficeNet(env: RuntimeEnv): OfficeNet {
  const binding = env[OFFICE_NET_BINDING];
  if (isFetcher(binding)) return binding;

  return {
    async fetch() {
      return Response.json(
        {
          ok: false,
          error: {
            code: 'OFFICE_NET_UNAVAILABLE',
            message: 'Office network access is not supported for this Worker.',
          },
        },
        { status: 501 }
      );
    },
  };
}

function isFetcher(value: unknown): value is Fetcher {
  return typeof value === 'object' && value !== null && 'fetch' in value && typeof value.fetch === 'function';
}
