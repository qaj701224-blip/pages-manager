import { registerGithubRoutes } from './github-routes.js';
import { registerHealthRoutes } from './health-routes.js';
import { registerInternalRoutes } from './internal-routes.js';
import { registerPublishingRoutes } from './publishing-routes.js';
import { registerSlackRoutes } from './slack-routes.js';

export function registerGatewayRoutes(router) {
  registerHealthRoutes(router);
  registerPublishingRoutes(router);
  registerSlackRoutes(router);
  registerInternalRoutes(router);
  registerGithubRoutes(router);
}
