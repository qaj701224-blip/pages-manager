export function createDeploymentFailureCompletion({
  deployments,
  telemetry,
  recoveryMarkers,
  repairs,
  webhooks,
  clock,
}) {
  if (typeof deployments?.get !== 'function') throw new TypeError('deployments.get is required');
  if (typeof deployments?.update !== 'function') throw new TypeError('deployments.update is required');
  if (typeof telemetry?.startPersist !== 'function') throw new TypeError('telemetry.startPersist is required');
  if (typeof telemetry?.persistFailed !== 'function') throw new TypeError('telemetry.persistFailed is required');
  if (typeof telemetry?.persistSucceeded !== 'function') throw new TypeError('telemetry.persistSucceeded is required');
  if (typeof telemetry?.webhookSkipped !== 'function') throw new TypeError('telemetry.webhookSkipped is required');
  if (typeof recoveryMarkers?.persist !== 'function') throw new TypeError('recoveryMarkers.persist is required');
  if (typeof repairs?.report !== 'function') throw new TypeError('repairs.report is required');
  if (typeof webhooks?.emitFailed !== 'function') throw new TypeError('webhooks.emitFailed is required');
  if (typeof clock?.now !== 'function') throw new TypeError('clock.now is required');

  return { complete };

  async function complete(command) {
    const before = await deployments.get(command.deploymentId, command.environment).catch(() => null);
    const failedPatch = {
      ...command.patch,
      status: 'failed',
      completedAt: command.patch.completedAt || clock.now(),
    };
    const persistStage = telemetry.startPersist('persist_failed_deployment');
    let initialPersistFailed = false;
    let updated;
    try {
      updated = await deployments.update(command.deploymentId, failedPatch);
    } catch (cause) {
      initialPersistFailed = true;
      await telemetry.persistFailed({
        deploymentId: command.deploymentId,
        stage: persistStage,
        operation: 'persist_failed_deployment',
        cause,
      });
      const recoveryStage = telemetry.startPersist('recover_failed_deployment');
      try {
        updated = await deployments.update(command.deploymentId, failedPatch);
      } catch (recoveryCause) {
        await telemetry.persistFailed({
          deploymentId: command.deploymentId,
          stage: recoveryStage,
          operation: 'recover_failed_deployment',
          cause: recoveryCause,
        });
        const recoveryMarkerStored = await recoveryMarkers.persist({
          deploymentId: command.deploymentId,
          siteId: command.site?.id || command.siteId || null,
          siteHostname: command.site?.route?.hostname || command.site?.hostname || null,
          operation: command.operation || null,
          failedPatch,
        });
        repairs.report({
          environment: command.environment,
          siteId: command.site?.id || command.siteId || null,
          deploymentId: command.deploymentId,
          reason: recoveryMarkerStored
            ? 'deployment_failure_state_recovery_deferred'
            : 'deployment_failure_state_recovery_failed',
        });
        throw deploymentStateWriteError(recoveryCause);
      }
      await telemetry.persistSucceeded(recoveryStage);
    }
    if (!initialPersistFailed) await telemetry.persistSucceeded(persistStage);

    if (!shouldEmitFailedWebhook(before, updated, command.site)) {
      await telemetry.webhookSkipped();
      return updated;
    }
    await webhooks.emitFailed({
      actor: command.actor,
      site: command.site,
      deployment: updated,
    });
    return updated;
  }
}

function shouldEmitFailedWebhook(before, updated, site) {
  return Boolean(before && updated && before.status !== 'failed' && updated.status === 'failed' && site);
}

function deploymentStateWriteError(cause) {
  const error = new Error('Deployment failure state could not be persisted.', { cause });
  error.code = 'DEPLOYMENT_STATE_WRITE_FAILED';
  return error;
}
