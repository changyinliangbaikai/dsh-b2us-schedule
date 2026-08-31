import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const projectRoot = fileURLToPath(new URL('../../', import.meta.url))

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

function filesBelow(directory: string): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory).flatMap(entry => {
    const path = join(directory, entry)
    return statSync(path).isDirectory() ? filesBelow(path) : [path]
  })
}

describe('DSH dual-face package structure', () => {
  const packageJson = readJson(join(projectRoot, 'package.json'))

  it('declares Host, Web client, patch, and publish surfaces', () => {
    expect(packageJson).toMatchObject({
      name: 'dsh-b2us-schedule',
      type: 'module',
      main: './lib/index.js',
      types: './lib/types/index.d.ts',
      dsh: {
        bundle: { patch: './cordis.patch.yml' },
        client: {
          inject: [
            '@deepseek-ai/dsh-api-session-controller',
            '@deepseek-ai/dsh-client-ui-renderer',
            '@deepseek-ai/dsh-client-ui-settings',
            '@deepseek-ai/dsh-client-locale',
          ],
          platform: 'web',
        },
      },
    })
    expect(packageJson.files).toEqual(expect.arrayContaining([
      'lib/index.js', 'lib/client.js', 'cordis.patch.yml', 'docs',
      'README.md', 'README.zh-CN.md', 'LICENSE',
    ]))
    for (const path of [
      'lib/index.js', 'lib/invariant.js', 'lib/client.js',
      'lib/types/index.d.ts', 'lib/types/client/index.d.ts',
    ]) {
      expect(existsSync(join(projectRoot, path)), `missing ${path}`).toBe(true)
    }
  })

  it('patches the standard host row with conservative scheduling defaults', () => {
    const patch = readFileSync(join(projectRoot, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('id: auto-schedule')
    expect(patch).toContain('name: dsh-b2us-schedule')
    expect(patch).toContain('minIntervalSeconds: 1')
    expect(patch).toContain('maxHistoryEntriesPerTask: 50')
    expect(patch).toContain('maxShellTimeoutMs: 600000')
    expect(patch).toContain('allowAgentActions: true')
    expect(patch).toContain('defaultAgentTimeoutMs: 900000')
  })

  it('ships mutually linked English and Simplified Chinese READMEs', () => {
    const english = readFileSync(join(projectRoot, 'README.md'), 'utf8')
    const chinese = readFileSync(join(projectRoot, 'README.zh-CN.md'), 'utf8')
    expect(english).toContain('**English** | [简体中文](README.zh-CN.md)')
    expect(chinese).toContain('[English](README.md) | **简体中文**')
    expect(english).toContain('# dsh-b2us-schedule')
    expect(chinese).toContain('# dsh-b2us-schedule')
  })

  it('keeps DSH singletons external and Croner as the sole production dependency', () => {
    const dependencies = packageJson.dependencies as Record<string, string>
    const peers = packageJson.peerDependencies as Record<string, string>
    const bundleConfig = readFileSync(join(projectRoot, 'tsdown.config.ts'), 'utf8')
    expect(dependencies).toEqual({ croner: '10.0.1' })
    for (const name of [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-agent',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-session',
      '@deepseek-ai/dsh-settings',
      '@deepseek-ai/dsh-shell',
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/schemastery',
    ]) {
      expect(peers[name]).toBeTypeOf('string')
      expect(bundleConfig).toContain(`'${name}'`)
    }
    expect(packageJson.bundledDependencies).toEqual(['croner'])
  })

  it('imports the built Host package through its published self-reference', () => {
    const script = [
      "import('dsh-b2us-schedule').then((mod) => {",
      "  if (mod.name !== 'auto-schedule') process.exit(2)",
      "  if (typeof mod.apply !== 'function') process.exit(3)",
      "  if ('default' in mod) process.exit(4)",
      '})',
    ].join('\n')
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: projectRoot,
      encoding: 'utf8',
    })
    expect(result.status, result.stderr || result.stdout).toBe(0)
  })

  it('imports both built Node entry points without a TypeScript loader', async () => {
    const host = await import(pathToFileURL(join(projectRoot, 'lib/index.js')).href)
    const invariant = await import(pathToFileURL(join(projectRoot, 'lib/invariant.js')).href)
    expect(host).toMatchObject({ name: 'auto-schedule', apply: expect.any(Function) })
    expect('default' in host).toBe(false)
    expect(invariant).toMatchObject({ name: 'auto-schedule-invariant', apply: expect.any(Function) })
    expect('default' in invariant).toBe(false)
  })

  it('emits a loader-safe browser bundle with only React runtime requires', () => {
    const client = readFileSync(join(projectRoot, 'lib/client.js'), 'utf8')
    expect(client).toContain('window.__ModuleLoader__.load({')
    expect(client).toContain('id: "dsh-b2us-schedule"')
    expect(client).toContain('data-plugin-css')
    expect(client).toContain('.das-page')
    expect(client).toContain('return module.exports;')
    const requires = [...client.matchAll(/require\((['"])(.*?)\1\)/g)].map(match => match[2]).sort()
    expect(requires).toEqual(['react', 'react/jsx-runtime'])
  })

  it('pairs solid-control fill and foreground tokens for both color themes', () => {
    const styles = readFileSync(join(projectRoot, 'src', 'client', 'styles.css'), 'utf8')
    const primaryStart = styles.indexOf('.das-button-primary {')
    const primary = styles.slice(primaryStart, styles.indexOf('}', primaryStart))
    expect(primaryStart).toBeGreaterThanOrEqual(0)
    expect(primary).toContain('background: var(--dsw-alias-button-primary-fill')
    expect(primary).toContain('color: var(--dsw-alias-label-primary-foreground')
    expect(styles).toContain('.das-button-primary:hover:not(:disabled)')
    expect(styles).toContain('background: var(--dsw-alias-button-primary-hover')

    const thumbStart = styles.indexOf('.das-switch span::after {')
    const thumb = styles.slice(thumbStart, styles.indexOf('}', thumbStart))
    expect(thumbStart).toBeGreaterThanOrEqual(0)
    expect(thumb).toContain('background: var(--dsw-alias-label-primary-foreground')
    const trackStart = styles.indexOf('.das-switch input:checked + span {')
    const track = styles.slice(trackStart, styles.indexOf('}', trackStart))
    expect(trackStart).toBeGreaterThanOrEqual(0)
    expect(track).toContain('background: var(--dsw-alias-button-primary-fill')
  })

  it('keeps production source files reviewable', () => {
    const candidates = [
      ...filesBelow(join(projectRoot, 'src')).filter(path => /\.(?:ts|tsx)$/.test(path)),
      ...filesBelow(join(projectRoot, 'scripts')).filter(path => path.endsWith('.mjs')),
    ]
    const oversized = candidates.flatMap(path => {
      const lines = readFileSync(path, 'utf8').trimEnd().split(/\r?\n/).length
      return lines > 500 ? [`${relative(projectRoot, path)}: ${String(lines)} lines`] : []
    })
    expect(oversized, `Files over 500 lines:\n${oversized.join('\n')}`).toEqual([])
  })
})
