export function createRollbackVersionValidation({ deployments }) {
  if (typeof deployments?.get !== 'function') throw new TypeError('deployments.get is required');

  return { validate };

  async function validate(command) {
    const { version, environment } = command;
    if (version.artifactAvailability !== 'active') {
      return { ok: false, error: { reason: 'artifact_unavailable' } };
    }

    const deployment = await deployments.get(version.deploymentId, environment);
    if (!deployment || deployment.status !== 'succeeded') {
      return { ok: false, error: { reason: 'source_deployment_unavailable' } };
    }

    if (version.executionProvider === 'normal-worker-slot') {
      return { ok: false, error: { reason: 'legacy_provider_unavailable' } };
    }
    return { ok: true };
  }
}
