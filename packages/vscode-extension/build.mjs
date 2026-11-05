import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const entryPoint = fileURLToPath(new URL('src/extension.ts', import.meta.url));
const outfile = fileURLToPath(new URL('dist/extension.js', import.meta.url));

await build({
  entryPoints: [entryPoint],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: 'inline',
  logLevel: 'warning',
});

const { size } = statSync(outfile);
console.log(`[build] dist/extension.js: ${size} bytes (${(size / 1024).toFixed(1)} KiB)`);
