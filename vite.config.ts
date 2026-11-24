/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * License texts shipped with the site (published path → source in the repo).
 * Read from the installed packages at build time, so they always match the
 * versions actually bundled. A missing file fails the build.
 */
export const LICENSE_FILES: Record<string, string> = {
  'LICENSE.txt': 'LICENSE',
  'licenses/THIRD_PARTY_NOTICES.txt': 'THIRD_PARTY_NOTICES.md',
  'licenses/three-MIT.txt': 'node_modules/three/LICENSE',
  'licenses/preact-MIT.txt': 'node_modules/preact/LICENSE',
  'licenses/atkinson-hyperlegible-OFL.txt': 'node_modules/@fontsource/atkinson-hyperlegible/LICENSE',
};

function licensesPlugin(): Plugin {
  const read = (src: string) => readFileSync(resolve(HERE, src), 'utf8');
  return {
    name: 'packet-flip-licenses',
    generateBundle() {
      for (const [fileName, src] of Object.entries(LICENSE_FILES)) {
        this.emitFile({ type: 'asset', fileName, source: read(src) });
      }
    },
    // Serve the same files in dev so the Help dialog's links work there too.
    // Only the fixed paths above are served; nothing else on disk is reachable.
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0]!.replace(/^\//, '');
        const src = LICENSE_FILES[path];
        if (!src) return next();
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end(read(src));
      });
    },
  };
}

/**
 * Strict Content-Security-Policy for the production bundle.
 * The game never talks to a network (connect-src 'none') and never runs
 * inline or dynamically-evaluated script. Applied at build time only, because
 * the Vite dev server injects inline styles for hot reload.
 * Note: frame-ancestors cannot be set via <meta>; set it as an HTTP header
 * if the host supports custom headers.
 */
export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'none'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "manifest-src 'self'",
].join('; ');

function cspPlugin(): Plugin {
  return {
    name: 'packet-flip-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<meta charset="UTF-8" />',
        `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />\n    <meta name="referrer" content="no-referrer" />`,
      );
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [cspPlugin(), licensesPlugin()],
  oxc: {
    jsx: { runtime: 'automatic', importSource: 'preact' },
  },
  server: {
    // Stay on loopback only; never expose the dev server to the LAN by default.
    host: '127.0.0.1',
    strictPort: false,
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    // three.js is ~600 KB on its own; one cached bundle is fine for a static game.
    chunkSizeWarningLimit: 900,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
