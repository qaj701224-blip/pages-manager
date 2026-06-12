import js from '@eslint/js';
import prettier from 'eslint-config-prettier';

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

  prettier,

  {
    files: ['**/*.js'],
    rules: {
      'max-len': ['warn', { code: 130 }],
    },
  },
];
