import { canonicalRequestHash } from '../../crypto.js';
import { runtimeConfigHashInput } from '../../deployment-runtime-config.js';
import { bindDeploymentTrace, recordDeploymentStage, withDeploymentTraceHeader } from '../../deployment-trace.js';
import { actorCanDeploySite } from '../../domain/sites/authorization.js';
import { jsonError, jsonOk } from '../../http.js';
import { deploySiteResolutionErrorResponse, deploymentStateWriteFailed } from '../shared/deployment-responses.js';
import { idempotencyConflict } from './deployment-errors.js';
import {
  bindExistingDeploymentTrace,
  createDeploymentRecordApplication,
  reconcileCommittedDeployment,
  recoverFailedDeploymentsForSite,
} from './deployment-lifecycle-runtime.js';
import { deploymentEnvelope } from './deployment-projection.js';
import {
  clearRequestTraceStage,
  discardReplayRequestTrace,
  finishRequestAuthStageFromResponse,
  finishValidatedRequestTrace,
  setRequestTraceStage,
  traceFailureResponse,
} from './deployment-request-trace.js';
import { createDeploySiteResolutionApplication, validateDeployableSiteSlug } from './deployment-site-resolution.js';
import { traceSucceeded } from './deployment-stage-trace.js';

export async function startDeploySite({ input, env, config, store, actor, ctx, trace, authStage }) {
  const {
    idempotencyKey,
    requestedSiteId,
    requestedSiteSlug,
    requestedTeamId,
    requestedVisibility,
    requestedTitleProvided,
    requestedTitle,
    source,
    decision,
    workerRuntimeVarsProvided,
    requestedRuntimeVars,
    artifactBundle,
    assetManifest,
    canonicalContentHash,
  } = input;

  setRequestTraceStage(trace, 'auth_and_site_resolution', 'resolve_site');
  const resolution = await createDeploySiteResolutionApplication({ store, env, config }).resolve({
    actor,
    environment: config.environment,
    siteId: requestedSiteId,
    siteSlug: requestedSiteSlug,
    teamId: requestedTeamId,
    visibility: requestedVisibility || 'org',
    requestedVisibility,
    title: requestedTitleProvided ? requestedTitle : null,
  });
  if (!resolution.ok) {
    const response = deploySiteResolutionErrorResponse(resolution.error);
    await finishRequestAuthStageFromResponse(authStage, response, 'site_resolution_error');
    return failed(response);
  }
  const site = resolution.site;
  const routeSlugError = validateDeployableSiteSlug(site.slug, config.environment);
  if (routeSlugError) {
    await finishRequestAuthStageFromResponse(authStage, routeSlugError, 'site_resolution_error');
    return failed(routeSlugError);
  }
  const siteId = site.id;
  if (!actorCanDeploySite(actor, site, 'deploy:site')) {
    const response = jsonError('DEPLOY_FORBIDDEN', 'Actor cannot deploy this site.', 403, 'Use a token scoped to this site.');
    await finishRequestAuthStageFromResponse(authStage, response, 'authorization_error');
    return failed(response);
  }
  await recoverFailedDeploymentsForSite({ store, env, config, ctx, actor, site });

  setRequestTraceStage(trace, 'runtime_config', 'build_request_hash');
  let requestHash;
  try {
    requestHash = await canonicalRequestHash({
      operation: 'deploy',
      siteId,
      decision,
      contentHash: canonicalContentHash,
      artifactBundle,
      assetManifest,
      source,
      teamId: requestedTeamId || null,
      visibility: requestedVisibility || null,
      ...(requestedTitleProvided ? { titleIntent: { provided: true, value: requestedTitle } } : {}),
      vars: workerRuntimeVarsProvided ? await runtimeConfigHashInput(env, requestedRuntimeVars, []) : undefined,
    });
  } catch {
    return failed(
      jsonError(
        'RUNTIME_CONFIG_UNSUPPORTED',
        'Runtime configuration is unavailable.',
        503,
        'Check runtime configuration and retry with a new Idempotency-Key.'
      )
    );
  }

  setRequestTraceStage(trace, 'deployment_record', 'create_deployment');
  let deploymentResult;
  try {
    deploymentResult = await createDeploymentRecordApplication(store, env).createPending({
      environment: config.environment,
      actor,
      source,
      siteId,
      operation: 'deploy',
      idempotencyKey,
      requestHash,
      traceId: trace?.traceId || null,
      visibility: site.pendingOwnerTransfer?.visibility || site.defaultVisibility,
      previousVersionId: site.route?.activeVersionId || null,
    });
  } catch {
    await finishValidatedRequestTrace(trace, authStage);
    return failed(
      traceFailureResponse(trace, deploymentStateWriteFailed(), {
        stage: 'deployment_record',
        operation: 'create_deployment',
        errorCode: 'DEPLOYMENT_STATE_WRITE_FAILED',
        errorMessage: 'Deployment state could not be persisted.',
        diagnostics: { causeClass: 'deployment_store_error' },
      })
    );
  }

  if (deploymentResult.kind === 'conflict') {
    await finishValidatedRequestTrace(trace, authStage);
    return failed(
      traceFailureResponse(trace, idempotencyConflict(), {
        stage: 'payload_validation',
        operation: 'idempotency_conflict',
        errorCode: 'IDEMPOTENCY_CONFLICT',
        errorMessage: 'Idempotency-Key conflicts with an existing deployment.',
        diagnostics: { causeClass: 'idempotency_conflict' },
      })
    );
  }
  if (deploymentResult.kind === 'existing') {
    const traceBinding = await bindExistingDeploymentTrace(trace, store, deploymentResult.deployment, config.environment);
    const existingDeployment = traceBinding.deployment;
    discardReplayRequestTrace(trace, authStage);
    if (traceBinding.claimFailed) {
      await recordDeploymentStage(trace, {
        stage: 'deployment_record',
        operation: 'claim_deployment_trace',
        status: 'failed',
        errorCode: 'DEPLOYMENT_STATE_WRITE_FAILED',
        errorMessage: 'Deployment state could not be persisted.',
        diagnostics: { causeClass: 'deployment_store_error' },
      });
    }
    await traceSucceeded(trace, { stage: 'deployment_record', operation: 'idempotency_replay' });
    clearRequestTraceStage(trace);
    const reconciled = await reconcileCommittedDeployment(store, existingDeployment, config.environment, env, trace);
    return failed(
      withDeploymentTraceHeader(jsonOk(await deploymentEnvelope(store, reconciled, {}, config.environment)), trace.traceId)
    );
  }

  const deployment = deploymentResult.deployment;
  bindDeploymentTrace(trace, { deploymentId: deployment.id, siteId });
  await finishValidatedRequestTrace(trace, authStage);
  await traceSucceeded(trace, { stage: 'deployment_record', operation: 'create_deployment' });
  clearRequestTraceStage(trace);
  return { ok: true, site, siteId, deployment };
}

function failed(response) {
  return { ok: false, response };
}
