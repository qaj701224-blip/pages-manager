export function createDeploymentActivationFailureRecovery({ workers, runtimeConfig, ownerTransfers }) {
  if (typeof workers?.cleanup !== 'function') throw new TypeError('workers.cleanup is required');
  if (typeof runtimeConfig?.restore !== 'function') throw new TypeError('runtimeConfig.restore is required');
  if (typeof ownerTransfers?.restore !== 'function') throw new TypeError('ownerTransfers.restore is required');

  return { recover };

  async function recover(command) {
    await workers.cleanup(command.worker);
    await runtimeConfig.restore(command.runtimeConfig);
    const restoredSite = await ownerTransfers.restore(command.ownerTransfer);
    return { site: restoredSite || command.site };
  }
}
