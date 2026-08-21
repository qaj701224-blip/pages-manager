import { authenticateApiRequest } from '../../auth.js';
import { attachDeploymentTraceStore, createDeploymentTraceContext, startDeploymentStage } from '../../deployment-trace.js';
import {
  deploymentAuthErrorResponse,
  deploymentMethodNotAllowed,
  deploymentRequestFailed,
  deploymentStateWriteFailed,
} from '../shared/deployment-responses.js';

export function createDeploymentsHttpHandlers({ deploy, readDeployment, rollback, requestLifecycle }) {
  const { ensureFailureTraced, finishAuthStage, queueTraceSuccess, recoverUnexpected, unexpectedResponse, withTraceHeader } =
    requestLifecycle;

  async function handleDeploymentsApi(request, env, config, store, ctx) {
    const url = new URL(request.url);
    const trace =
      url.pathname === '/.xd-pages/api/deployments' && request.method === 'POST'
        ? createDeploymentTraceContext(request, env, {
            environment: config.environment,
            operation: 'deploy',
            deferPersistence: true,
            now: env?.now,
          })
        : null;
    if (trace) queueTraceSuccess(trace, 'intake', 'accept_request');
    const authStage = trace
      ? startDeploymentStage(trace, { stage: 'auth_and_site_resolution', operation: 'authenticate_request' })
      : null;
    let auth;
    try {
      auth = await authenticateApiRequest(request, env, store, config, readNow(env));
    } catch (error) {
      if (!trace) throw error;
      await finishAuthStage(authStage, {
        status: 'failed',
        errorCode: 'DEPLOYMENT_REQUEST_FAILED',
        errorMessage: 'Deployment request could not be processed.',
        diagnostics: { causeClass: 'authentication_error' },
      });
      return withTraceHeader(deploymentRequestFailed(), trace);
    }
    if (!auth.ok) {
      await finishAuthStage(authStage, {
        status: 'failed',
        errorCode: auth.error.code,
        errorMessage: auth.error.message,
        diagnostics: { causeClass: 'authentication_error' },
      });
      return withTraceHeader(deploymentAuthErrorResponse(auth.error), trace);
    }
    if (trace) attachDeploymentTraceStore(trace, store);

    if (url.pathname === '/.xd-pages/api/deployments') {
      if (request.method === 'POST') {
        let response;
        try {
          response = await deploy(request, env, config, store, auth.actor, ctx, trace, authStage);
        } catch (error) {
          if (error?.code === 'DEPLOYMENT_STATE_WRITE_FAILED') response = deploymentStateWriteFailed();
          else {
            await finishAuthStage(authStage, { status: 'succeeded' });
            const recoveredDeployment = await recoverUnexpected({
              trace,
              store,
              env,
              config,
              ctx,
              actor: auth.actor,
              fallbackOperation: 'orchestrate_deployment_request',
            });
            response = await unexpectedResponse(store, recoveredDeployment, config.environment);
          }
        }
        await finishAuthStage(authStage, { status: 'succeeded' });
        response = await ensureFailureTraced(trace, response);
        return withTraceHeader(response, trace);
      }
      return deploymentMethodNotAllowed();
    }

    const deploymentId = matchDeploymentId(url.pathname);
    if (deploymentId && request.method === 'GET') {
      return readDeployment(store, auth.actor, deploymentId, config.environment, env);
    }
    if (deploymentId) return deploymentMethodNotAllowed();
    return null;
  }

  async function handleVersionsApi(request, env, config, store, ctx) {
    const url = new URL(request.url);
    const versionId = matchRollbackVersionId(url.pathname);
    const trace =
      versionId && request.method === 'POST'
        ? createDeploymentTraceContext(request, env, {
            environment: config.environment,
            operation: 'rollback',
            deferPersistence: true,
            now: env?.now,
          })
        : null;
    if (trace) queueTraceSuccess(trace, 'intake', 'accept_request');
    const authStage = trace
      ? startDeploymentStage(trace, { stage: 'auth_and_site_resolution', operation: 'authenticate_request' })
      : null;
    let auth;
    try {
      auth = await authenticateApiRequest(request, env, store, config, readNow(env));
    } catch (error) {
      if (!trace) throw error;
      await finishAuthStage(authStage, {
        status: 'failed',
        errorCode: 'DEPLOYMENT_REQUEST_FAILED',
        errorMessage: 'Deployment request could not be processed.',
        diagnostics: { causeClass: 'authentication_error' },
      });
      return withTraceHeader(deploymentRequestFailed(), trace);
    }
    if (!auth.ok) {
      await finishAuthStage(authStage, {
        status: 'failed',
        errorCode: auth.error.code,
        errorMessage: auth.error.message,
        diagnostics: { causeClass: 'authentication_error' },
      });
      return withTraceHeader(deploymentAuthErrorResponse(auth.error), trace);
    }
    if (trace) attachDeploymentTraceStore(trace, store);

    if (versionId && request.method === 'POST') {
      let response;
      try {
        response = await rollback(request, env, config, store, auth.actor, versionId, ctx, trace, authStage);
      } catch (error) {
        if (error?.code === 'DEPLOYMENT_STATE_WRITE_FAILED') response = deploymentStateWriteFailed();
        else {
          await finishAuthStage(authStage, { status: 'succeeded' });
          const recoveredDeployment = await recoverUnexpected({
            trace,
            store,
            env,
            config,
            ctx,
            actor: auth.actor,
            fallbackOperation: 'orchestrate_rollback_request',
          });
          response = await unexpectedResponse(store, recoveredDeployment, config.environment);
        }
      }
      await finishAuthStage(authStage, { status: 'succeeded' });
      response = await ensureFailureTraced(trace, response);
      return withTraceHeader(response, trace);
    }
    if (versionId) return deploymentMethodNotAllowed();
    return null;
  }

  return { handleDeploymentsApi, handleVersionsApi };
}

function matchDeploymentId(pathname) {
  const match = pathname.match(/^\/\.xd-pages\/api\/deployments\/([^/]+)$/);
  return match ? match[1] : null;
}

function matchRollbackVersionId(pathname) {
  const match = pathname.match(/^\/\.xd-pages\/api\/versions\/([^/]+)\/rollback$/);
  return match ? match[1] : null;
}

function readNow(env) {
  if (typeof env?.now === 'function') return env.now();
  return new Date().toISOString();
}
