import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { ShellExecutor, type ShellExecRequest, type ShellExecSpec, type ShellRunResult } from '@deepseek-ai/dsh-shell'

export class MemorySettings extends SettingsProvider {
  readonly doc: Record<string, unknown>

  constructor(ctx: Context, doc: Record<string, unknown> = {}) {
    super(ctx)
    this.doc = structuredClone(doc)
  }

  override get writable(): boolean {
    return true
  }

  protected override load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected override persist(namespace: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[namespace] = structuredClone(section)
    return Promise.resolve()
  }
}

export function shellResult(overrides: Partial<ShellRunResult> = {}): ShellRunResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 120_000,
    stdout: { text: '', truncated: false },
    stderr: { text: '', truncated: false },
    ...overrides,
  }
}

export class FakeShell extends ShellExecutor {
  readonly requests: ShellExecSpec[] = []
  handler: (spec: ShellExecSpec) => Promise<ShellRunResult> = spec => Promise.resolve(shellResult({ timeoutMs: spec.timeoutMs }))

  resolve(request: ShellExecRequest): ShellExecSpec {
    return {
      command: request.command,
      workdir: request.workdir ?? '/workspace',
      timeoutMs: request.timeoutMs ?? 120_000,
      stdoutMaxBytes: request.stdoutMaxBytes ?? 64_000,
      sandboxPolicy: request.sandboxPolicy,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
      ...(request.env === undefined ? {} : { env: request.env }),
      ...(request.dshEnv === undefined ? {} : { dshEnv: request.dshEnv }),
    }
  }

  async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    this.requests.push(spec)
    return this.handler(spec)
  }

  start(): never {
    throw new Error('FakeShell.start is not used by auto-schedule')
  }
}

export async function hostContext(doc: Record<string, unknown> = {}) {
  const ctx = new Context()
  class BoundSettings extends MemorySettings {
    constructor(serviceContext: Context) {
      super(serviceContext, doc)
    }
  }
  await ctx.plugin(BoundSettings)
  const settings = ctx.settings as MemorySettings
  const shell = new FakeShell(ctx)
  return { ctx, settings, shell }
}
