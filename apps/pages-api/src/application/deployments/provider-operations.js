export function createDeploymentProviderOperations({ providers }) {
  if (typeof providers?.create !== 'function') throw new TypeError('providers.create is required');

  return { prepare, upload, verify };

  function prepare(command) {
    try {
      return { ok: true, provider: providers.create(command.site) };
    } catch (cause) {
      return failed('DEPLOYMENT_PROVIDER_CONFIG_INVALID', cause);
    }
  }

  async function upload(command) {
    const { provider, ...input } = command;
    try {
      return { ok: true, uploaded: await provider.upload(input) };
    } catch (cause) {
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
