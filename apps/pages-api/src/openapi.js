export function buildOpenApi(config) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'XD Pages v2 API',
      version: '2.0.0',
      description: 'Control plane API for XD Pages v2.',
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
            content: { type: 'string', description: 'ES module source generated or read by the v2 CLI.' },
            type: { type: 'string', examples: ['application/javascript+module'] },
          },
        },
        ArtifactBundle: {
          type: 'object',
          required: ['kind', 'mainModule', 'modules'],
          properties: {
            kind: { type: 'string', enum: ['static', 'spa', 'worker'] },
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
          required: ['siteId', 'artifactKind', 'contentHash', 'artifactBundle'],
          properties: {
            siteId: { type: 'string' },
            artifactKind: { type: 'string', enum: ['static', 'spa', 'worker'] },
            contentHash: { type: 'string', pattern: '^sha256:' },
            artifactBundle: { $ref: '#/components/schemas/ArtifactBundle' },
            source: { type: 'string', examples: ['cli'] },
          },
        },
        SiteVisibility: {
          type: 'string',
          enum: ['public', 'org', 'acl', 'owner', 'disabled'],
          description: 'First release is still protected by the company IP allowlist for every visibility.',
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
              enum: ['user', 'email', 'department'],
              description: 'group is intentionally not enabled until organization directory semantics are stable.',
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
          summary: 'List sites visible to the authenticated actor',
          responses: {
            200: { description: 'Sites returned' },
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
          summary: 'Get a site',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: 'Site returned' },
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
            },
          },
          'x-error-codes': [
            'ARTIFACT_BUNDLE_REQUIRED',
            'ARTIFACT_BUNDLE_INVALID',
            'PAYLOAD_TOO_LARGE',
            'WFP_CONFIG_INVALID',
            'WFP_UPLOAD_FAILED',
            'WFP_VERIFY_FAILED',
            'ROUTE_SNAPSHOT_WRITE_FAILED',
            'IDEMPOTENCY_CONFLICT',
          ],
          responses: {
            201: { description: 'Deployment created' },
            400: { description: 'Invalid deployment request' },
            413: { description: 'Deployment payload too large for the current upload path' },
            500: { description: 'WFP provider configuration invalid' },
            502: { description: 'WFP upload or verification failed' },
            503: { description: 'Route snapshot write failed' },
            409: { description: 'Idempotency conflict' },
          },
        },
      },
      '/.xd-pages/api/deployments/{id}': {
        get: {
          summary: 'Get deployment status',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: 'Deployment returned' },
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
