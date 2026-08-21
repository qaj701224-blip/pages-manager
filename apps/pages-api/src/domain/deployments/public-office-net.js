export function resolvePublicWorkerOfficeNetGuard({ exposure, deploymentShape, executionProvider }) {
  if (exposure !== 'public') return skipped('exposure-not-public');
  if (deploymentShape === 'assets-only') return skipped('assets-only');
  if (deploymentShape !== 'worker-only' && deploymentShape !== 'worker-with-assets') {
    return failed('SITE_PUBLIC_OFFICE_NET_REMOVE_FAILED', 'deployment_shape_unknown');
  }
  if (executionProvider === 'normal-worker-slot') return skipped('normal-worker-slot');
  if (executionProvider !== 'wfp') {
    return failed('SITE_PUBLIC_OFFICE_NET_VERIFY_FAILED', 'execution_provider_unsupported');
  }
  return { ok: true, kind: 'required' };
}

function skipped(reason) {
  return { ok: true, kind: 'skipped', result: { status: 'not_applicable', reason } };
}

function failed(code, reason) {
  return { ok: false, error: { code, reason } };
}
