export function createDeploymentWebhookTeamsPort(store) {
  return {
    get: typeof store?.getTeam === 'function' ? store.getTeam.bind(store) : null,
  };
}
