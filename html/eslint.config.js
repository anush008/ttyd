const eslint = require('@eslint/js');
const tseslint = require('typescript-eslint');
const prettierConfig = require('eslint-config-prettier');
const pluginN = require('eslint-plugin-n');
const pluginPrettier = require('eslint-plugin-prettier');
const globals = require('globals');
const { defineConfig } = require('eslint/config');

module.exports = defineConfig([
    { ignores: ['dist/', 'node_modules/'] },
    eslint.configs.recommended,
    prettierConfig,
    {
        plugins: {
            n: pluginN,
            prettier: pluginPrettier,
        },
        rules: {
            'prettier/prettier': 'error',
            'block-scoped-var': 'error',
            eqeqeq: 'error',
            'no-var': 'error',
            'prefer-const': 'error',
            'eol-last': 'error',
            'prefer-arrow-callback': 'error',
            'no-trailing-spaces': 'error',
            quotes: ['warn', 'single', { avoidEscape: true }],
        },
    },
    {
        files: ['*.js'],
        languageOptions: {
            sourceType: 'commonjs',
            globals: globals.node,
        },
    },
    {
        files: ['**/*.ts', '**/*.tsx'],
        extends: [tseslint.configs.recommended],
        languageOptions: {
            parser: tseslint.parser,
            parserOptions: {
                ecmaVersion: 2018,
                sourceType: 'module',
                project: './tsconfig.json',
                jsxPragma: 'h',
            },
        },
        rules: {
            '@typescript-eslint/ban-ts-comment': 'warn',
            '@typescript-eslint/no-floating-promises': 'error',
            '@typescript-eslint/no-non-null-assertion': 'off',
            '@typescript-eslint/no-empty-function': 'off',
            '@typescript-eslint/no-require-imports': 'off',
            '@typescript-eslint/no-empty-object-type': 'off',
            '@typescript-eslint/explicit-function-return-type': 'off',
            '@typescript-eslint/explicit-module-boundary-types': 'off',
            '@typescript-eslint/no-duplicate-enum-values': 'off',
            'no-dupe-class-members': 'off',
            'require-atomic-updates': 'off',
        },
    },
]);
