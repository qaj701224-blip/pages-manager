import { createWfpClient, readWfpConfig } from '../../../packages/wfp-client/src/index.js';

export function createDeploymentProvider(env, config) {
  if (env.WFP_PROVIDER) return env.WFP_PROVIDER;
  const wfpConfig = readWfpConfig(env, { environment: config.environment });
  const client = createWfpClient(wfpConfig);
  return {
    async upload(input) {
      return client.uploadUserWorker({
        scriptName: input.workerName,
        mainModule: input.artifactBundle.mainModule,
        modules: input.artifactBundle.modules,
        compatibilityDate: env.WFP_COMPATIBILITY_DATE,
        tags: ['pages-v2', config.environment, input.site.slug],
      });
    },
    async verify(input) {
      return client.getUserWorker(input.workerName);
    },
    async delete(input) {
      return client.deleteUserWorker(input.workerName);
    },
  };
}

export function normalizeArtifactBundle(input) {
  const bundle = input.artifactBundle || generatedArtifactBundle(input);
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) throw new Error('ARTIFACT_BUNDLE_INVALID');
  if (bundle.kind !== input.artifactKind) throw new Error('ARTIFACT_BUNDLE_KIND_MISMATCH');
  if (typeof bundle.mainModule !== 'string' || bundle.mainModule === '') throw new Error('ARTIFACT_BUNDLE_MAIN_INVALID');
  if (!Array.isArray(bundle.modules) || bundle.modules.length === 0) throw new Error('ARTIFACT_BUNDLE_MODULES_INVALID');
  if (!bundle.modules.some((module) => module.name === bundle.mainModule)) throw new Error('ARTIFACT_BUNDLE_MAIN_MISSING');

  return {
    kind: bundle.kind,
    mainModule: bundle.mainModule,
    modules: bundle.modules.map((module) => normalizeModule(module)),
  };
}

function normalizeModule(module) {
  if (!module || typeof module !== 'object') throw new Error('ARTIFACT_BUNDLE_MODULE_INVALID');
  if (typeof module.name !== 'string' || module.name === '') throw new Error('ARTIFACT_BUNDLE_MODULE_INVALID');
  if (typeof module.content !== 'string') throw new Error('ARTIFACT_BUNDLE_MODULE_INVALID');
  return {
    name: module.name,
    content: module.content,
    type: typeof module.type === 'string' && module.type ? module.type : 'application/javascript+module',
  };
}

function generatedArtifactBundle({ artifactKind, contentHash }) {
  const escapedHash = JSON.stringify(contentHash);
  const body = JSON.stringify(`XD Pages artifact ${contentHash}`);
  const content = [
    'export default {',
    `  fetch() { return new Response(${body}, { headers: { 'X-XD-Pages-Content-Hash': ${escapedHash} } }); }`,
    '};',
  ].join('\n');
  return {
    kind: artifactKind,
    mainModule: 'worker.mjs',
    modules: [
      {
        name: 'worker.mjs',
        type: 'application/javascript+module',
        content,
      },
    ],
  };
}
