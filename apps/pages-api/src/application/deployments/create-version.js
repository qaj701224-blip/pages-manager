import { runtimeConfigSnapshot } from '../../domain/runtime-config/rules.js';

export function createDeploymentVersionCreation({ versions, runtimeConfig, telemetry }) {
  if (typeof runtimeConfig?.snapshotSecrets !== 'function') {
    throw new TypeError('runtimeConfig.snapshotSecrets is required');
  }
  if (typeof telemetry?.start !== 'function') throw new TypeError('telemetry.start is required');
  if (typeof telemetry?.finish !== 'function') throw new TypeError('telemetry.finish is required');

  return { create };

  function create(command) {
    const stage = telemetry.start();
    return createAfterStart(command, stage);
  }

  async function createAfterStart(command, stage) {
    try {
      const version = await versions.create({
        id: command.versionId,
        siteId: command.siteId,
        deploymentId: command.deploymentId,
        workerName: command.workerName,
        runtime: command.uploaded.runtime || 'worker',
        executionProvider: command.uploaded.executionProvider || command.executionProvider || 'wfp',
        dispatchType: command.uploaded.dispatchType || 'dispatch-namespace',
        dispatchBindingName: command.uploaded.dispatchBindingName || null,
        slotId: command.uploaded.slotId || null,
        artifactRef: command.uploaded.artifactRef,
        contentHash: command.contentHash,
        deploymentShape: command.decision.deploymentShape,
        requestedFallback: command.decision.requestedFallback,
        resolvedFallback: command.decision.resolvedFallback,
        routingMode: command.decision.routingMode,
        workerEntry: command.decision.workerEntry,
        assetsConfigJson: assetsConfigForStorage(command.decision),
        workerModulesJson: workerModulesForStorage(command.artifactBundle),
        assetManifestJson: assetManifestForStorage(command.assetManifest),
        canonicalContentHash: command.contentHash,
        varNamesJson: Object.keys(command.runtimeVars).sort(),
        secretNamesJson: command.runtimeSecrets.map((secret) => secret.name).sort(),
        runtimeConfigSnapshotJson: runtimeConfigSnapshot(
          command.runtimeVarRecords,
          await runtimeConfig.snapshotSecrets(command.runtimeSecrets)
        ),
        artifactAvailability: 'active',
        createdBy: command.actorId,
      });
      await telemetry.finish(stage, { status: 'succeeded' });
      return { ok: true, version };
    } catch (cause) {
      await telemetry.finish(stage, { status: 'failed', reason: 'version_create_error', cause });
      return { ok: false, error: { code: 'DEPLOYMENT_VERSION_CREATE_FAILED', cause } };
    }
  }
}

function assetsConfigForStorage(decision) {
  if (decision.deploymentShape === 'worker-only') return null;
  return {
    not_found_handling:
      decision.resolvedFallback === 'index'
        ? 'single-page-application'
        : decision.resolvedFallback === 'not-found'
          ? '404-page'
          : 'none',
    ...(decision.routingMode === 'worker-first' ? { run_worker_first: true } : {}),
  };
}

function workerModulesForStorage(artifactBundle) {
  return artifactBundle
    ? artifactBundle.modules.map((module) => ({
        moduleName: module.name,
        contentType: module.type,
        size: module.content.length,
      }))
    : null;
}

function assetManifestForStorage(assetManifest) {
  return assetManifest
    ? Object.entries(assetManifest).map(([assetPath, entry]) => ({
        path: assetPath,
        hash: entry.hash,
        size: Number(entry.size),
        contentType: entry.content_type || null,
      }))
    : null;
}
