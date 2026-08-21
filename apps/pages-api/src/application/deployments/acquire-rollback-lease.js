export function createRollbackLeaseAcquisition({ leases, telemetry }) {
  if (typeof leases?.acquire !== 'function') throw new TypeError('leases.acquire is required');
  if (typeof telemetry?.start !== 'function') throw new TypeError('telemetry.start is required');
  if (typeof telemetry?.finish !== 'function') throw new TypeError('telemetry.finish is required');

  return { acquire };

  function acquire(command) {
    const stage = telemetry.start();
    return acquireAfterStart(command, stage);
  }

  async function acquireAfterStart(command, stage) {
    let lease;
    try {
      lease = await leases.acquire(command);
    } catch (cause) {
      const result = {
        ok: false,
        error: {
          code: 'SITE_POLICY_LOCKED',
          reason: 'acquire_failed',
          cause,
        },
      };
      await telemetry.finish(stage, { status: 'failed', reason: 'acquire_failed', cause });
      return result;
    }
    const result = lease
      ? { ok: true, lease }
      : {
          ok: false,
          error: {
            code: 'SITE_POLICY_CONFLICT',
            reason: 'lease_unavailable',
          },
        };
    await telemetry.finish(
      stage,
      result.ok ? { status: 'succeeded' } : { status: 'failed', reason: 'lease_unavailable' }
    );
    return result;
  }
}
