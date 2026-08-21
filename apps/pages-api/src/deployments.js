import { actorCanReadSite } from './domain/sites/authorization.js';
import { jsonError, jsonOk } from './http.js';
import { createDeployment } from './transport/public/deploy-site-handler.js';
import { createDeploymentsHttpHandlers } from './transport/public/deployments-handler.js';
import {
  reconcileCommittedDeployment,
  recoverUnexpectedRequestFailure,
} from './transport/public/deployment-lifecycle-runtime.js';
import { deploymentEnvelope } from './transport/public/deployment-projection.js';
import {
  ensureRequestFailureTraced,
  finishRequestAuthStage,
  queueRequestTraceSuccess,
  withRequestTraceHeader,
} from './transport/public/deployment-request-trace.js';
import { rollbackVersion } from './transport/public/rollback-version-handler.js';
import { deploymentRequestFailed } from './transport/shared/deployment-responses.js';

const deploymentHttpHandlers = createDeploymentsHttpHandlers({
  deploy: createDeployment,
  readDeployment: getDeployment,
  rollback: rollbackVersion,
  requestLifecycle: {
    ensureFailureTraced: ensureRequestFailureTraced,
    finishAuthStage: finishRequestAuthStage,
    queueTraceSuccess: queueRequestTraceSuccess,
    recoverUnexpected: recoverUnexpectedRequestFailure,
    unexpectedResponse: unexpectedRequestResponse,
    withTraceHeader: withRequestTraceHeader,
  },
});

export function handleDeploymentsApi(request, env, config, store, ctx) {
  return deploymentHttpHandlers.handleDeploymentsApi(request, env, config, store, ctx);
}

export function handleVersionsApi(request, env, config, store, ctx) {
  return deploymentHttpHandlers.handleVersionsApi(request, env, config, store, ctx);
}

async function getDeployment(store, actor, deploymentId, environment, env) {
  let deployment = await store.getDeployment(deploymentId, environment);
  if (!deployment) return jsonError('DEPLOYMENT_NOT_FOUND', 'Deployment not found.', 404, 'Check the deployment id.');
  const site = await store.getSiteForUser(deployment.siteId, actor.userId, actor, environment);
  if (!site && actor.type === 'access_key' && typeof store.getSite === 'function') {
    const rawSite = await store.getSite(deployment.siteId);
    const rawSiteMatchesEnvironment = !environment || rawSite?.environment === environment;
    if (rawSite && !rawSite.deletedAt && rawSiteMatchesEnvironment && !actorCanReadSite(actor, rawSite)) {
      return deploymentReadForbidden();
    }
  }
  if (!site) return jsonError('DEPLOYMENT_NOT_FOUND', 'Deployment not found.', 404, 'Check the deployment id.');
  if (!actorCanReadSite(actor, site)) {
    return deploymentReadForbidden();
  }
  deployment = await reconcileCommittedDeployment(store, deployment, environment, env);
  return jsonOk(await deploymentEnvelope(store, deployment, {}, environment));
}

function deploymentReadForbidden() {
  return jsonError('DEPLOYMENT_READ_FORBIDDEN', 'Actor cannot read this deployment.', 403, 'Use a token with read:site scope.');
}

async function unexpectedRequestResponse(store, deployment, environment) {
  if (deployment?.status === 'succeeded') {
    try {
      return jsonOk(await deploymentEnvelope(store, deployment, {}, environment), 201);
    } catch {
      // Fall back to a status-first action when the committed envelope cannot be reconstructed.
    }
  }
  return deploymentRequestFailed();
}
