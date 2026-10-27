import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

it('keeps session and composer bundles unchanged when conversation views are edited', async () => {
  const bundle = (editViews: boolean) => build({
    entryPoints: ['program/plugins/session.client.ts', 'program/plugins/composer.client.tsx'],
    outdir: 'out',
    bundle: true,
    write: false,
    sourcemap: 'inline',
    platform: 'browser',
    format: 'esm',
    jsx: 'automatic',
    loader: { '.css': 'text' },
    external: ['react', 'react-dom', 'react/jsx-runtime', 'cordis', 'lucide-react'],
    plugins: [{
      name: 'conversation-edit',
      setup(builder) {
        builder.onLoad({ filter: /ui\/(activity|history)\.tsx$/ }, async ({ path }) => ({
          contents: await readFile(path, 'utf8') + (editViews ? '\n// Conversation display changed.\n' : ''),
          loader: 'tsx',
        }))
      },
    }],
  })
  const original = await bundle(false)
  const edited = await bundle(true)
  // Cordis uses the emitted bytes (including source maps) to decide which
  // fibers reload. An unrelated view edit must leave these services intact.
  expect(edited.outputFiles.map((file) => file.text)).toEqual(original.outputFiles.map((file) => file.text))
})
