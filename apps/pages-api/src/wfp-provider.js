import { BINDINGS } from '@xd/pages-runtime-protocol';
import { createWfpClient } from '@xd/wfp-client';
import { readWfpProviderConfig } from './infrastructure/config/provider-config.js';
import { runtimeBindingsForProvider } from './runtime-config.js';

export function createDeploymentProvider(env, config) {
  if (env.WFP_PROVIDER) return withWfpMetadata(env.WFP_PROVIDER);
  const providerConfig = readWfpProviderConfig(env, { environment: config.environment });
  const client = createWfpClient({ ...providerConfig, fetch: env.fetch || globalThis.fetch });
  return withWfpMetadata({
    async upload(input) {
      return client.uploadUserWorker({
        scriptName: input.workerName,
        mainModule: input.artifactBundle?.mainModule,
        modules: input.artifactBundle?.modules,
        decision: input.decision,
        assetManifest: input.assetManifest,
        assetFiles: input.assetFiles,
        compatibilityDate: providerConfig.compatibilityDate,
        tags: ['pages-v2', config.environment, input.site.slug],
        bindings: [
          kvGatewayServiceBinding(config.environment),
          ...userWorkerVpcNetworkBindings(providerConfig, input.decision, input.exposure),
          ...runtimeBindingsForProvider(input.runtimeBindings),
        ],
      });
    },
    async verify(input) {
      return client.getUserWorker(input.workerName);
    },
    async delete(input) {
      return client.deleteUserWorker(input.workerName);
    },
    async putSecret(input) {
      return client.putUserWorkerSecret(input.workerName, {
        name: input.name,
        value: input.value,
      }, { signal: input.signal });
    },
    async deleteSecret(input) {
      return client.deleteUserWorkerSecret(input.workerName, input.name, { signal: input.signal });
    },
    async removeOfficeNetBinding(input) {
      return client.removeOfficeNetBinding(input.workerName, { signal: input.signal });
    },
    async verifyOfficeNetAbsent(input) {
      return client.verifyOfficeNetAbsent(input.workerName, { signal: input.signal });
    },
    async replacePlainTextBindings(input) {
      return client.updateUserWorkerBindings(input.workerName, {
        bindings: runtimeBindingsForProvider({ vars: input.vars || {} }),
        signal: input.signal,
      });
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

function userWorkerVpcNetworkBindings(config, decision, exposure = 'internal') {
  if (!decisionUsesUserWorker(decision)) return [];
  if (exposure === 'public') return [];
  const tunnelId = config.userWorkerVpcTunnelId;
  if (!tunnelId) return [];
  return [
    {
      type: 'vpc_network',
      name: 'XD_OFFICE_NET',
      tunnel_id: tunnelId,
    },
  ];
}

function decisionUsesUserWorker(decision) {
  return decision?.deploymentShape === 'worker-only' || decision?.deploymentShape === 'worker-with-assets';
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
    async putSecret(input) {
      return provider.putSecret?.(input);
    },
    async deleteSecret(input) {
      return provider.deleteSecret?.(input);
    },
    async removeOfficeNetBinding(input) {
      return provider.removeOfficeNetBinding?.(input);
    },
    async verifyOfficeNetAbsent(input) {
      return provider.verifyOfficeNetAbsent?.(input);
    },
    async replacePlainTextBindings(input) {
      return provider.replacePlainTextBindings?.(input);
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
