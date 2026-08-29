import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../src/config.js'
import type { AutoScheduleSettings, AutoScheduleTask } from '../../src/domain.js'
import { draftFromTask, emptyDraft, taskFromDraft } from '../../src/client/task-form.js'

const settings: AutoScheduleSettings = { ...DEFAULT_SETTINGS, minIntervalSeconds: 60 }
const now = Date.parse('2026-08-24T00:00:00.000Z')

describe('Web task form projection', () => {
  it('builds a durable notification task with canonical UTC time', () => {
    const draft = {
      ...emptyDraft(settings, now),
      name: 'Notify',
      scheduleKind: 'at' as const,
      atLocal: '2026-08-24T09:00:00',
      actionKind: 'notification' as const,
      title: 'Title',
      body: 'Body',
    }
    const result = taskFromDraft(draft, settings, undefined, { nowMs: now, id: 'task-web' })
    expect(result).toMatchObject({
      ok: true,
      task: {
        id: 'task-web',
        schedule: { kind: 'at' },
        action: { kind: 'notification', title: 'Title', body: 'Body' },
        revision: 1,
        executionRevision: 1,
      },
    })
  })

  it('round-trips an existing task and keeps execution revision for rename-only edits', () => {
    const task: AutoScheduleTask = {
      id: 'task-1',
      name: 'Before',
      enabled: true,
      schedule: { kind: 'every', everySeconds: 300 },
      action: { kind: 'shell', command: './run.sh', cwd: '/project' },
      revision: 4,
      executionRevision: 2,
      createdAt: '2026-08-23T00:00:00.000Z',
      updatedAt: '2026-08-23T00:00:00.000Z',
    }
    const draft = { ...draftFromTask(task, settings), name: 'After' }
    const result = taskFromDraft(draft, settings, task, { nowMs: now })
    expect(result).toMatchObject({
      ok: true,
      task: { name: 'After', revision: 5, executionRevision: 2 },
    })
  })

  it('reports policy-aware form failures', () => {
    expect(taskFromDraft({ ...emptyDraft(settings, now), name: '' }, settings, undefined, { nowMs: now }))
      .toEqual({ ok: false, issue: 'nameRequired' })
    expect(taskFromDraft({
      ...emptyDraft(settings, now),
      name: 'fast',
      scheduleKind: 'every',
      everySeconds: '10',
      actionKind: 'notification',
      title: 'T',
      body: 'B',
    }, settings, undefined, { nowMs: now })).toEqual({
      ok: false, issue: 'intervalTooShort', params: { seconds: 60 },
    })
    expect(taskFromDraft({
      ...emptyDraft(settings, now),
      name: 'past',
      scheduleKind: 'at',
      atLocal: '2026-08-23T00:00:00',
      actionKind: 'notification',
      title: 'T',
      body: 'B',
    }, settings, undefined, { nowMs: now })).toEqual({ ok: false, issue: 'futureTime' })
  })

  it('accepts a one-second fixed interval with the default deployment policy', () => {
    expect(taskFromDraft({
      ...emptyDraft(DEFAULT_SETTINGS, now),
      name: 'fast-default',
      scheduleKind: 'every',
      everySeconds: '1',
      actionKind: 'notification',
      title: 'T',
      body: 'B',
    }, DEFAULT_SETTINGS, undefined, { nowMs: now, id: 'task-fast-default' })).toMatchObject({
      ok: true,
      task: { schedule: { kind: 'every', everySeconds: 1 } },
    })
  })

  it('projects every schedule and action variant into editable drafts', () => {
    const base: Omit<AutoScheduleTask, 'schedule' | 'action'> = {
      id: 'task-variants', name: 'Variants', enabled: false,
      revision: 1, executionRevision: 1,
      createdAt: '2026-08-23T00:00:00.000Z', updatedAt: '2026-08-23T00:00:00.000Z',
    }
    expect(draftFromTask({
      ...base,
      schedule: { kind: 'cron', expression: '0 9 * * *', timeZone: 'Asia/Shanghai' },
      action: { kind: 'notification', title: 'T', body: 'B' },
    }, settings)).toMatchObject({
      scheduleKind: 'cron', cronExpression: '0 9 * * *', timeZone: 'Asia/Shanghai',
      actionKind: 'notification', title: 'T', body: 'B', command: '',
    })
    expect(draftFromTask({
      ...base,
      schedule: { kind: 'after', afterSeconds: 9 },
      action: { kind: 'shell', command: 'run', timeoutMs: 500 },
    }, settings)).toMatchObject({ scheduleKind: 'after', afterSeconds: '9', command: 'run', cwd: '', timeoutMs: '500' })
    expect(draftFromTask({
      ...base,
      schedule: { kind: 'every', everySeconds: 60 },
      action: { kind: 'agent', prompt: 'Browse', cwd: '/project', agentPreset: 'browser', timeoutMs: 2_000 },
    }, settings)).toMatchObject({
      actionKind: 'agent', prompt: 'Browse', cwd: '/project', agentPreset: 'browser', timeoutMs: '2000',
    })
    expect(draftFromTask({
      ...base,
      schedule: { kind: 'at', at: '2026-08-25T00:00:00.000Z' },
      action: { kind: 'notification', title: 'T', body: 'B' },
    }, settings).atLocal).toContain('2026-08-25')
  })

  it('returns stable field-specific failures for malformed actions and selectors', () => {
    const base = { ...emptyDraft(settings, now), name: 'Task' }
    const cases = [
      [{ ...base, cronExpression: '' }, 'cronRequired'],
      [{ ...base, scheduleKind: 'after', afterSeconds: 'x' }, 'positiveSeconds'],
      [{ ...base, scheduleKind: 'at', atLocal: 'not-a-date' }, 'positiveSeconds'],
      [{ ...base, scheduleKind: 'every', everySeconds: '0' }, 'positiveSeconds'],
      [{ ...base, scheduleKind: 'after', afterSeconds: '5', command: '' }, 'commandRequired'],
      [{ ...base, scheduleKind: 'after', afterSeconds: '5', command: 'run', timeoutMs: 'x' }, 'timeoutInvalid'],
      [{
        ...base, scheduleKind: 'after', afterSeconds: '5', actionKind: 'notification', title: '', body: 'B',
      }, 'notificationRequired'],
    ] as const
    for (const [draft, issue] of cases) {
      expect(taskFromDraft(draft, settings, undefined, { nowMs: now })).toMatchObject({ ok: false, issue })
    }
  })

  it('enforces action policy and increments execution revisions only for executable changes', () => {
    const shell = {
      ...emptyDraft(settings, now),
      name: 'Shell',
      scheduleKind: 'after' as const,
      afterSeconds: '5',
      command: './run.sh',
      cwd: ' /project ',
      timeoutMs: '1000',
    }
    expect(taskFromDraft(shell, { ...settings, allowShellActions: false }, undefined, { nowMs: now }))
      .toEqual({ ok: false, issue: 'shellDisabled' })
    expect(taskFromDraft(shell, { ...settings, maxShellTimeoutMs: 999 }, undefined, { nowMs: now }))
      .toEqual({ ok: false, issue: 'timeoutInvalid', params: { milliseconds: 999 } })
    expect(taskFromDraft(shell, { ...settings, maxCommandBytes: 2 }, undefined, { nowMs: now }))
      .toEqual({ ok: false, issue: 'contentTooLarge' })
    expect(taskFromDraft({
      ...shell, actionKind: 'notification', title: 'abc', body: 'def',
    }, { ...settings, maxNotificationBytes: 5 }, undefined, { nowMs: now }))
      .toEqual({ ok: false, issue: 'contentTooLarge' })

    const created = taskFromDraft(shell, settings, undefined, { nowMs: now, id: 'task-shell' })
    expect(created).toMatchObject({
      ok: true,
      task: { action: { kind: 'shell', cwd: '/project', timeoutMs: 1000 }, executionRevision: 1 },
    })
    if (!created.ok) throw new Error('expected task')
    const changed = taskFromDraft({ ...draftFromTask(created.task, settings), enabled: false }, settings, created.task, {
      nowMs: now + 1_000,
    })
    expect(changed).toMatchObject({ ok: true, task: { executionRevision: 2, revision: 2 } })
  })

  it('builds and validates fresh main-Agent actions', () => {
    const agent = {
      ...emptyDraft(settings, now),
      name: 'Browser check',
      scheduleKind: 'after' as const,
      afterSeconds: '5',
      actionKind: 'agent' as const,
      prompt: ' Open the site and verify it. ',
      cwd: ' /workspace/test ',
      agentPreset: ' browser ',
      timeoutMs: '120000',
    }
    expect(taskFromDraft(agent, settings, undefined, { nowMs: now, id: 'task-agent' })).toMatchObject({
      ok: true,
      task: {
        action: {
          kind: 'agent', prompt: 'Open the site and verify it.', cwd: '/workspace/test',
          agentPreset: 'browser', timeoutMs: 120_000,
        },
      },
    })
    expect(taskFromDraft({ ...agent, prompt: '' }, settings, undefined, { nowMs: now }))
      .toMatchObject({ ok: false, issue: 'agentPromptRequired' })
    expect(taskFromDraft(agent, { ...settings, allowAgentActions: false }, undefined, { nowMs: now }))
      .toEqual({ ok: false, issue: 'agentDisabled' })
    expect(taskFromDraft(agent, { ...settings, maxAgentTimeoutMs: 10 }, undefined, { nowMs: now }))
      .toEqual({ ok: false, issue: 'timeoutInvalid', params: { milliseconds: 10 } })
    expect(taskFromDraft(agent, { ...settings, maxAgentPromptBytes: 3 }, undefined, { nowMs: now }))
      .toEqual({ ok: false, issue: 'contentTooLarge' })
  })
})
