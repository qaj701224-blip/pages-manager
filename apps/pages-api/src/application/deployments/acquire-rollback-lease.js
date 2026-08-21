export function createRollbackLeaseAcquisition({ leases }) {
  if (typeof leases?.acquire !== 'function') throw new TypeError('leases.acquire is required');

  return { acquire };

  async function acquire(command) {
    let lease;
    try {
      lease = await leases.acquire(command);
    } catch (cause) {
      return {
        ok: false,
        error: {
          code: 'SITE_POLICY_LOCKED',
          reason: 'acquire_failed',
          cause,
        },
      };
    }
    return lease
      ? { ok: true, lease }
      : {
          ok: false,
          error: {
            code: 'SITE_POLICY_CONFLICT',
            reason: 'lease_unavailable',
          },
        };
  }
}
