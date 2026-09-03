import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { defineConfig, type UserConfig } from 'tsdown'

const PACKAGE_ID = 'dsh-b2us-schedule'
const INLINE_CSS_PREFIX = '\0dsh-b2us-schedule-css:'
const INLINE_CSS_SUFFIX = '.mjs'

function sourceAssetPath(source: string, importer: string): string {
  const emitted = resolve(dirname(importer), source)
  if (existsSync(emitted)) return emitted
  const marker = `${resolve('lib/types')}/`
  if (!emitted.startsWith(marker)) return emitted
  return resolve('src', emitted.slice(marker.length))
}

const hostExternals = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-default-model',
  '@deepseek-ai/dsh-agent-presets',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-title',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-shell',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-workspace',
  '@deepseek-ai/schemastery',
  'croner',
]

const nodeBundle = (entry: string): UserConfig => ({
  entry: [entry],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  sourcemap: true,
  clean: false,
  deps: { neverBundle: hostExternals },
})

const clientBundle: UserConfig = {
  name: `${PACKAGE_ID}/client`,
  entry: { client: 'lib/types/client/index.js' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: (specifier: string) => specifier === 'react'
      || specifier === 'react-dom'
      || specifier === 'react/jsx-runtime',
  },
  plugins: [{
    name: 'dsh-b2us-schedule-inline-css',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.css?inline')) return null
      const stylesheet = source.slice(0, -'?inline'.length)
      const path = importer === undefined ? stylesheet : sourceAssetPath(stylesheet, importer)
      return INLINE_CSS_PREFIX + path + INLINE_CSS_SUFFIX
    },
    async load(id: string) {
      if (!id.startsWith(INLINE_CSS_PREFIX)) return null
      const path = id.slice(INLINE_CSS_PREFIX.length, -INLINE_CSS_SUFFIX.length)
      this.addWatchFile(path)
      return `export default ${JSON.stringify(await readFile(path, 'utf8'))};`
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default defineConfig([
  nodeBundle('lib/types/index.js'),
  clientBundle,
])
