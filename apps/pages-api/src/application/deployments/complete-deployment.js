export function createDeploymentCompletion({ deployments }) {
  if (typeof deployments?.update !== 'function') throw new TypeError('deployments.update is required');

  return { complete };

  async function complete(command) {
    const patch = {
      status: 'succeeded',
      versionId: command.versionId,
      previousVersionId: command.previousVersionId,
      completedAt: command.completedAt,
    };
    try {
      return {
        ok: true,
        deployment: await deployments.update(command.deployment.id, patch),
      };
    } catch (cause) {
      return {
        ok: false,
        deployment: synthesizeSucceededDeployment(command.deployment, patch),
        error: { code: 'DEPLOYMENT_STATE_WRITE_FAILED', cause },
      };
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
