const TERMINAL_STATUSES = new Set(['succeeded', 'failed']);

export function createFailedDeploymentsRecovery({
  markers,
  deployments,
  commits,
  traces,
  failures,
  telemetry,
  repairs,
}) {
  if (typeof markers?.list !== 'function') throw new TypeError('markers.list is required');
  if (typeof deployments?.get !== 'function') throw new TypeError('deployments.get is required');
  if (typeof commits?.reconcile !== 'function') throw new TypeError('commits.reconcile is required');
  if (typeof traces?.forDeployment !== 'function') throw new TypeError('traces.forDeployment is required');
  if (typeof failures?.complete !== 'function') throw new TypeError('failures.complete is required');
  if (typeof telemetry?.recovered !== 'function') throw new TypeError('telemetry.recovered is required');
  if (typeof repairs?.report !== 'function') throw new TypeError('repairs.report is required');

  return { recover };

  async function recover(command) {
    if (command.site.pendingSiteCreation) return;
    const { records, readError } = await markers.list(command.site);
    for (const record of records) await recoverRecord(record, command);
    if (readError) throw readError;
  }

  async function recoverRecord(record, command) {
    const { marker } = record;
    if (!marker) {
      await record.delete();
      return;
    }

    let deployment;
    try {
      deployment = await deployments.get(marker.deploymentId, command.environment);
    } catch (cause) {
      throw recoveryStateError('Deployment state could not be read for recovery.', cause);
    }
    if (!deployment || deployment.siteId !== command.site.id || isTerminal(deployment)) {
      await record.delete();
      return;
    }

    let reconciled;
    try {
      reconciled = await commits.reconcile(deployment, command.environment);
    } catch (cause) {
      throw recoveryStateError('Deployment commit state could not be read for recovery.', cause);
    }
    if (isTerminal(reconciled)) {
      let persisted;
      try {
        persisted = await deployments.get(marker.deploymentId, command.environment);
      } catch (cause) {
        throw recoveryStateError('Reconciled deployment state could not be read.', cause);
      }
      if (isTerminal(persisted)) {
        await record.delete();
        return;
      }
      throw recoveryStateError('Reconciled deployment state could not be persisted.');
    }

    const trace = await traces.forDeployment(deployment, command.environment).catch(() => null);
    try {
      const recovered = await failures.complete({
        deploymentId: marker.deploymentId,
        patch: marker.failedPatch,
        actor: command.actor,
        site: command.site,
        trace,
      });
      if (!isTerminal(recovered)) return;
      if (trace) {
        await telemetry.recovered(trace, {
          operatorAction: marker.operation === 'rollback' ? 'retry_rollback' : 'retry_deploy',
        });
      }
      await record.delete();
    } catch (error) {
      if (error?.code === 'DEPLOYMENT_STATE_WRITE_FAILED') throw error;
      repairs.report({
        environment: command.environment,
        siteId: command.site.id,
        deploymentId: marker.deploymentId,
        reason: 'deployment_failure_state_recovery_failed',
      });
    }
  }
}

function isTerminal(deployment) {
  return TERMINAL_STATUSES.has(deployment?.status);
}

function recoveryStateError(message, cause) {
  const error = new Error(message, { cause });
  error.code = 'DEPLOYMENT_STATE_WRITE_FAILED';
  return error;
}
