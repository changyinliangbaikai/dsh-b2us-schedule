import { describe, expect, it } from 'vitest'
import { assertSettings, resolveSettings } from '../../src/config.js'
import type { AutoScheduleTask } from '../../src/domain.js'

const task: AutoScheduleTask = {
  id: 'task-1',
  name: 'Task',
  enabled: true,
  schedule: { kind: 'after', afterSeconds: 1 },
  action: { kind: 'notification', title: 'Hi', body: 'Body' },
  revision: 1,
  executionRevision: 1,
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
}

describe('settings boundary', () => {
  it('resolves defaults and accepts a complete task', () => {
    const settings = resolveSettings({ tasks: [task] })
    expect(settings.defaultTimeZone).toBe('UTC')
    expect(settings.minIntervalSeconds).toBe(1)
    expect(settings.maxHistoryEntriesPerTask).toBe(50)
    expect(settings.allowAgentActions).toBe(true)
    expect(settings.defaultAgentTimeoutMs).toBe(900_000)
    expect(() => assertSettings(settings as never)).not.toThrow()
  })

  it('rejects duplicate task and runtime identities', () => {
    expect(() => assertSettings({ tasks: [task, task] })).toThrow(/duplicate task id/)
    const runtime = { taskId: task.id, taskRevision: 1, state: 'scheduled' as const, nextRunAt: null }
    expect(() => assertSettings({ runtime: [runtime, runtime] })).toThrow(/duplicate runtime/)
  })

  it('rejects malformed zones and task revisions', () => {
    expect(() => assertSettings({ defaultTimeZone: 'CST' })).toThrow(/defaultTimeZone/)
    expect(() => assertSettings({ tasks: [{ ...task, executionRevision: 0 }] })).toThrow(/executionRevision/)
    expect(() => assertSettings({ defaultAgentTimeoutMs: 11, maxAgentTimeoutMs: 10 }))
      .toThrow(/defaultAgentTimeoutMs/)
  })
})
