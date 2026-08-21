import assert from 'node:assert/strict';
import test from 'node:test';

import { readApiConfig } from './api-config.js';
import { readAlertConfig, readWebhookEncryptionConfig } from './integration-config.js';
import {
  readAccessKeyPepper,
  readActiveAccessKeyPepper,
  readCliAccessKeyTtlSeconds,
  readConnectionAuthConfig,
} from './identity-config.js';
import { readLegacyCloudflareConfig } from './legacy-config.js';
import { readOrgDirectoryConfig } from './org-directory-config.js';
import { readWfpProviderConfig } from './provider-config.js';
import { readRuntimeConfigHashPepper, readSiteSecretStoreConfig } from './runtime-config.js';

test('api config keeps environment origins fail closed', () => {
  assert.equal(readApiConfig({ PAGES_ENV: 'production' }).apiBaseUrl, 'https://api.pages.xd.team');
  assert.throws(
    () => readApiConfig({ PAGES_ENV: 'production', PUBLIC_API_BASE: 'https://api-staging.pages.xd.team' }),
    /API base/
  );
});

test('identity config reads only the requested pepper and preserves CLI TTL policy', () => {
  const env = {
    ACCESS_KEY_ACTIVE_PEPPER_ID: 'pepper_2',
    ACCESS_KEY_PEPPERS: 'pepper_1:PEPPER_ONE,pepper_2:PEPPER_TWO',
    PEPPER_ONE: 'secret-one',
    PEPPER_TWO: 'secret-two',
  };

  assert.equal(readAccessKeyPepper(env, 'pepper_1'), 'secret-one');
  assert.deepEqual(readActiveAccessKeyPepper(env), { id: 'pepper_2', secret: 'secret-two' });
  assert.equal(readCliAccessKeyTtlSeconds({}), 31_536_000);
  assert.equal(readCliAccessKeyTtlSeconds({ CLI_ACCESS_KEY_TTL_SECONDS: '0' }), 0);
  assert.equal(readCliAccessKeyTtlSeconds({ CLI_ACCESS_KEY_TTL_SECONDS: '-1' }), 31_536_000);
});

test('identity config enables Cindy assertions only with a complete trusted contract', () => {
  assert.deepEqual(
    readConnectionAuthConfig({
      CINDY_CONNECTION_AUDIENCE: 'xd:xd-sites',
      CINDY_CONNECTION_ISSUERS: 'https://auth.cindy.app,https://auth.cindy.com.cn',
    }),
    {
      audience: 'xd:xd-sites',
      orgSlug: 'xd',
      issuers: ['https://auth.cindy.app', 'https://auth.cindy.com.cn'],
    }
  );
  assert.equal(
    readConnectionAuthConfig({
      CINDY_CONNECTION_AUDIENCE: 'xd:xd-sites',
      CINDY_CONNECTION_ISSUERS: 'http://auth.cindy.app',
    }),
    null
  );
});

test('provider config validates environment namespace and returns only provider values', () => {
  assert.deepEqual(
    readWfpProviderConfig(
      {
        CF_ACCOUNT_ID: 'account',
        CF_API_TOKEN: 'token',
        WFP_DISPATCH_NAMESPACE: 'xd-cell-workers-staging',
        WFP_COMPATIBILITY_DATE: '2026-06-15',
        PAGES_USER_WORKER_VPC_TUNNEL_ID: ' tunnel ',
      },
      { environment: 'staging' }
    ),
    {
      accountId: 'account',
      apiToken: 'token',
      dispatchNamespace: 'xd-cell-workers-staging',
      apiBaseUrl: 'https://api.cloudflare.com/client/v4',
      environment: 'staging',
      compatibilityDate: '2026-06-15',
      userWorkerVpcTunnelId: 'tunnel',
    }
  );
});

test('runtime config preserves hash pepper precedence and legacy encryption fallback', () => {
  assert.equal(readRuntimeConfigHashPepper({ RUNTIME_CONFIG_HASH_PEPPER: 'runtime' }), 'runtime');
  assert.equal(
    readRuntimeConfigHashPepper({
      ACCESS_KEY_ACTIVE_PEPPER_ID: 'pepper_1',
      ACCESS_KEY_PEPPERS: 'pepper_1:PEPPER_ONE',
      PEPPER_ONE: 'active',
      REQUEST_HASH_PEPPER: 'request',
    }),
    'active'
  );
  assert.deepEqual(readSiteSecretStoreConfig({ PAGES_SECRET_ENCRYPTION_KEY: 'legacy' }), {
    secretEncryptionKey: 'legacy',
  });
});

test('optional integration configs stay scoped to their capability', () => {
  const vpc = { fetch: async () => new Response() };
  const directory = readOrgDirectoryConfig({ XDS_OPENAI_TOKEN: ' token ', XD_OFFICE_NET: vpc });
  assert.equal(directory.token, 'token');
  assert.equal(typeof directory.fetchImpl, 'function');
  assert.equal(readOrgDirectoryConfig({ XDS_OPENAI_TOKEN: 'token' }), null);

  assert.equal(readLegacyCloudflareConfig({}), null);
  assert.deepEqual(readWebhookEncryptionConfig({ WEBHOOK_URL_ENCRYPTION_KEY: 'key' }), { encryptionKey: 'key' });
  assert.equal(readAlertConfig({}).mentionUserId, 'U06QLFY2XCK');
});
