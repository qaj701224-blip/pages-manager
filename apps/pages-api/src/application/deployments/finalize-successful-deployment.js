export function createSuccessfulDeploymentFinalization({ completion, cleanup, webhooks, lifecycle, taskScheduler, clock }) {
  if (typeof completion?.complete !== 'function') throw new TypeError('completion.complete is required');
  if (typeof cleanup?.cleanup !== 'function') throw new TypeError('cleanup.cleanup is required');
  if (typeof webhooks?.deliver !== 'function') throw new TypeError('webhooks.deliver is required');
  if (typeof lifecycle?.emitDisabled !== 'function') throw new TypeError('lifecycle.emitDisabled is required');
  if (typeof taskScheduler?.schedule !== 'function') throw new TypeError('taskScheduler.schedule is required');
  if (typeof clock?.now !== 'function') throw new TypeError('clock.now is required');

  return { finalize };

  async function finalize(command) {
    const completed = await completion.complete({
      deployment: command.deployment,
      versionId: command.version.id,
      previousVersionId: command.previousRoute?.activeVersionId || null,
      completedAt: clock.now(),
    });
    await cleanup.cleanup({
      environment: command.environment,
      previousRoute: command.previousRoute,
      activeRoute: command.route,
      deployment: completed,
    });
    const webhookDelivery = webhooks.deliver({
      actor: command.actor,
      site: command.site,
      route: command.route,
      deployment: completed,
      environment: command.environment,
    });
    await taskScheduler.schedule(webhookDelivery);
    await lifecycle.emitDisabled({
      actor: command.actor,
      site: command.site,
      previousRoute: command.previousRoute,
      route: command.route,
    });
    return completed;
  }
}
