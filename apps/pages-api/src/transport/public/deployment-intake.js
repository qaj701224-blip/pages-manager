import { isMultipartRequest, readMultipartDeploymentBody } from '../../deployment-upload.js';
import { jsonError } from '../../http.js';

const encoder = new globalThis.TextEncoder();

export function readDeploymentIntakeHeaders(request) {
  const idempotencyKey = readIdempotencyKey(request);
  if (!idempotencyKey) {
    return failedIntake(deploymentIdempotencyKeyRequired(), idempotencyKeyTraceFailure());
  }
  if (!isMultipartRequest(request)) {
    return failedIntake(cliUploadProtocolRequired(), cliUploadProtocolTraceFailure());
  }
  return { ok: true, idempotencyKey };
}

export async function readDeploymentMultipart(request) {
  try {
    return { ok: true, body: await readMultipartDeploymentBody(request) };
  } catch (error) {
    return deploymentMultipartError(error);
  }
}

export async function readRollbackIntake(request) {
  const idempotencyKey = readIdempotencyKey(request);
  if (!idempotencyKey) {
    return failedIntake(deploymentIdempotencyKeyRequired(), idempotencyKeyTraceFailure());
  }

  try {
    const body = await readOptionalJsonBody(request, { maxBytes: 32 * 1024 });
    return { ok: true, idempotencyKey, body };
  } catch {
    return failedIntake(jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.'), {
      stage: 'intake',
      operation: 'parse_json',
      errorCode: 'INVALID_JSON',
      errorMessage: 'Invalid JSON body.',
      diagnostics: { causeClass: 'payload_validation_error' },
    });
  }
}

export function deploymentMultipartError(error) {
  if (error?.code === 'PAYLOAD_TOO_LARGE') {
    return failedIntake(
      jsonError(
        'PAYLOAD_TOO_LARGE',
        'Deployment payload is too large.',
        413,
        'Reduce artifact size or use an asset store backed deployment path.'
      )
    );
  }
  if (error?.code === 'ASSET_MANIFEST_INVALID') {
    return failedIntake(
      jsonError('ASSET_MANIFEST_INVALID', 'Asset manifest is invalid.', 400, 'Send a valid assetManifest field.')
    );
  }
  if (error?.code === 'ASSET_FILES_REQUIRED') {
    return failedIntake(
      jsonError('ASSET_FILES_REQUIRED', 'Asset files are required.', 400, 'Upload every file listed in assetManifest.')
    );
  }
  if (error?.code === 'FALLBACK_REQUIRES_ASSETS') {
    return failedIntake(
      jsonError(
        'FALLBACK_REQUIRES_ASSETS',
        'Fallback can only be set for deployments with assets.',
        400,
        'Remove fallback for worker-only deployments or upload assets.'
      )
    );
  }
  if (error?.code === 'FALLBACK_INDEX_REQUIRES_INDEX_HTML') {
    return failedIntake(
      jsonError(
        'FALLBACK_INDEX_REQUIRES_INDEX_HTML',
        'Index fallback requires /index.html.',
        400,
        'Upload index.html or set assets.not_found_handling to 404-page.'
      )
    );
  }
  if (error?.code === 'PUBLISH_PLAN_VERSION_UNSUPPORTED') {
    return failedIntake(
      jsonError(
        'PUBLISH_PLAN_VERSION_UNSUPPORTED',
        'Publish plan version is unsupported.',
        400,
        'Upgrade the XD Cell CLI and retry.'
      )
    );
  }
  if (error?.code === 'PUBLISH_PLAN_INVALID') {
    return failedIntake(
      jsonError('PUBLISH_PLAN_INVALID', 'Publish plan is invalid.', 400, 'Run xd-cell deploy --dry-run and retry.')
    );
  }
  if (error?.code === 'CONTENT_HASH_MISMATCH') {
    return failedIntake(
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
    );
  }
  if (error?.code === 'RUNTIME_VARS_INVALID') {
    return failedIntake(
      jsonError(
        'RUNTIME_VARS_INVALID',
        'Runtime vars are invalid.',
        400,
        'Use non-sensitive string vars with valid Worker binding names.'
      )
    );
  }
  if (error?.code === 'RUNTIME_VARS_LIMIT_EXCEEDED') {
    return failedIntake(
      jsonError(
        'RUNTIME_BINDINGS_LIMIT_EXCEEDED',
        'Runtime bindings exceed platform limits.',
        400,
        'Reduce vars or secret size/count and retry.'
      )
    );
  }
  if (error?.code === 'CLI_UPLOAD_PROTOCOL_REQUIRED') {
    return failedIntake(cliUploadProtocolRequired(), cliUploadProtocolTraceFailure());
  }
  return failedIntake(jsonError('INVALID_MULTIPART', 'Invalid multipart body.', 400, 'Run xd-cell deploy --dry-run and retry.'), {
    stage: 'intake',
    operation: 'parse_multipart',
    errorCode: 'INVALID_MULTIPART',
    errorMessage: 'Invalid multipart body.',
    diagnostics: { causeClass: 'payload_validation_error' },
  });
}

function readIdempotencyKey(request) {
  const value = request.headers.get('Idempotency-Key');
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function deploymentIdempotencyKeyRequired() {
  return jsonError('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required.', 400, 'Send an Idempotency-Key header.');
}

function idempotencyKeyTraceFailure() {
  return {
    stage: 'intake',
    operation: 'read_idempotency_key',
    errorCode: 'IDEMPOTENCY_KEY_REQUIRED',
    errorMessage: 'Idempotency-Key is required.',
    diagnostics: { causeClass: 'request_validation_error' },
  };
}

function cliUploadProtocolRequired() {
  return jsonError(
    'CLI_UPLOAD_PROTOCOL_REQUIRED',
    'Deployment uploads must be generated by the XD Cell CLI.',
    400,
    'Run `xd-cell deploy` or `xd-cell deploy --dry-run --json` and retry.'
  );
}

function cliUploadProtocolTraceFailure() {
  return {
    stage: 'intake',
    operation: 'parse_multipart',
    errorCode: 'CLI_UPLOAD_PROTOCOL_REQUIRED',
    errorMessage: 'Deployment uploads must use the CLI protocol.',
    diagnostics: { causeClass: 'payload_validation_error' },
  };
}

async function readOptionalJsonBody(request, { maxBytes }) {
  const text = await request.text();
  if (encoder.encode(text).byteLength > maxBytes) throw new Error('JSON body is too large');
  if (!text.trim()) return {};
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON object is required');
  return parsed;
}

function failedIntake(response, traceFailure) {
  return { ok: false, response, ...(traceFailure ? { traceFailure } : {}) };
}
