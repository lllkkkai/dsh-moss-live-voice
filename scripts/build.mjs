/** Build the host bundle: MOSS SDK + ws are inlined because profile links install no dependencies. */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

await build({
  entryPoints: [join(root, 'src/host/index.js')],
  outfile: join(root, 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  legalComments: 'none',
  // Optional native accelerators of `ws`; the pure-JS path is used instead.
  external: ['bufferutil', 'utf-8-validate'],
  // esbuild turns CJS requires into dynamic requires in ESM output; the shim
  // keeps Node built-ins resolvable from the bundle.
  banner: {
    js: "import{createRequire as __dshCreateRequire}from'node:module';"
      + 'const require=__dshCreateRequire(import.meta.url);',
  },
})

console.log('built index.js')
