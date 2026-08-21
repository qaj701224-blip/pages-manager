import { pagesMetadataMethods } from '@xd/pages-metadata';

import { readSiteSecretStoreConfig } from '../config/runtime-config.js';
import { accessKeysRepositoryMethods } from './repositories/access-keys-repository.js';
import { auditRepositoryMethods } from './repositories/audit-repository.js';
import { deploymentsRepositoryMethods } from './repositories/deployments-repository.js';
import { governanceRepositoryMethods } from './repositories/governance-repository.js';
import { identityRepositoryMethods } from './repositories/identity-repository.js';
import { runtimeConfigRepositoryMethods } from './repositories/runtime-config-repository.js';
import { sitesRepositoryMethods } from './repositories/sites-repository.js';
import { teamsRepositoryMethods } from './repositories/teams-repository.js';
import { webhooksRepositoryMethods } from './repositories/webhooks-repository.js';
import { workerSlotsRepositoryMethods } from './repositories/worker-slots-repository.js';
import { routeActivationMethods } from './transactions/route-activation.js';
import { runtimeConfigMutationMethods } from './transactions/runtime-config-mutation.js';
import { siteLifecycleMethods } from './transactions/site-lifecycle.js';
import { sitePolicyMethods } from './transactions/site-policy.js';

const storeMethodCollections = [
  pagesMetadataMethods,
  identityRepositoryMethods,
  webhooksRepositoryMethods,
  governanceRepositoryMethods,
  teamsRepositoryMethods,
  sitesRepositoryMethods,
  runtimeConfigRepositoryMethods,
  runtimeConfigMutationMethods,
  auditRepositoryMethods,
  workerSlotsRepositoryMethods,
  accessKeysRepositoryMethods,
  deploymentsRepositoryMethods,
  siteLifecycleMethods,
  sitePolicyMethods,
  routeActivationMethods,
];

export function createPagesStore(env = {}) {
  if (env.PAGES_STORE) return env.PAGES_STORE;
  if (!env.PAGES_METADATA) throw new Error('PAGES_METADATA binding is required');
  return new D1PagesStore(env.PAGES_METADATA, readSiteSecretStoreConfig(env));
}

export class D1PagesStore {
  constructor(db, { now = () => new Date().toISOString(), secretEncryptionKey = null } = {}) {
    this.db = db;
    this.now = now;
    this.secretEncryptionKey = secretEncryptionKey;
  }
}

installStoreMethods(D1PagesStore.prototype, storeMethodCollections);

function installStoreMethods(prototype, collections) {
  const installed = new Set();
  for (const collection of collections) {
    for (const [name, method] of Object.entries(collection)) {
      if (installed.has(name)) throw new Error(`Duplicate D1PagesStore method: ${name}`);
      installed.add(name);
      Object.defineProperty(prototype, name, {
        configurable: true,
        enumerable: false,
        value: method,
        writable: true,
      });
    }
  }
}
