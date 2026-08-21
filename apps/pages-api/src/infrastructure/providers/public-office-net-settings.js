export function createPublicOfficeNetSettings({ withRuntimeConfigLock } = {}) {
  return { ensureAbsent };

  async function ensureAbsent(command) {
    const removeAndVerify = async ({ signal: settingsSignal } = {}) => {
      const signal = combineAbortSignals(command.signal, settingsSignal);
      if (typeof command.provider?.removeOfficeNetBinding !== 'function') {
        throw officeNetError('SITE_PUBLIC_OFFICE_NET_REMOVE_FAILED');
      }
      try {
        await command.provider.removeOfficeNetBinding({ workerName: command.workerName, signal });
      } catch (cause) {
        throw officeNetError('SITE_PUBLIC_OFFICE_NET_REMOVE_FAILED', cause);
      }
      if (typeof command.provider?.verifyOfficeNetAbsent !== 'function') {
        throw officeNetError('SITE_PUBLIC_OFFICE_NET_VERIFY_FAILED');
      }
      try {
        const absent = await command.provider.verifyOfficeNetAbsent({ workerName: command.workerName, signal });
        if (!absent) throw new Error('OFFICE_NET_PRESENT');
      } catch (cause) {
        throw officeNetError('SITE_PUBLIC_OFFICE_NET_VERIFY_FAILED', cause);
      }
    };

    if (typeof withRuntimeConfigLock === 'function') {
      try {
        return await withRuntimeConfigLock(command.environment, command.siteId, removeAndVerify);
      } catch (cause) {
        if (isPublicOfficeNetFailure(cause)) throw cause;
        throw officeNetError('SITE_PUBLIC_OFFICE_NET_REMOVE_FAILED', cause);
      }
    }
    return removeAndVerify({ signal: command.signal });
  }
}

function combineAbortSignals(...signals) {
  const activeSignals = signals.filter(Boolean);
  if (activeSignals.length === 0) return undefined;
  if (activeSignals.length === 1) return activeSignals[0];
  if (typeof globalThis.AbortSignal?.any === 'function') return globalThis.AbortSignal.any(activeSignals);
  const controller = new globalThis.AbortController();
  for (const activeSignal of activeSignals) {
    if (activeSignal.aborted) {
      controller.abort(activeSignal.reason);
      break;
    }
    activeSignal.addEventListener('abort', () => controller.abort(activeSignal.reason), { once: true });
  }
  return controller.signal;
}

function officeNetError(code, cause) {
  const error = new Error(code, { cause });
  error.code = code;
  return error;
}

function isPublicOfficeNetFailure(error) {
  return error?.code === 'SITE_PUBLIC_OFFICE_NET_REMOVE_FAILED' || error?.code === 'SITE_PUBLIC_OFFICE_NET_VERIFY_FAILED';
}
