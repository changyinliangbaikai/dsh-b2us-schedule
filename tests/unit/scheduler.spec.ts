import { afterEach, describe, expect, it } from 'vitest'
import type {
  AgentActionExecutor,
  AgentActionRequest,
  AgentActionResult,
} from '../../src/agent-action.js'
import type { AutoScheduleTask, TaskRuntime } from '../../src/domain.js'
import { AutoScheduleService } from '../../src/service.js'
import { ManualClock } from '../helpers/clock.js'
import { hostContext, shellResult } from '../helpers/host.js'

const roots: Array<{ fiber: { dispose(): Promise<void> } }> = []

class FakeAgentExecutor implements AgentActionExecutor {
  readonly requests: AgentActionRequest[] = []
  handler: (request: AgentActionRequest) => Promise<AgentActionResult> = () => Promise.resolve({
    outcome: 'succeeded',
    agentSessionId: 'session-scheduled-agent',
    agentPreset: 'default',
  })

  execute(request: AgentActionRequest): Promise<AgentActionResult> {
    this.requests.push(request)
    return this.handler(request)
  }
}

afterEach(async () => {
  await Promise.allSettled(roots.splice(0).map(root => root.fiber.dispose()))
})

async function setup(options: {
  readonly clock?: ManualClock
  readonly tasks?: AutoScheduleTask[]
  readonly runtime?: TaskRuntime[]
  readonly allowShellActions?: boolean
  readonly allowAgentActions?: boolean
  readonly maxHistoryEntriesPerTask?: number
  readonly agent?: FakeAgentExecutor
} = {}) {
  const clock = options.clock ?? new ManualClock('2026-08-24T00:00:00.000Z')
  const host = await hostContext()
  roots.push(host.ctx)
  const agent = options.agent ?? new FakeAgentExecutor()
  const service = new AutoScheduleService(host.ctx, {
    minIntervalSeconds: 1,
    tasks: options.tasks ?? [],
    runtime: options.runtime ?? [],
    allowShellActions: options.allowShellActions ?? true,
    allowAgentActions: options.allowAgentActions ?? true,
    maxHistoryEntriesPerTask: options.maxHistoryEntriesPerTask ?? 50,
  }, clock, agent)
  host.ctx.effect(() => () => service.dispose(), 'test: auto-schedule runtime')
  await service.start()
  return { ...host, agent, clock, service }
}

describe('AutoScheduleRuntime', () => {
  it('executes a delayed command once through ctx.shell and retains a bounded result', async () => {
    const test = await setup()
    test.shell.handler = spec => Promise.resolve(shellResult({
      timeoutMs: spec.timeoutMs,
      stdout: { text: 'done\n', truncated: false },
    }))
    const created = await test.service.create({
      name: 'backup',
      schedule: { kind: 'after', afterSeconds: 10 },
      action: { kind: 'shell', command: './backup.sh', cwd: '/workspace/project', timeoutMs: 5_000 },
    })
    await test.service.settle()
    expect(test.service.list()[0]?.runtime?.nextRunAt).toBe('2026-08-24T00:00:10.000Z')

    test.clock.advance(10_000)
    await test.service.settle()
    expect(test.shell.requests).toHaveLength(1)
    expect(test.shell.requests[0]).toMatchObject({
      command: './backup.sh', workdir: '/workspace/project', timeoutMs: 5_000, stdoutMaxBytes: 16_384,
    })
    expect(test.service.list()).toEqual([
      expect.objectContaining({
        task: expect.objectContaining({ id: created.task.id }),
        runtime: expect.objectContaining({
          state: 'succeeded',
          nextRunAt: null,
          lastRun: expect.objectContaining({ outcome: 'succeeded', stdout: 'done\n' }),
          history: [expect.objectContaining({ outcome: 'succeeded', stdout: 'done\n' })],
        }),
      }),
    ])
    await test.service.dispose()
  })

  it('executes a fresh main-Agent action and retains its durable Session link', async () => {
    const test = await setup()
    await test.service.create({
      name: 'browser acceptance',
      schedule: { kind: 'after', afterSeconds: 2 },
      action: {
        kind: 'agent',
        prompt: 'Open the browser and run the acceptance case.',
        cwd: '/workspace/browser-test',
        agentPreset: 'browser',
        timeoutMs: 45_000,
      },
    })
    await test.service.settle()
    test.clock.advance(2_000)
    await test.service.settle()

    expect(test.agent.requests).toHaveLength(1)
    expect(test.agent.requests[0]).toMatchObject({
      taskName: 'browser acceptance',
      scheduledAt: '2026-08-24T00:00:02.000Z',
      timeoutMs: 45_000,
      action: {
        kind: 'agent', cwd: '/workspace/browser-test', agentPreset: 'browser',
      },
    })
    expect(test.service.list()[0]?.runtime).toMatchObject({
      state: 'succeeded',
      lastRun: {
        outcome: 'succeeded', agentSessionId: 'session-scheduled-agent', agentPreset: 'default',
      },
      history: [{ agentSessionId: 'session-scheduled-agent' }],
    })
  })

  it('aborts an active Agent action when the task is deleted', async () => {
    const agent = new FakeAgentExecutor()
    agent.handler = request => new Promise((resolve) => {
      request.signal.addEventListener('abort', () => {
        resolve({ outcome: 'aborted', error: 'cancelled', agentSessionId: 'session-cancelled' })
      }, { once: true })
    })
    const test = await setup({ agent })
    const created = await test.service.create({
      name: 'long Agent',
      schedule: { kind: 'after', afterSeconds: 1 },
      action: { kind: 'agent', prompt: 'Keep working.' },
    })
    await test.service.settle()
    test.clock.advance(1_000)
    for (let index = 0; index < 10 && test.agent.requests.length === 0; index += 1) await Promise.resolve()
    expect(test.agent.requests).toHaveLength(1)
    await test.service.delete(created.task.id)
    await test.service.settle()
    expect(test.agent.requests[0]?.signal.aborted).toBe(true)
    expect(test.service.list()).toEqual([])
  })

  it('persists newest-first execution history and enforces the per-task retention bound', async () => {
    const test = await setup({ maxHistoryEntriesPerTask: 2 })
    let sequence = 0
    test.shell.handler = spec => Promise.resolve(shellResult({
      timeoutMs: spec.timeoutMs,
      stdout: { text: `run-${String(++sequence)}`, truncated: false },
    }))
    const created = await test.service.create({
      name: 'frequent',
      schedule: { kind: 'every', everySeconds: 1 },
      action: { kind: 'shell', command: 'frequent' },
    })
    await test.service.settle()
    for (let index = 0; index < 3; index += 1) {
      test.clock.advance(1_000)
      await test.service.settle()
    }

    expect(test.service.history(created.task.id).map(run => run.stdout)).toEqual(['run-3', 'run-2'])
    expect(test.service.history(created.task.id, 1).map(run => run.stdout)).toEqual(['run-3'])
    expect(() => test.service.history(created.task.id, 0)).toThrow(/positive integer/)
    expect(test.settings.doc['auto-schedule']).toMatchObject({
      runtime: [{ history: [{ stdout: 'run-3' }, { stdout: 'run-2' }] }],
    })
  })

  it('batches one overdue fixed-rate occurrence and jumps past backlog', async () => {
    const test = await setup()
    await test.service.create({
      name: 'metrics',
      schedule: { kind: 'every', everySeconds: 10 },
      action: { kind: 'shell', command: 'collect-metrics' },
    })
    await test.service.settle()
    test.clock.advance(35_000)
    await test.service.settle()
    expect(test.shell.requests).toHaveLength(1)
    expect(test.service.list()[0]?.runtime?.nextRunAt).toBe('2026-08-24T00:00:40.000Z')
    expect(test.clock.nextTimerAt).toBe(Date.parse('2026-08-24T00:00:40.000Z'))
    await test.service.dispose()
  })

  it('recovers a persisted running occurrence after restart', async () => {
    const task: AutoScheduleTask = {
      id: 'task-recover',
      name: 'recover',
      enabled: true,
      schedule: { kind: 'after', afterSeconds: 10 },
      action: { kind: 'shell', command: 'recover-command' },
      revision: 1,
      executionRevision: 1,
      createdAt: '2026-08-23T23:00:00.000Z',
      updatedAt: '2026-08-23T23:00:00.000Z',
    }
    const runtime: TaskRuntime = {
      taskId: task.id,
      taskRevision: 1,
      state: 'running',
      nextRunAt: '2026-08-23T23:00:10.000Z',
    }
    const test = await setup({ tasks: [task], runtime: [runtime] })
    expect(test.shell.requests.map(request => request.command)).toEqual(['recover-command'])
    expect(test.service.list()[0]?.runtime?.state).toBe('succeeded')
    await test.service.dispose()
  })

  it('migrates a v0.1 lastRun into durable history without duplicating it', async () => {
    const task: AutoScheduleTask = {
      id: 'task-v01-history',
      name: 'legacy',
      enabled: false,
      schedule: { kind: 'every', everySeconds: 60 },
      action: { kind: 'shell', command: 'legacy' },
      revision: 1,
      executionRevision: 1,
      createdAt: '2026-08-23T23:00:00.000Z',
      updatedAt: '2026-08-23T23:00:00.000Z',
    }
    const lastRun = {
      scheduledAt: '2026-08-23T23:01:00.000Z',
      startedAt: '2026-08-23T23:01:00.000Z',
      finishedAt: '2026-08-23T23:01:01.000Z',
      outcome: 'succeeded' as const,
      exitCode: 0,
      stdout: 'legacy-output',
    }
    const test = await setup({
      tasks: [task],
      runtime: [{ taskId: task.id, taskRevision: 1, state: 'disabled', nextRunAt: null, lastRun }],
    })
    expect(test.service.history(task.id)).toEqual([lastRun])
    expect(test.service.list()[0]?.runtime?.history).toEqual([lastRun])
  })

  it('records an occurrence aborted by a task revision change', async () => {
    const test = await setup()
    test.shell.handler = spec => new Promise((resolve) => {
      spec.signal?.addEventListener('abort', () => {
        resolve(shellResult({ exitCode: null, aborted: true, timeoutMs: spec.timeoutMs }))
      }, { once: true })
    })
    const created = await test.service.create({
      name: 'disable while running',
      schedule: { kind: 'every', everySeconds: 1 },
      action: { kind: 'shell', command: 'long-running' },
    })
    await test.service.settle()
    test.clock.advance(1_000)
    for (let index = 0; index < 10 && test.shell.requests.length === 0; index += 1) await Promise.resolve()
    await test.service.update({ id: created.task.id, enabled: false })
    await test.service.settle()

    expect(test.shell.requests[0]?.signal?.aborted).toBe(true)
    expect(test.service.list()[0]?.runtime).toMatchObject({
      state: 'disabled',
      history: [{ outcome: 'aborted', error: 'Scheduled action was aborted.' }],
    })
  })

  it('aborts the active ShellExecutor call when its task is deleted', async () => {
    const test = await setup()
    test.shell.handler = spec => new Promise((resolve) => {
      spec.signal?.addEventListener('abort', () => {
        resolve(shellResult({ exitCode: null, aborted: true, timeoutMs: spec.timeoutMs }))
      }, { once: true })
    })
    const created = await test.service.create({
      name: 'long run',
      schedule: { kind: 'after', afterSeconds: 1 },
      action: { kind: 'shell', command: 'long-running' },
    })
    await test.service.settle()
    test.clock.advance(1_000)
    for (let index = 0; index < 10 && test.shell.requests.length === 0; index += 1) await Promise.resolve()
    expect(test.shell.requests).toHaveLength(1)
    await test.service.delete(created.task.id)
    await test.service.settle()
    expect(test.shell.requests[0]?.signal?.aborted).toBe(true)
    expect(test.service.list()).toEqual([])
    await test.service.dispose()
  })

  it('projects a policy-blocked task without executing it', async () => {
    const task: AutoScheduleTask = {
      id: 'task-blocked',
      name: 'blocked',
      enabled: true,
      schedule: { kind: 'after', afterSeconds: 1 },
      action: { kind: 'shell', command: 'forbidden' },
      revision: 1,
      executionRevision: 1,
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
    }
    const test = await setup({ tasks: [task], allowShellActions: false })
    expect(test.service.list()[0]?.runtime).toMatchObject({ state: 'blocked', nextRunAt: null })
    test.clock.advance(60_000)
    await test.service.settle()
    expect(test.shell.requests).toEqual([])
    await test.service.dispose()
  })

  it('executes system notifications through the same DSH ShellExecutor seam', async () => {
    const test = await setup()
    await test.service.create({
      name: 'notice',
      schedule: { kind: 'after', afterSeconds: 1 },
      action: { kind: 'notification', title: 'Review', body: 'Open the report' },
    })
    await test.service.settle()
    test.clock.advance(1_000)
    await test.service.settle()
    expect(test.shell.requests).toHaveLength(1)
    expect(test.shell.requests[0]?.command).toMatch(/osascript|notify-send|NotifyIcon/)
    expect(test.shell.requests[0]).toMatchObject({ timeoutMs: 15_000, stdoutMaxBytes: 16_384 })
    expect(test.service.list()[0]?.runtime?.lastRun?.outcome).toBe('succeeded')
  })

  it('classifies timeout, sandbox denial, nonzero exit, and truncated output', async () => {
    const test = await setup()
    test.shell.handler = spec => {
      if (spec.command === 'timeout') return Promise.resolve(shellResult({
        exitCode: null, timedOut: true, timeoutMs: spec.timeoutMs,
      }))
      if (spec.command === 'denied') return Promise.resolve(shellResult({
        exitCode: null,
        sandbox: { mode: 'workspace-write', denied: true },
        timeoutMs: spec.timeoutMs,
      }))
      if (spec.command === 'exit') return Promise.resolve(shellResult({
        exitCode: 7,
        stderr: { text: 'bad', truncated: false },
        timeoutMs: spec.timeoutMs,
      }))
      return Promise.resolve(shellResult({
        stdout: { text: 'partial', truncated: true },
        timeoutMs: spec.timeoutMs,
      }))
    }
    for (const command of ['timeout', 'denied', 'exit', 'truncated']) {
      await test.service.create({
        name: command,
        schedule: { kind: 'after', afterSeconds: 1 },
        action: { kind: 'shell', command },
      })
    }
    await test.service.settle()
    test.clock.advance(1_000)
    await test.service.settle()
    const byName = new Map(test.service.list().map(view => [view.task.name, view.runtime]))
    expect(byName.get('timeout')).toMatchObject({ state: 'failed', message: 'Timed out after 120000 ms.' })
    expect(byName.get('denied')).toMatchObject({ state: 'failed', message: expect.stringContaining('sandbox denied') })
    expect(byName.get('exit')).toMatchObject({ state: 'failed', lastRun: { exitCode: 7, stderr: 'bad' } })
    expect(byName.get('truncated')?.lastRun?.stdout).toContain('output truncated')
  })

  it('records executor infrastructure failures and preserves disabled history', async () => {
    const test = await setup()
    test.shell.handler = () => Promise.reject(new Error('executor offline'))
    const created = await test.service.create({
      name: 'offline',
      schedule: { kind: 'after', afterSeconds: 1 },
      action: { kind: 'shell', command: 'offline' },
    })
    await test.service.settle()
    test.clock.advance(1_000)
    await test.service.settle()
    expect(test.service.list()[0]?.runtime).toMatchObject({
      state: 'failed',
      message: 'Executor infrastructure failure: executor offline',
      lastRun: { outcome: 'failed' },
    })
    await test.service.update({ id: created.task.id, enabled: false })
    await test.service.settle()
    expect(test.service.list()[0]?.runtime).toMatchObject({
      state: 'disabled', nextRunAt: null, lastRun: { outcome: 'failed' }, history: [{ outcome: 'failed' }],
    })
    await test.service.start()
    await test.service.dispose()
    await test.service.dispose()
  })
})
