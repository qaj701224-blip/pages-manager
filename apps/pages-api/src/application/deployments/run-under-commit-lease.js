export function createDeploymentCommitLease({ leases, telemetry }) {
  if (typeof leases?.run !== 'function') throw new TypeError('leases.run is required');
  if (typeof telemetry?.start !== 'function') throw new TypeError('telemetry.start is required');
  if (typeof telemetry?.finish !== 'function') throw new TypeError('telemetry.finish is required');

  return { run };

  function run(command, work) {
    if (typeof work !== 'function') throw new TypeError('work is required');
    const stage = telemetry.start();
    return runAfterStart(command, work, stage);
  }

  async function runAfterStart(command, work, stage) {
    let acquired = false;
    try {
      const value = await leases.run(command, async (lease) => {
        await telemetry.finish(stage, { status: 'succeeded' });
        acquired = true;
        return work(lease);
      });
      if (acquired) return { ok: true, value };
      await telemetry.finish(stage, { status: 'failed', reason: 'capability_unavailable' });
      return {
        ok: false,
        error: { code: 'SITE_POLICY_LOCKED', reason: 'capability_unavailable' },
      };
    } catch (cause) {
      if (acquired) throw cause;
      await telemetry.finish(stage, { status: 'failed', reason: 'acquire_failed', cause });
      return {
        ok: false,
        error: { code: cause?.code || 'SITE_POLICY_LOCKED', reason: 'acquire_failed', cause },
      };
    }
  }
}
