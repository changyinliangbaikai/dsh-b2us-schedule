import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as autoSchedule from '../../src/index.js'
import { requiresAgentApproval, requiresShellApproval } from '../../src/tools.js'
import { hostContext } from '../helpers/host.js'

const contexts: Context[] = []
const signal = new AbortController().signal

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function setup() {
  const host = await hostContext()
  contexts.push(host.ctx)
  await host.ctx.plugin(SystemPrompt)
  await host.ctx.plugin(ToolRuntime)
  const fiber = host.ctx.plugin(autoSchedule, { minIntervalSeconds: 1 })
  await fiber
  return { ...host, fiber }
}

async function execute(ctx: Context, name: string, args: unknown): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    callId: `test-${name}-${Math.random()}` as never,
    name,
    arguments: args,
    signal,
  })
}

function value(result: ToolExecutionResult): unknown {
  expect(result.isError).toBe(false)
  if (result.isError) throw new Error(result.error.message)
  expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(result.value)
  return result.value
}

describe('Host plugin composition', () => {
  it('has the Loader-safe dual-face function-plugin contract', () => {
    expect('default' in autoSchedule).toBe(false)
    expect(autoSchedule.name).toBe('auto-schedule')
    expect(autoSchedule.inject).toEqual(['settings', 'tools', 'shell'])
    expect(autoSchedule.AUTO_SCHEDULE_NAMESPACE).toBe('auto-schedule')
  })

  it('registers five tools, performs durable CRUD, and unwinds exactly', async () => {
    const test = await setup()
    expect(['auto_schedule_create', 'auto_schedule_update', 'auto_schedule_list', 'auto_schedule_history', 'auto_schedule_delete']
      .map(name => test.ctx.tools.get(name)?.name)).toEqual([
        'auto_schedule_create', 'auto_schedule_update', 'auto_schedule_list', 'auto_schedule_history', 'auto_schedule_delete',
      ])
    expect(test.ctx.tools.get('auto_schedule_create')?.presentCall?.({
      name: 'Morning notice', schedule_kind: 'after', after_seconds: 60,
      action_kind: 'notification', title: 'T', body: 'B',
    }))
      .toMatchObject({ card: 'generic', title: 'Create scheduled task', rawInput: 'Morning notice' })
    expect(test.ctx.tools.get('auto_schedule_update')?.presentCall?.({ id: 'task-1' }))
      .toMatchObject({ title: 'Update scheduled task', rawInput: 'task-1' })
    expect(test.ctx.tools.get('auto_schedule_list')?.presentCall?.({}))
      .toMatchObject({ title: 'List scheduled tasks', kind: 'read' })
    expect(test.ctx.tools.get('auto_schedule_list')?.isConcurrencySafe?.({})).toBe(true)
    expect(test.ctx.tools.get('auto_schedule_history')?.presentCall?.({ id: 'task-1' }))
      .toMatchObject({ title: 'Read scheduled task history', kind: 'read', rawInput: 'task-1' })
    expect(test.ctx.tools.get('auto_schedule_history')?.isConcurrencySafe?.({ id: 'task-1' })).toBe(true)
    expect(test.ctx.tools.get('auto_schedule_delete')?.presentCall?.({ id: 'task-1' }))
      .toMatchObject({ title: 'Delete scheduled task', rawInput: 'task-1' })

    const created = value(await execute(test.ctx, 'auto_schedule_create', {
      name: 'Morning notice',
      schedule_kind: 'after',
      after_seconds: 3_600,
      action_kind: 'notification',
      title: 'Report',
      body: 'Review the daily report',
    })) as { ok: true; task: { id: string; revision: number; executionRevision: number } }
    expect(created).toMatchObject({ ok: true, task: { revision: 1, executionRevision: 1 } })

    const listed = value(await execute(test.ctx, 'auto_schedule_list', {})) as {
      ok: true
      tasks: Array<{ task: { id: string; name: string } }>
    }
    expect(listed.tasks).toEqual([
      expect.objectContaining({ task: expect.objectContaining({ id: created.task.id, name: 'Morning notice' }) }),
    ])
    expect(value(await execute(test.ctx, 'auto_schedule_history', { id: created.task.id })))
      .toEqual({ ok: true, id: created.task.id, history: [] })

    const updated = value(await execute(test.ctx, 'auto_schedule_update', {
      id: created.task.id,
      name: 'Daily notice',
    })) as { ok: true; task: { revision: number; executionRevision: number; name: string } }
    expect(updated.task).toMatchObject({ name: 'Daily notice', revision: 2, executionRevision: 1 })

    expect(value(await execute(test.ctx, 'auto_schedule_delete', { id: created.task.id })))
      .toEqual({ ok: true, id: created.task.id, deleted: true })
    expect(value(await execute(test.ctx, 'auto_schedule_delete', { id: created.task.id })))
      .toEqual({ ok: true, id: created.task.id, deleted: false })
    expect(test.settings.doc['auto-schedule']).toMatchObject({ tasks: [] })

    await test.fiber.dispose()
    for (const name of ['auto_schedule_create', 'auto_schedule_update', 'auto_schedule_list', 'auto_schedule_history', 'auto_schedule_delete']) {
      expect(test.ctx.tools.get(name)).toBeUndefined()
    }
  })

  it('stores a disabled shell task without approval and classifies later risky changes', async () => {
    const test = await setup()
    const created = value(await execute(test.ctx, 'auto_schedule_create', {
      name: 'Disabled script',
      enabled: false,
      schedule_kind: 'every',
      every_seconds: 300,
      action_kind: 'shell',
      command: './script.sh',
    })) as { ok: true; task: { id: string } }

    expect(requiresShellApproval({
      name: 'auto_schedule_create',
      arguments: { action_kind: 'shell' },
    } as never, test.ctx.autoSchedule)).toBe(true)
    expect(requiresShellApproval({
      name: 'auto_schedule_create',
      arguments: { action_kind: 'shell', enabled: false },
    } as never, test.ctx.autoSchedule)).toBe(false)
    expect(requiresShellApproval({
      name: 'auto_schedule_update',
      arguments: { id: created.task.id, enabled: true },
    } as never, test.ctx.autoSchedule)).toBe(true)
    expect(requiresShellApproval({
      name: 'auto_schedule_update',
      arguments: { id: created.task.id, name: 'rename only' },
    } as never, test.ctx.autoSchedule)).toBe(false)
  })

  it('stores a disabled Agent task and classifies unattended Agent mutations for approval', async () => {
    const test = await setup()
    const created = value(await execute(test.ctx, 'auto_schedule_create', {
      name: 'Browser acceptance',
      enabled: false,
      schedule_kind: 'every',
      every_seconds: 300,
      action_kind: 'agent',
      prompt: 'Open Chrome and execute the acceptance case.',
      cwd: '/workspace/browser-test',
      agent_preset: 'browser',
      timeout_ms: 120_000,
    })) as { ok: true; task: { id: string; action: unknown } }
    expect(created.task.action).toEqual({
      kind: 'agent',
      prompt: 'Open Chrome and execute the acceptance case.',
      cwd: '/workspace/browser-test',
      agentPreset: 'browser',
      timeoutMs: 120_000,
    })

    expect(requiresAgentApproval({
      name: 'auto_schedule_create', arguments: { action_kind: 'agent' },
    } as never, test.ctx.autoSchedule)).toBe(true)
    expect(requiresAgentApproval({
      name: 'auto_schedule_create', arguments: { action_kind: 'agent', enabled: false },
    } as never, test.ctx.autoSchedule)).toBe(false)
    expect(requiresAgentApproval({
      name: 'auto_schedule_update', arguments: { id: created.task.id, enabled: true },
    } as never, test.ctx.autoSchedule)).toBe(true)
    expect(requiresShellApproval({
      name: 'auto_schedule_update', arguments: { id: created.task.id, enabled: true },
    } as never, test.ctx.autoSchedule)).toBe(false)
  })

  it('returns stable selector and not-found values instead of throwing tool failures', async () => {
    const test = await setup()
    expect(value(await execute(test.ctx, 'auto_schedule_create', {
      name: 'bad',
      schedule_kind: 'after',
      after_seconds: 10,
      cron_expression: '* * * * *',
      action_kind: 'notification',
      title: 'T',
      body: 'B',
    }))).toMatchObject({ ok: false, error: { code: 'invalid_selector' } })
    expect(value(await execute(test.ctx, 'auto_schedule_update', {
      id: 'missing', name: 'none',
    }))).toMatchObject({ ok: false, error: { code: 'task_not_found' } })
    expect(value(await execute(test.ctx, 'auto_schedule_history', {
      id: 'missing', limit: 10,
    }))).toMatchObject({ ok: false, error: { code: 'task_not_found' } })
  })
})
