import { canonicalDeploymentContentHash, decisionRequiresAssets, decisionRequiresWorker } from '../../deployment-plan.js';
import { validateAssetFiles } from '../../deployment-upload.js';
import { isSiteVisibility } from '../../domain/sites/access-policy.js';
import { normalizeSiteMetadataPatch } from '../../domain/sites/metadata.js';
import { normalizeWorkerBundle } from '../../execution-provider.js';
import { jsonError } from '../../http.js';
import { rejectUserExposureMutation } from '../shared/site-input.js';
import { readDeploymentIntakeHeaders, readDeploymentMultipart } from './deployment-intake.js';
import { queueRequestTraceSuccess, setRequestTraceStage, traceFailureResponse } from './deployment-request-trace.js';
import { normalizeOptionalSlug, normalizeOptionalString, validateDeploySiteSlug } from './deployment-site-resolution.js';
import { siteTitleInvalid } from './deployment-errors.js';

export async function readDeploySiteRequest({ request, config, trace }) {
  setRequestTraceStage(trace, 'intake', 'read_deployment_request');
  const headers = readDeploymentIntakeHeaders(request);
  if (!headers.ok) return failed(traceFailureResponse(trace, headers.response, headers.traceFailure));

  setRequestTraceStage(trace, 'intake', 'parse_multipart');
  const multipart = await readDeploymentMultipart(request);
  if (!multipart.ok) {
    return failed(
      multipart.traceFailure ? traceFailureResponse(trace, multipart.response, multipart.traceFailure) : multipart.response
    );
  }
  queueRequestTraceSuccess(trace, 'intake', 'parse_multipart');
  setRequestTraceStage(trace, 'payload_validation', 'validate_deployment_payload');

  const { idempotencyKey } = headers;
  const { body } = multipart;
  const exposureError = rejectUserExposureMutation(body);
  if (exposureError) return failed(exposureError);

  const requestedSiteId = normalizeOptionalString(body.siteId);
  const requestedSiteSlug = normalizeOptionalSlug(body.siteSlug ?? body.slug);
  const requestedTeamId = normalizeOptionalString(body.teamId);
  const requestedVisibility = normalizeOptionalString(body.visibility);
  const requestedTitleProvided = Object.hasOwn(body, 'title');
  let requestedTitle;
  if (requestedTitleProvided) {
    try {
      requestedTitle = normalizeSiteMetadataPatch({ title: body.title }, { environment: config.environment }).title;
    } catch (error) {
      if (error?.code === 'SITE_TITLE_INVALID') return failed(siteTitleInvalid());
      throw error;
    }
  }
  const clientContentHash = typeof body.contentHash === 'string' ? body.contentHash : '';
  const source = typeof body.source === 'string' ? body.source : 'api';
  const decision = body.decision;
  const workerRuntimeVarsProvided = decisionRequiresWorker(decision) && body.varsProvided;
  const requestedRuntimeVars = workerRuntimeVarsProvided ? body.vars : undefined;
  let artifactBundle;
  let assetManifest;
  let assetFiles;
  let canonicalContentHash;

  if (!requestedSiteId && !requestedSiteSlug) {
    return failed(jsonError('SITE_REQUIRED', 'Site is required.', 400, 'Pass siteId or siteSlug.'));
  }
  if (requestedSiteSlug) {
    const slugError = validateDeploySiteSlug(requestedSiteSlug, config.environment, { allowReserved: true });
    if (slugError) return failed(slugError);
  }
  if (requestedVisibility && !isSiteVisibility(requestedVisibility)) {
    return failed(
      jsonError('SITE_VISIBILITY_INVALID', 'Site visibility is invalid.', 400, 'Use internal, org, acl, owner, or disabled.')
    );
  }
  if (!clientContentHash.startsWith('sha256:')) {
    return failed(jsonError('CONTENT_HASH_INVALID', 'Content hash is invalid.', 400, 'Pass a sha256 content hash.'));
  }
  if (decisionRequiresWorker(decision)) {
    try {
      artifactBundle = normalizeWorkerBundle(body.artifactBundle);
    } catch {
      return failed(
        jsonError('PUBLISH_PLAN_INVALID', 'Publish plan is invalid.', 400, 'Run xd-cell deploy --dry-run and retry.')
      );
    }
  }
  if (decisionRequiresAssets(decision)) {
    assetManifest = body.assetManifest;
    assetFiles = body.assetFiles;
    if (!assetManifest || typeof assetManifest !== 'object' || Array.isArray(assetManifest)) {
      return failed(
        jsonError('ASSET_MANIFEST_INVALID', 'Asset manifest is invalid.', 400, 'Run xd-cell deploy --dry-run and retry.')
      );
    }
    if (!Array.isArray(assetFiles) || assetFiles.length === 0) {
      return failed(jsonError('ASSET_FILES_REQUIRED', 'Asset files are required.', 400, 'Upload at least one asset file.'));
    }
    const assetFileError = validateAssetFiles(assetManifest, assetFiles);
    if (assetFileError === 'ASSET_MANIFEST_INVALID') {
      return failed(jsonError('ASSET_MANIFEST_INVALID', 'Asset manifest is invalid.', 400, 'Send a valid assetManifest field.'));
    }
    if (assetFileError === 'ASSET_FILES_REQUIRED') {
      return failed(
        jsonError('ASSET_FILES_REQUIRED', 'Asset files are required.', 400, 'Upload every file listed in assetManifest.')
      );
    }
  }
  try {
    canonicalContentHash = await canonicalDeploymentContentHash({ decision, assetManifest, assetFiles, artifactBundle });
  } catch (error) {
    if (error?.code === 'ASSET_MANIFEST_INVALID') {
      return failed(
        jsonError('ASSET_MANIFEST_INVALID', 'Asset manifest is invalid.', 400, 'Run xd-cell deploy --dry-run and retry.')
      );
    }
    if (error?.code === 'PUBLISH_PLAN_INVALID') {
      return failed(
        jsonError('PUBLISH_PLAN_INVALID', 'Publish plan is invalid.', 400, 'Run xd-cell deploy --dry-run and retry.')
      );
    }
    throw error;
  }
  if (clientContentHash !== canonicalContentHash) {
    return failed(
      traceFailureResponse(
        trace,
        jsonError(
          'CONTENT_HASH_MISMATCH',
          'Content hash does not match uploaded files.',
          400,
          'Run xd-cell deploy --dry-run and retry.'
        ),
        {
          stage: 'payload_validation',
          operation: 'validate_content_hash',
          errorCode: 'CONTENT_HASH_MISMATCH',
          errorMessage: 'Content hash does not match uploaded files.',
          diagnostics: { causeClass: 'payload_validation_error' },
        }
      )
    );
  }
  queueRequestTraceSuccess(trace, 'payload_validation', 'validate_deployment_payload');

  return {
    ok: true,
    input: {
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
      assetFiles,
      canonicalContentHash,
    },
  };
}

function failed(response) {
  return { ok: false, response };
}
