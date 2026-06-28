import { createWfpClient, readWfpConfig } from '../../../packages/wfp-client/src/index.js';
import { BINDINGS } from '../../../packages/pages-runtime-protocol/src/index.js';
import { runtimeBindingsForProvider } from './runtime-config.js';

export function createDeploymentProvider(env, config) {
  if (env.WFP_PROVIDER) return withWfpMetadata(env.WFP_PROVIDER);
  const wfpConfig = readWfpConfig(env, { environment: config.environment });
  const client = createWfpClient({ ...wfpConfig, fetch: env.fetch || globalThis.fetch });
  return withWfpMetadata({
    async upload(input) {
      return client.uploadUserWorker({
        scriptName: input.workerName,
        mainModule: input.artifactBundle?.mainModule,
        modules: input.artifactBundle?.modules,
        decision: input.decision,
        assetManifest: input.assetManifest,
        assetFiles: input.assetFiles,
        compatibilityDate: env.WFP_COMPATIBILITY_DATE,
        tags: ['pages-v2', config.environment, input.site.slug],
        bindings: [kvGatewayServiceBinding(config.environment), ...runtimeBindingsForProvider(input.runtimeBindings)],
      });
    },
    async verify(input) {
      return client.getUserWorker(input.workerName);
    },
    async delete(input) {
      return client.deleteUserWorker(input.workerName);
    },
  });
}

export function kvGatewayServiceBinding(environment) {
  return {
    type: 'service',
    name: BINDINGS.KV_GATEWAY,
    service: environment === 'staging' ? 'pages-kv-gateway-staging' : 'pages-kv-gateway',
  };
}

function withWfpMetadata(provider) {
  return {
    executionProvider: 'wfp',
    async upload(input) {
      const result = await provider.upload(input);
      return {
        ...result,
        runtime: 'worker',
        executionProvider: 'wfp',
        workerName: result?.scriptName || input.workerName,
        dispatchType: 'dispatch-namespace',
        dispatchBindingName: null,
        slotId: null,
      };
    },
    async verify(input) {
      return provider.verify(input);
    },
    async delete(input) {
      return provider.delete?.(input);
    },
  };
}

export function normalizeWorkerBundle(bundle) {
  if (bundle === undefined || bundle === null) throw new Error('ARTIFACT_BUNDLE_REQUIRED');
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) throw new Error('ARTIFACT_BUNDLE_INVALID');
  if (typeof bundle.mainModule !== 'string' || bundle.mainModule === '') throw new Error('ARTIFACT_BUNDLE_MAIN_INVALID');
  if (!Array.isArray(bundle.modules) || bundle.modules.length === 0) throw new Error('ARTIFACT_BUNDLE_MODULES_INVALID');
  if (!bundle.modules.some((module) => module.name === bundle.mainModule)) throw new Error('ARTIFACT_BUNDLE_MAIN_MISSING');

  return {
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
