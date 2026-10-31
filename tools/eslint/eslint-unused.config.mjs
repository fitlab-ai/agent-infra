import tseslint from 'typescript-eslint';

export default [
  {
    ignores: [
      '**/node_modules/**',
      'dist/**',
      '.agents/workspace/**',
      '.opencode/**',
      '.trae/**',
      '.tmp*/**',
      'tmp/**',
      'artifacts/**'
    ]
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    linterOptions: { noInlineConfig: true },
    rules: {
      'no-unused-vars': ['error', { args: 'all', argsIgnorePattern: '^_', caughtErrors: 'all', caughtErrorsIgnorePattern: '^_' }],
      'no-unused-private-class-members': 'error',
      'no-unused-labels': 'error',
      'no-useless-assignment': 'error',
      'no-unreachable': 'error'
    }
  },
  {
    files: ['bin/**/*.ts', 'lib/**/*.ts', 'tests/**/*.ts'],
    ignores: ['tests/fixtures/**'],
    languageOptions: { parser: tseslint.parser },
    plugins: { '@typescript-eslint': tseslint.plugin },
    linterOptions: { noInlineConfig: true },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { args: 'none', vars: 'local', varsIgnorePattern: '^_', caughtErrors: 'all', caughtErrorsIgnorePattern: '^_' }],
      'no-unused-labels': 'error',
      'no-useless-assignment': 'error',
      'no-unreachable': 'error'
    }
  }
];
