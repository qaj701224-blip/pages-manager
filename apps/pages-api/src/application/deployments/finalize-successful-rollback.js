export function createSuccessfulRollbackFinalization({ completion, telemetry, clock }) {
  if (typeof completion?.complete !== 'function') throw new TypeError('completion.complete is required');
  if (typeof telemetry?.webhookSkipped !== 'function') throw new TypeError('telemetry.webhookSkipped is required');
  if (typeof clock?.now !== 'function') throw new TypeError('clock.now is required');

  return { finalize };

  async function finalize(command) {
    const completed = await completion.complete({
      deployment: command.deployment,
      versionId: command.version.id,
      previousVersionId: command.previousRoute.activeVersionId,
      completedAt: clock.now(),
    });
    await telemetry.webhookSkipped();
    return completed;
  }
}
