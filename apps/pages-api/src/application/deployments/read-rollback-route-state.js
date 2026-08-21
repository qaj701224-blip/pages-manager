export function createRollbackRouteStateRead({ routes }) {
  if (typeof routes?.getBySiteId !== 'function') throw new TypeError('routes.getBySiteId is required');

  return { read };

  async function read(command) {
    let route;
    try {
      route = await routes.getBySiteId(command.siteId, command.environment);
    } catch (cause) {
      return {
        ok: false,
        error: {
          code: 'ROLLBACK_ACTIVATION_FAILED',
          reason: 'route_read_failed',
          cause,
        },
      };
    }
    return route
      ? { ok: true, route }
      : {
          ok: false,
          error: {
            code: 'ROUTE_ACTIVATION_CONFLICT',
            reason: 'route_missing',
          },
        };
  }
}
