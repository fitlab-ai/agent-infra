import tseslint from 'typescript-eslint';

export const lintContract = {
  ignores: ['**/node_modules/**', 'tests/fixtures/**'],
  scanFiles: ['bin/**/*.ts', 'lib/**/*.ts', 'tests/**/*.ts'],
  files: ['**/*.ts'],
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module'
  },
  linterOptions: {
    noInlineConfig: true
  },
  rules: {
    complexity: ['error', 15],
    'max-depth': ['error', 4]
  }
};

export default tseslint.config(
  {
    ignores: lintContract.ignores
  },
  {
    files: lintContract.files,
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: lintContract.parserOptions
    },
    linterOptions: lintContract.linterOptions,
    rules: lintContract.rules
  }
);
