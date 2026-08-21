import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import noDirectNextId from './scripts/eslint-rules/no-direct-next-id.js';

// minimatch 不用 ** 匹配 .. 段，跨 app / 跨包相对路径必须按 src 下最大嵌套深度逐级列出字面前缀（各留一级余量）。
const crossAppSrcImports = {
  group: ['../../*/src/**', '../../../*/src/**', '../../../../*/src/**', '../../../../../*/src/**'],
  message: 'apps 之间不得直接 import 其它 app 的 src；共享代码放 packages/ 并用 @xd/* workspace 别名引用。',
};
const relativePackagesImports = {
  group: ['../../../packages/**', '../../../../packages/**', '../../../../../packages/**', '../../../../../../packages/**'],
  message: '共享包必须用 @xd/* workspace 别名引用，不要用相对路径。',
};
const appAliasImports = {
  group: ['@xd/pages-api', '@xd/pages-api/*', '@xd/pages-router', '@xd/pages-router/*', '@xd/kv-gateway', '@xd/kv-gateway/*'],
  message: 'app 的包别名仅供跨 app 集成测试使用；生产代码不得 import 其它 app。',
};

function relativeLayerImports(...layers) {
  return {
    group: layers.flatMap((layer) => Array.from({ length: 6 }, (_, index) => `${'../'.repeat(index + 1)}${layer}/**`)),
    message: 'pages-api 分层依赖必须保持 transport -> application -> domain；infrastructure 只能通过 composition root 注入。',
  };
}

const pagesApiDomainImports = relativeLayerImports('application', 'transport', 'infrastructure');
const pagesApiApplicationImports = relativeLayerImports('transport', 'infrastructure');
const pagesApiInfrastructureImports = relativeLayerImports('transport');

function otherTransportLaneImports(...lanes) {
  return {
    group: lanes.flatMap((lane) => Array.from({ length: 4 }, (_, index) => `${'../'.repeat(index + 1)}${lane}/**`)),
    message: 'pages-api transport lanes 不得互相 import；共享业务下沉 application，共享 HTTP helper 放 transport/shared。',
  };
}

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      '**/dist/**',
      '**/*.min.js',
      '.wrangler/**',
      '**/.workerd/**',
      'coverage/**',
      'test-results/**',
      'archive/**',
      'demos/**',
    ],
  },

  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        Buffer: 'readonly',
        module: 'readonly',
        require: 'readonly',
        exports: 'readonly',
        fetch: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        Headers: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        FormData: 'readonly',
        File: 'readonly',
        Blob: 'readonly',
        TextDecoder: 'readonly',
        atob: 'readonly',
        btoa: 'readonly',
        crypto: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        addEventListener: 'readonly',
        PosterCore: 'readonly',
        PosterSpare: 'readonly',
        __STATIC_CONTENT_MANIFEST: 'readonly',
        __STATIC_CONTENT: 'readonly',
        self: 'readonly',
        caches: 'readonly',
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },

  {
    files: ['deploy/nodejs/**/*.js'],
    languageOptions: {
      globals: {
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
  },

  {
    files: ['apps/*/src/**/*.js', 'packages/*/src/**/*.js'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [crossAppSrcImports, relativePackagesImports, appAliasImports] }],
    },
  },

  {
    files: ['apps/*/src/**/*.test.js', 'packages/*/src/**/*.test.js'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [crossAppSrcImports, relativePackagesImports] }],
    },
  },

  {
    files: ['apps/pages-api/src/**/*.js'],
    ignores: ['apps/pages-api/src/id.js', 'apps/pages-api/src/**/*.test.js'],
    plugins: {
      'pages-api': { rules: { 'no-direct-next-id': noDirectNextId } },
    },
    rules: {
      'pages-api/no-direct-next-id': 'error',
    },
  },

  {
    files: ['apps/pages-api/src/domain/**/*.js'],
    ignores: ['apps/pages-api/src/**/*.test.js'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [crossAppSrcImports, relativePackagesImports, appAliasImports, pagesApiDomainImports] },
      ],
    },
  },

  {
    files: ['apps/pages-api/src/application/**/*.js'],
    ignores: ['apps/pages-api/src/**/*.test.js'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [crossAppSrcImports, relativePackagesImports, appAliasImports, pagesApiApplicationImports] },
      ],
    },
  },

  {
    files: ['apps/pages-api/src/infrastructure/**/*.js'],
    ignores: ['apps/pages-api/src/**/*.test.js'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [crossAppSrcImports, relativePackagesImports, appAliasImports, pagesApiInfrastructureImports] },
      ],
    },
  },

  {
    files: ['apps/pages-api/src/transport/public/**/*.js'],
    ignores: ['apps/pages-api/src/**/*.test.js'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            crossAppSrcImports,
            relativePackagesImports,
            appAliasImports,
            otherTransportLaneImports('console', 'internal'),
          ],
        },
      ],
    },
  },

  {
    files: ['apps/pages-api/src/transport/console/**/*.js'],
    ignores: ['apps/pages-api/src/**/*.test.js'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            crossAppSrcImports,
            relativePackagesImports,
            appAliasImports,
            otherTransportLaneImports('public', 'internal'),
          ],
        },
      ],
    },
  },

  {
    files: ['apps/pages-api/src/transport/internal/**/*.js'],
    ignores: ['apps/pages-api/src/**/*.test.js'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            crossAppSrcImports,
            relativePackagesImports,
            appAliasImports,
            otherTransportLaneImports('public', 'console'),
          ],
        },
      ],
    },
  },

  {
    files: ['apps/*/src/**/*.jsx'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      'no-restricted-imports': ['error', { patterns: [crossAppSrcImports, relativePackagesImports, appAliasImports] }],
    },
  },

  prettier,

  {
    files: ['**/*.js'],
    rules: {
      'max-len': ['warn', { code: 130 }],
    },
  },
];
