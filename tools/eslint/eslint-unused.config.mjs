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
      'no-unused-vars': ['error', { args: 'all', argsIgnorePattern: '^_', caughtErrors: 'none' }]
    }
  }
];
