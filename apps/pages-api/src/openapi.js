export function buildOpenApi(config) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'XD Pages API',
      version: '2.0.0',
      description: 'Control plane API for XD Pages.',
    },
    servers: [{ url: config.apiBaseUrl }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'CLI token or access key',
        },
      },
      schemas: {
        ErrorResponse: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message'],
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
                action: { type: 'string' },
              },
            },
          },
        },
        ArtifactModule: {
          type: 'object',
          required: ['name', 'content'],
          properties: {
            name: { type: 'string', examples: ['worker.mjs'] },
            content: { type: 'string', description: 'ES module source read by the CLI for custom Worker deploys.' },
            type: { type: 'string', examples: ['application/javascript+module'] },
          },
        },
        ArtifactBundle: {
          type: 'object',
          required: ['kind', 'mainModule', 'modules'],
          properties: {
            kind: { type: 'string', enum: ['worker'] },
            mainModule: { type: 'string', examples: ['worker.mjs'] },
            modules: {
              type: 'array',
              minItems: 1,
              items: { $ref: '#/components/schemas/ArtifactModule' },
            },
          },
        },
        DeploymentRequest: {
          type: 'object',
          required: ['artifactKind', 'contentHash', 'artifactBundle'],
          anyOf: [{ required: ['siteId'] }, { required: ['siteSlug'] }],
          properties: {
            siteId: {
              type: 'string',
              description: 'Internal site id. Usually resolved by the API; users normally provide siteSlug.',
            },
            siteSlug: {
              type: 'string',
              description: 'User-visible site slug. Unique within one environment and preferred for CLI/agent deploys.',
            },
            artifactKind: { type: 'string', enum: ['worker'] },
            contentHash: { type: 'string', pattern: '^sha256:' },
            artifactBundle: { $ref: '#/components/schemas/ArtifactBundle' },
            source: { type: 'string', examples: ['cli'] },
          },
        },
        StaticAssetDeploymentRequest: {
          type: 'object',
          required: ['artifactKind', 'contentHash', 'assetManifest'],
          anyOf: [{ required: ['siteId'] }, { required: ['siteSlug'] }],
          properties: {
            siteId: { type: 'string' },
            siteSlug: { type: 'string' },
            artifactKind: { type: 'string', enum: ['static', 'spa'] },
            contentHash: { type: 'string', pattern: '^sha256:' },
            source: { type: 'string', examples: ['cli'] },
            assetManifest: {
              type: 'string',
              description:
                'JSON object keyed by absolute asset path. Each value contains hash, size, and content_type. ' +
                'Static and SPA deploys use multipart files named file-0, file-1, ... with each filename set to ' +
                'the relative asset path.',
            },
            assetFileCount: { type: 'string' },
            assetSizeBytes: { type: 'string' },
            'file-0': {
              type: 'string',
              format: 'binary',
              description: 'First asset file. Additional files use file-1, file-2, ...',
            },
          },
        },
        SiteVisibility: {
          type: 'string',
          enum: ['internal', 'org', 'acl', 'owner', 'disabled'],
          description:
            'First release is protected by the router IP allowlist for every visibility. ' +
            'public is reserved for a future exposure model.',
        },
        SiteUpdateRequest: {
          type: 'object',
          required: ['visibility'],
          properties: {
            visibility: { $ref: '#/components/schemas/SiteVisibility' },
          },
        },
        SiteAclEntry: {
          type: 'object',
          required: ['subjectType', 'subjectValue'],
          properties: {
            subjectType: {
              type: 'string',
              enum: ['email'],
              description:
                'People are specified by email. Internal SSO user ids are not accepted as public ACL subjects. ' +
                'department and group are intentionally not enabled until organization directory semantics are stable.',
            },
            subjectValue: { type: 'string' },
            effect: {
              type: 'string',
              enum: ['allow'],
              default: 'allow',
              description: 'deny is not supported in the first release.',
            },
            accessRole: {
              type: 'string',
              enum: ['viewer'],
              default: 'viewer',
            },
          },
        },
        SiteAclReplaceRequest: {
          type: 'object',
          required: ['entries'],
          properties: {
            entries: {
              type: 'array',
              maxItems: 200,
              items: { $ref: '#/components/schemas/SiteAclEntry' },
            },
          },
        },
      },
    },
    paths: {
      '/.xd-pages/api/sites': {
        get: {
          summary: 'List sites visible to the authenticated actor; access keys require read:site',
          responses: {
            200: { description: 'Sites returned' },
            403: { description: 'Access key missing read:site scope' },
            401: { description: 'Authentication required' },
          },
        },
        post: {
          summary: 'Create a site',
          responses: {
            201: { description: 'Site created' },
            409: { description: 'Site slug conflict' },
          },
        },
      },
      '/.xd-pages/api/sites/{id}': {
        get: {
          summary: 'Get a site; access keys require read:site',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: 'Site returned' },
            403: { description: 'Access key missing read:site scope' },
            404: { description: 'Site not found' },
          },
        },
        patch: {
          summary: 'Update site visibility and invalidate existing site sessions by policyVersion',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/SiteUpdateRequest' },
              },
            },
          },
          'x-error-codes': ['SITE_VISIBILITY_INVALID', 'SITE_POLICY_FORBIDDEN', 'ROUTE_SNAPSHOT_WRITE_FAILED'],
          responses: {
            200: { description: 'Site policy updated' },
            400: { description: 'Invalid visibility' },
            403: { description: 'Only the site owner can manage site policy' },
            404: { description: 'Site not found' },
            503: { description: 'Route snapshot write failed' },
          },
        },
      },
      '/.xd-pages/api/sites/{id}/acl': {
        get: {
          summary: 'List site ACL entries',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: 'ACL entries returned' },
            404: { description: 'Site not found' },
          },
        },
        put: {
          summary: 'Replace site ACL entries using allow-only OR semantics',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/SiteAclReplaceRequest' },
              },
            },
          },
          'x-error-codes': [
            'ACL_ENTRIES_INVALID',
            'ACL_EFFECT_UNSUPPORTED',
            'ACL_ROLE_UNSUPPORTED',
            'ACL_SUBJECT_TYPE_UNSUPPORTED',
            'ACL_SUBJECT_VALUE_INVALID',
            'SITE_POLICY_FORBIDDEN',
            'ROUTE_SNAPSHOT_WRITE_FAILED',
          ],
          responses: {
            200: { description: 'ACL entries replaced' },
            400: { description: 'Invalid ACL request' },
            403: { description: 'Only the site owner can manage site ACL' },
            404: { description: 'Site not found' },
            503: { description: 'Route snapshot write failed' },
          },
        },
      },
      '/.xd-pages/api/access-keys': {
        get: {
          summary: 'List access keys',
          responses: {
            200: { description: 'Access keys returned without plaintext or hash' },
          },
        },
        post: {
          summary: 'Create a site-scoped access key',
          responses: {
            201: { description: 'Access key created; plaintext returned once' },
          },
        },
      },
      '/.xd-pages/api/access-keys/{id}': {
        delete: {
          summary: 'Revoke an access key',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: 'Access key revoked' },
            404: { description: 'Access key not found' },
          },
        },
      },
      '/.xd-pages/api/auth/whoami': {
        get: {
          summary: 'Return the authenticated actor for CLI token or access key validation',
          responses: {
            200: { description: 'Authenticated actor returned without token plaintext or hashes' },
            401: { description: 'Authentication required or invalid' },
            403: { description: 'Authenticated user is not active' },
          },
        },
      },
      '/.xd-pages/api/deployments': {
        post: {
          summary: 'Create a deployment',
          parameters: [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/DeploymentRequest' },
              },
              'multipart/form-data': {
                schema: { $ref: '#/components/schemas/StaticAssetDeploymentRequest' },
              },
            },
          },
          'x-error-codes': [
            'ARTIFACT_BUNDLE_REQUIRED',
            'ARTIFACT_BUNDLE_INVALID',
            'ASSET_MANIFEST_REQUIRED',
            'ASSET_MANIFEST_INVALID',
            'ASSET_FILES_REQUIRED',
            'INVALID_MULTIPART',
            'PAYLOAD_TOO_LARGE',
            'DEPLOYMENT_PLATFORM_CONFIG_INVALID',
            'DEPLOYMENT_UPLOAD_FAILED',
            'DEPLOYMENT_VERIFY_FAILED',
            'DEPLOYMENT_STATE_WRITE_FAILED',
            'DEPLOYMENT_CAPACITY_EXHAUSTED',
            'ROUTE_SNAPSHOT_WRITE_FAILED',
            'IDEMPOTENCY_CONFLICT',
          ],
          responses: {
            201: { description: 'Deployment created' },
            400: { description: 'Invalid deployment request' },
            413: { description: 'Deployment payload too large for the current upload path' },
            500: { description: 'Deployment platform configuration invalid' },
            502: { description: 'Deployment upload or verification failed' },
            503: { description: 'Deployment capacity exhausted or route snapshot write failed' },
            409: { description: 'Idempotency conflict' },
          },
        },
      },
      '/.xd-pages/api/deployments/{id}': {
        get: {
          summary: 'Get deployment status; access keys require read:site',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: 'Deployment returned' },
            403: { description: 'Access key missing read:site scope' },
            404: { description: 'Deployment not found' },
          },
        },
      },
      '/.xd-pages/api/versions/{id}/rollback': {
        post: {
          summary: 'Rollback a site route to a previous immutable version',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' } },
          ],
          responses: {
            201: { description: 'Rollback deployment created' },
            409: { description: 'Idempotency conflict' },
          },
        },
      },
    },
  };
}
