import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

const result = await build({
  entryPoints: [join(here, 'src/index.ts')],
  outfile: join(here, 'dist/index.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
  // No runtime imports from @deepseek-ai/*: everything the plugin needs from
  // the Host arrives through `ctx`, and the shared package is inlined.
  external: [],
})

if (result.errors.length > 0) process.exit(1)
