export function createDeploymentCompletion({ deployments, telemetry }) {
  if (typeof deployments?.update !== 'function') throw new TypeError('deployments.update is required');
  if (typeof telemetry?.startPersist !== 'function') throw new TypeError('telemetry.startPersist is required');
  if (typeof telemetry?.persistSucceeded !== 'function') throw new TypeError('telemetry.persistSucceeded is required');
  if (typeof telemetry?.persistFailed !== 'function') throw new TypeError('telemetry.persistFailed is required');

  return { complete };

  function complete(command) {
    const stage = telemetry.startPersist('persist_succeeded_deployment');
    return completeAfterStart(command, stage);
  }

  async function completeAfterStart(command, stage) {
    const patch = {
      status: 'succeeded',
      versionId: command.versionId,
      previousVersionId: command.previousVersionId,
      completedAt: command.completedAt,
    };
    try {
      const completed = await deployments.update(command.deployment.id, patch);
      await telemetry.persistSucceeded(stage);
      return completed;
    } catch (cause) {
      await telemetry.persistFailed({
        deploymentId: command.deployment.id,
        stage,
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
