import { resolvePublicWorkerOfficeNetGuard } from '../../domain/deployments/public-office-net.js';

export function createPublicWorkerOfficeNetGuard({ settings, telemetry }) {
  if (typeof settings?.ensureAbsent !== 'function') throw new TypeError('settings.ensureAbsent is required');
  if (typeof telemetry?.start !== 'function') throw new TypeError('telemetry.start is required');
  if (typeof telemetry?.finish !== 'function') throw new TypeError('telemetry.finish is required');

  return { ensure };

  function ensure(command) {
    const stage = telemetry.start();
    return ensureAfterStart(command, stage);
  }

  async function ensureAfterStart(command, stage) {
    const decision = resolvePublicWorkerOfficeNetGuard(command);
    if (!decision.ok) {
      await telemetry.finish(stage, { status: 'failed', error: decision.error });
      return decision;
    }
    if (decision.kind === 'skipped') {
      await finishSuccessful(stage, { status: command.exposure === 'public' ? 'succeeded' : 'skipped' });
      return { ok: true, result: decision.result };
    }

    try {
      await settings.ensureAbsent(command);
    } catch (cause) {
      const code = isPublicOfficeNetFailure(cause?.code)
        ? cause.code
        : 'SITE_PUBLIC_OFFICE_NET_VERIFY_FAILED';
      const error = { code, reason: 'settings_failure', cause };
      await telemetry.finish(stage, { status: 'failed', error });
      return { ok: false, error };
    }
    await finishSuccessful(stage, { status: 'succeeded' });
    return { ok: true, result: { status: 'verified' } };

    async function finishSuccessful(receivedStage, outcome) {
      try {
        await telemetry.finish(receivedStage, outcome);
      } catch (cause) {
        await telemetry.finish(receivedStage, { status: 'failed', reason: 'telemetry_finish_error', cause });
        throw cause;
      }
    }
  }
}

function isPublicOfficeNetFailure(code) {
  return code === 'SITE_PUBLIC_OFFICE_NET_REMOVE_FAILED' || code === 'SITE_PUBLIC_OFFICE_NET_VERIFY_FAILED';
}
