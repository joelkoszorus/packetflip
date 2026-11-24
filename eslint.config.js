import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

/**
 * Security guard rails (see SECURITY.md):
 *  - no HTML-string sinks (innerHTML & friends) -> player text is always rendered as text
 *  - no dynamic code evaluation
 *  - no real network APIs anywhere in src/ -> the simulator is purely in-memory
 */
const htmlSinks = ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'srcdoc'];

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'coverage/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-script-url': 'error',
      'no-restricted-properties': [
        'error',
        ...htmlSinks.map((property) => ({
          property,
          message: 'HTML sinks are banned. Render text with Preact/textContent.',
        })),
        { object: 'document', property: 'write', message: 'document.write is banned.' },
        { object: 'document', property: 'writeln', message: 'document.writeln is banned.' },
        { object: 'navigator', property: 'sendBeacon', message: 'No network access.' },
      ],
      'no-restricted-globals': [
        'error',
        ...['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport', 'RTCPeerConnection'].map(
          (name) => ({ name, message: 'Packet Flip never uses the real network.' }),
        ),
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'dangerouslySetInnerHTML is banned.',
        },
        {
          selector: "CallExpression[callee.name=/^set(Timeout|Interval)$/][arguments.0.type='Literal']",
          message: 'String-evaluated timers are banned.',
        },
      ],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['src/sim/**/*.ts', 'src/cli/**/*.ts'],
    rules: {
      // The simulation core must stay headless: no DOM, no Three.js.
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['three', 'three/*', 'preact', 'preact/*'], message: 'sim/ and cli/ must stay headless.' }] },
      ],
    },
  },
  {
    files: ['*.config.{js,ts}', 'vite.config.ts', 'scripts/**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
);
