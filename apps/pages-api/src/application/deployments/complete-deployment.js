export function createDeploymentCompletion({ deployments, telemetry }) {
  if (typeof deployments?.update !== 'function') throw new TypeError('deployments.update is required');
  if (typeof telemetry?.persistSucceeded !== 'function') throw new TypeError('telemetry.persistSucceeded is required');
  if (typeof telemetry?.persistFailed !== 'function') throw new TypeError('telemetry.persistFailed is required');

  return { complete };

  async function complete(command) {
    const patch = {
      status: 'succeeded',
      versionId: command.versionId,
      previousVersionId: command.previousVersionId,
      completedAt: command.completedAt,
    };
    try {
      const completed = await deployments.update(command.deployment.id, patch);
      await telemetry.persistSucceeded();
      return completed;
    } catch (cause) {
      await telemetry.persistFailed({
        deploymentId: command.deployment.id,
        operation: 'persist_succeeded_deployment',
        cause,
      });
      return synthesizeSucceededDeployment(command.deployment, patch);
    }
  }
}

export function synthesizeSucceededDeployment(deployment, patch) {
  return {
    ...deployment,
    ...patch,
    status: 'succeeded',
    errorCode: null,
    errorMessage: null,
    failureStage: null,
    failureDiagnostics: null,
  };
}
