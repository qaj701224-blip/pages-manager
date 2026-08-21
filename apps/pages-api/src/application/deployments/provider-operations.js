export function createDeploymentProviderOperations({ providers, uploadTelemetry }) {
  if (typeof providers?.create !== 'function') throw new TypeError('providers.create is required');
  if (typeof uploadTelemetry?.start !== 'function') throw new TypeError('uploadTelemetry.start is required');
  if (typeof uploadTelemetry?.finish !== 'function') throw new TypeError('uploadTelemetry.finish is required');

  return { prepare, upload, verify };

  function prepare(command) {
    try {
      return { ok: true, provider: providers.create(command.site) };
    } catch (cause) {
      return failed('DEPLOYMENT_PROVIDER_CONFIG_INVALID', cause);
    }
  }

  function upload(command) {
    const stage = uploadTelemetry.start();
    return uploadAfterStart(command, stage);
  }

  async function uploadAfterStart(command, stage) {
    const { provider, ...input } = command;
    let result;
    try {
      result = { ok: true, uploaded: await provider.upload(input) };
    } catch (cause) {
      result = failed('DEPLOYMENT_PROVIDER_UPLOAD_FAILED', cause);
    }
    if (!result.ok) {
      await uploadTelemetry.finish(stage, { status: 'failed', cause: result.error.cause });
      return result;
    }
    try {
      await uploadTelemetry.finish(stage, { status: 'succeeded', operation: result.uploaded?.operation });
      return result;
    } catch (cause) {
      await uploadTelemetry.finish(stage, { status: 'failed', cause });
      return failed('DEPLOYMENT_PROVIDER_UPLOAD_FAILED', cause);
    }
  }

  async function verify(command) {
    const { provider, ...input } = command;
    try {
      await provider.verify(input);
      return { ok: true };
    } catch (cause) {
      return failed('DEPLOYMENT_PROVIDER_VERIFY_FAILED', cause);
    }
  }
}

function failed(code, cause) {
  return { ok: false, error: { code, cause } };
}
