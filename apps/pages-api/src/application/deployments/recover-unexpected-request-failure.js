const TERMINAL_STATUSES = new Set(['succeeded', 'failed']);

export function createUnexpectedRequestFailureRecovery({
  requestTrace,
  deployments,
  commits,
  sites,
  failures,
  logs,
  repairs,
}) {
  if (typeof requestTrace?.failUnexpected !== 'function') {
    throw new TypeError('requestTrace.failUnexpected is required');
  }
  if (typeof deployments?.get !== 'function') throw new TypeError('deployments.get is required');
  if (typeof commits?.reconcile !== 'function') throw new TypeError('commits.reconcile is required');
  if (typeof sites?.load !== 'function') throw new TypeError('sites.load is required');
  if (typeof failures?.patch !== 'function') throw new TypeError('failures.patch is required');
  if (typeof failures?.complete !== 'function') throw new TypeError('failures.complete is required');
  if (typeof logs?.stateWriteFailed !== 'function') throw new TypeError('logs.stateWriteFailed is required');
  if (typeof repairs?.report !== 'function') throw new TypeError('repairs.report is required');

  return { recover };

  async function recover(command) {
    const deploymentId = command.trace?.deploymentId || null;
    try {
      await requestTrace.failUnexpected(command.trace, {
        fallbackStage: deploymentId ? 'deployment_operation' : 'intake',
        fallbackOperation: command.fallbackOperation,
      });
    } catch {
      // Trace persistence must not prevent best-effort terminal state recovery.
    }
    if (!deploymentId) return null;

    let deployment;
    try {
      deployment = await deployments.get(deploymentId, command.environment);
    } catch {
      logs.stateWriteFailed({
        traceId: command.trace.traceId,
        deploymentId,
        operation: 'persist_unexpected_deployment_failure',
      });
      return null;
    }
    if (!deployment || TERMINAL_STATUSES.has(deployment.status)) return deployment || null;

    try {
      const reconciled = await commits.reconcile(deployment, command.environment, command.trace);
      if (TERMINAL_STATUSES.has(reconciled?.status)) return reconciled;
    } catch {
      repairs.report({
        environment: command.environment,
        siteId: command.trace.siteId,
        deploymentId,
        reason: 'deployment_commit_reconciliation_failed',
      });
      return deployment;
    }

    let site = null;
    if (command.trace.siteId) {
      try {
        site = await sites.load(command.trace.siteId, command.environment);
      } catch {
        // Failure persistence is still useful when optional webhook context cannot be loaded.
      }
    }
    try {
      return await failures.complete({
        deploymentId,
        patch: failures.patch(command.trace.operation),
        actor: command.actor,
        site,
        trace: command.trace,
      });
    } catch (error) {
      if (error?.code !== 'DEPLOYMENT_STATE_WRITE_FAILED') throw error;
      return deployment;
    }
  }
}
