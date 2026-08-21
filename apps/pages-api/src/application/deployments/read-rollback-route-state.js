export function createRollbackRouteStateRead({ routes, telemetry }) {
  if (typeof routes?.getBySiteId !== 'function') throw new TypeError('routes.getBySiteId is required');
  if (typeof telemetry?.failed !== 'function') throw new TypeError('telemetry.failed is required');

  return { read };

  async function read(command) {
    let result;
    try {
      const route = await routes.getBySiteId(command.siteId, command.environment);
      result = route
        ? { ok: true, route }
        : {
            ok: false,
            error: {
              code: 'ROUTE_ACTIVATION_CONFLICT',
              reason: 'route_missing',
            },
          };
    } catch (cause) {
      result = {
        ok: false,
        error: {
          code: 'ROLLBACK_ACTIVATION_FAILED',
          reason: 'route_read_failed',
          cause,
        },
      };
    }
    if (!result.ok) await telemetry.failed(result.error);
    return result;
  }
}
