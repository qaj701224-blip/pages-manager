import { resolvePublicWorkerOfficeNetGuard } from '../../domain/deployments/public-office-net.js';

export function createPublicWorkerOfficeNetGuard({ settings }) {
  if (typeof settings?.ensureAbsent !== 'function') throw new TypeError('settings.ensureAbsent is required');

  return { ensure };

  async function ensure(command) {
    const decision = resolvePublicWorkerOfficeNetGuard(command);
    if (!decision.ok) return decision;
    if (decision.kind === 'skipped') return { ok: true, result: decision.result };

    try {
      await settings.ensureAbsent(command);
      return { ok: true, result: { status: 'verified' } };
    } catch (cause) {
      const code = isPublicOfficeNetFailure(cause?.code)
        ? cause.code
        : 'SITE_PUBLIC_OFFICE_NET_VERIFY_FAILED';
      return { ok: false, error: { code, reason: 'settings_failure', cause } };
    }
  }
}

function isPublicOfficeNetFailure(code) {
  return code === 'SITE_PUBLIC_OFFICE_NET_REMOVE_FAILED' || code === 'SITE_PUBLIC_OFFICE_NET_VERIFY_FAILED';
}
