const globals = require('globals');

module.exports = [
    { ignores: ['dist/', 'node_modules/'] },
    ...require('gts'),
    {
        files: ['**/*.ts', '**/*.tsx'],
        rules: {
            '@typescript-eslint/no-duplicate-enum-values': 'off',
        },
    },
    {
        files: ['*.js'],
        languageOptions: {
            globals: globals.node,
        },
        rules: {
            'n/no-unpublished-require': 'off',
        },
    },
];
