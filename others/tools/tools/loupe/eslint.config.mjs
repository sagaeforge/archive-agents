// Two rules the design asks ESLint to hold (design 4, 9). Everything else is left to tsc.
import tseslint from 'typescript-eslint';

const noRawHtml = {
  'no-restricted-syntax': ['error',
    { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: 'Untrusted text only reaches the DOM as a React text child (design 9).' },
    { selector: "MemberExpression[property.name=/^(innerHTML|outerHTML)$/]", message: 'Untrusted text only reaches the DOM as a React text child (design 9).' },
    { selector: "CallExpression[callee.property.name='insertAdjacentHTML']", message: 'Untrusted text only reaches the DOM as a React text child (design 9).' },
    { selector: "MemberExpression[object.name='document'][property.name='write']", message: 'Untrusted text only reaches the DOM as a React text child (design 9).' },
  ],
};

export default [
  { ignores: ['src/client/**'] },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      ...noRawHtml,
      // Generated hooks stay inside src/data/: that is where the time axes are added (design 4).
      'no-restricted-imports': ['error', { patterns: [{ regex: 'client/kb(\\.ts)?$', message: 'Use the wrappers in src/data/hooks.ts: they add the time axes.' }] }],
    },
  },
  {
    files: ['src/data/**/*.{ts,tsx}'],
    rules: { 'no-restricted-imports': 'off' },
  },
];
