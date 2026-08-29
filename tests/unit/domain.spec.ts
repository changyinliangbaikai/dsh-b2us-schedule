import { describe, expect, it } from 'vitest'
import {
  assertRuntime,
  assertTask,
  canonicalInstant,
  cronIntervalSeconds,
  deepEqual,
  initialOccurrence,
  nextCronOccurrence,
  nextRecurringOccurrence,
  ScheduleValidationError,
  taskPolicyIssue,
  validTimeZone,
  type AutoScheduleSettings,
  type AutoScheduleTask,
} from '../../src/domain.js'
import { DEFAULT_SETTINGS } from '../../src/config.js'
import { quotePosix, quotePowerShell, systemNotificationCommand } from '../../src/notification.js'

const task = (overrides: Partial<AutoScheduleTask> = {}): AutoScheduleTask => ({
  id: 'auto-schedule-test',
  name: 'test',
  enabled: true,
  schedule: { kind: 'after', afterSeconds: 30 },
  action: { kind: 'notification', title: 'T', body: 'B' },
  revision: 1,
  executionRevision: 1,
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
  ...overrides,
})

describe('schedule domain', () => {
  it('canonicalizes only explicit-offset absolute times', () => {
    expect(canonicalInstant('2026-08-24T09:30:00+08:00')).toBe('2026-08-24T01:30:00.000Z')
    expect(() => canonicalInstant('2026-08-24T09:30:00')).toThrow(ScheduleValidationError)
    expect(() => canonicalInstant('2026-02-31T09:30:00+08:00')).toThrow(/real calendar/)
    expect(() => canonicalInstant('2026-08-24T25:00:00Z')).toThrow(/real calendar/)
  })

  it('validates IANA zones and resolves cron occurrences with cadence', () => {
    expect(validTimeZone('Asia/Shanghai')).toBe(true)
    expect(validTimeZone('UTC')).toBe(true)
    expect(validTimeZone('CST')).toBe(false)
    expect(validTimeZone(' Asia/Shanghai')).toBe(false)
    expect(validTimeZone('Mars/Olympus')).toBe(false)
    const rule = { kind: 'cron' as const, expression: '0 9 * * *', timeZone: 'Asia/Shanghai' }
    expect(new Date(nextCronOccurrence(rule, Date.parse('2026-08-24T00:00:00.000Z')) as number).toISOString())
      .toBe('2026-08-24T01:00:00.000Z')
    expect(cronIntervalSeconds(rule, Date.parse('2026-08-24T00:00:00.000Z'))).toBe(86_400)
    expect(() => nextCronOccurrence({ ...rule, expression: 'not cron' }, 0)).toThrow(/Invalid cron/)
  })

  it('anchors one-shots and skips fixed-interval backlog', () => {
    const after = task()
    expect(initialOccurrence(after)).toBe(Date.parse(after.updatedAt) + 30_000)
    const every = task({ schedule: { kind: 'every', everySeconds: 60 } })
    const anchor = Date.parse(every.updatedAt)
    expect(nextRecurringOccurrence(every, anchor + 185_000, anchor + 60_000)).toBe(anchor + 240_000)
    expect(nextRecurringOccurrence(after, anchor, anchor)).toBeNull()
    const at = task({ schedule: { kind: 'at', at: '2026-08-25T00:00:00.000Z' } })
    expect(initialOccurrence(at)).toBe(Date.parse('2026-08-25T00:00:00.000Z'))
    const cron = task({ schedule: { kind: 'cron', expression: '0 * * * *', timeZone: 'UTC' } })
    expect(initialOccurrence(cron)).toBe(Date.parse('2026-08-24T01:00:00.000Z'))
    expect(nextRecurringOccurrence(cron, anchor, anchor)).toBe(Date.parse('2026-08-24T01:00:00.000Z'))
  })

  it('applies deployment policy without imposing the recurring floor on one-shot delay', () => {
    const settings: AutoScheduleSettings = { ...DEFAULT_SETTINGS, minIntervalSeconds: 60 }
    expect(taskPolicyIssue(task({ schedule: { kind: 'after', afterSeconds: 1 } }), settings, Date.now())).toBeUndefined()
    expect(taskPolicyIssue(task({ schedule: { kind: 'every', everySeconds: 30 } }), settings, Date.now()))
      .toMatchObject({ code: 'frequency_too_high' })
    expect(taskPolicyIssue(task({ action: { kind: 'shell', command: 'true' } }), {
      ...settings, allowShellActions: false,
    }, Date.now())).toMatchObject({ code: 'shell_disabled' })
    expect(taskPolicyIssue(task({ action: { kind: 'agent', prompt: 'work' } }), {
      ...settings, allowAgentActions: false,
    }, Date.now())).toMatchObject({ code: 'agent_disabled' })
    expect(taskPolicyIssue(task({ action: { kind: 'agent', prompt: '12345' } }), {
      ...settings, maxAgentPromptBytes: 4,
    }, Date.now())).toMatchObject({ code: 'agent_prompt_too_large' })
    expect(taskPolicyIssue(task({ action: { kind: 'agent', prompt: 'work', timeoutMs: 10 } }), {
      ...settings, maxAgentTimeoutMs: 9,
    }, Date.now())).toMatchObject({ code: 'timeout_too_high' })
    expect(taskPolicyIssue(task({
      schedule: { kind: 'at', at: '2026-08-23T00:00:00.000Z' },
    }), settings, Date.parse('2026-08-24T00:00:00.000Z'), true)).toMatchObject({ code: 'not_future' })
    expect(taskPolicyIssue(task({
      action: { kind: 'shell', command: '12345' },
    }), { ...settings, maxCommandBytes: 4 }, Date.now())).toMatchObject({ code: 'command_too_large' })
    expect(taskPolicyIssue(task({
      action: { kind: 'shell', command: 'x', timeoutMs: 10 },
    }), { ...settings, maxShellTimeoutMs: 9 }, Date.now())).toMatchObject({ code: 'timeout_too_high' })
    expect(taskPolicyIssue(task({
      action: { kind: 'notification', title: '123', body: '45' },
    }), { ...settings, maxNotificationBytes: 4 }, Date.now())).toMatchObject({ code: 'notification_too_large' })
    expect(taskPolicyIssue(task({
      schedule: { kind: 'cron', expression: '* * * * * *', timeZone: 'UTC' },
    }), settings, Date.now())).toMatchObject({ code: 'frequency_too_high' })
  })

  it('allows one-second fixed intervals and Cron cadence by default', () => {
    expect(taskPolicyIssue(task({
      schedule: { kind: 'every', everySeconds: 1 },
    }), DEFAULT_SETTINGS, Date.now())).toBeUndefined()
    expect(taskPolicyIssue(task({
      schedule: { kind: 'cron', expression: '* * * * * *', timeZone: 'UTC' },
    }), DEFAULT_SETTINGS, Date.now())).toBeUndefined()
  })

  it('strictly validates every durable task and runtime shape', () => {
    const run = {
      scheduledAt: '2026-08-24T00:00:00.000Z',
      startedAt: '2026-08-24T00:00:00.000Z',
      finishedAt: '2026-08-24T00:00:01.000Z',
      outcome: 'succeeded' as const,
      exitCode: 0,
      stdout: 'ok',
    }
    for (const candidate of [
      task({ schedule: { kind: 'cron', expression: '0 9 * * *', timeZone: 'UTC' } }),
      task({ schedule: { kind: 'at', at: '2026-08-25T00:00:00.000Z' } }),
      task({ schedule: { kind: 'every', everySeconds: 60 } }),
      task({ action: { kind: 'shell', command: './run.sh', cwd: '/tmp', timeoutMs: 1_000 } }),
      task({ action: { kind: 'agent', prompt: 'Do it', cwd: '/tmp', agentPreset: 'default', timeoutMs: 1_000 } }),
    ]) expect(() => assertTask(candidate)).not.toThrow()
    expect(() => assertRuntime({
      taskId: task().id, taskRevision: 1, state: 'failed', nextRunAt: null,
      lastRun: run, history: [run], message: 'failed',
    })).not.toThrow()

    const invalid: unknown[] = [
      null,
      { ...task(), id: '!bad' },
      { ...task(), name: ' ' },
      { ...task(), enabled: 'yes' },
      { ...task(), revision: 0 },
      { ...task(), createdAt: 'yesterday' },
      { ...task(), schedule: null },
      { ...task(), schedule: { kind: 'cron', expression: '* * * * *', timeZone: 'CST' } },
      { ...task(), schedule: { kind: 'after', afterSeconds: 0 } },
      { ...task(), schedule: { kind: 'at', at: '2026-08-25T00:00:00Z' } },
      { ...task(), schedule: { kind: 'every', everySeconds: -1 } },
      { ...task(), schedule: { kind: 'unknown' } },
      { ...task(), action: null },
      { ...task(), action: { kind: 'shell', command: '' } },
      { ...task(), action: { kind: 'notification', title: '', body: 'B' } },
      { ...task(), action: { kind: 'agent', prompt: '' } },
      { ...task(), action: { kind: 'agent', prompt: 'Do it', agentPreset: '' } },
      { ...task(), action: { kind: 'unknown' } },
    ]
    for (const candidate of invalid) expect(() => assertTask(candidate)).toThrow(ScheduleValidationError)
    for (const candidate of [
      null,
      { taskId: '', taskRevision: 1, state: 'scheduled', nextRunAt: null },
      { taskId: 'x', taskRevision: 0, state: 'scheduled', nextRunAt: null },
      { taskId: 'x', taskRevision: 1, state: 'unknown', nextRunAt: null },
      { taskId: 'x', taskRevision: 1, state: 'scheduled', nextRunAt: 'soon' },
      { taskId: 'x', taskRevision: 1, state: 'failed', nextRunAt: null, history: [{}] },
      { taskId: 'x', taskRevision: 1, state: 'failed', nextRunAt: null, lastRun: { ...run, outcome: 'maybe' } },
      { taskId: 'x', taskRevision: 1, state: 'failed', nextRunAt: null, lastRun: { ...run, agentSessionId: '' } },
      { taskId: 'x', taskRevision: 1, state: 'scheduled', nextRunAt: null, message: 1 },
    ]) expect(() => assertRuntime(candidate)).toThrow(ScheduleValidationError)
  })

  it('compares immutable JSON projections structurally', () => {
    expect(deepEqual({ a: [1, { b: true }] }, { a: [1, { b: true }] })).toBe(true)
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false)
    expect(deepEqual([1], { 0: 1 })).toBe(false)
    expect(deepEqual(null, {})).toBe(false)
    expect(deepEqual('x', 'x')).toBe(true)
  })
})

describe('system notification commands', () => {
  it('quotes POSIX and PowerShell literals', () => {
    expect(quotePosix("a'b")).toBe("'a'\"'\"'b'")
    expect(quotePowerShell("a'b")).toBe("'a''b'")
  })

  it('uses the platform command while keeping payloads literal', () => {
    expect(systemNotificationCommand('darwin', 'T"', "B'")).toContain('/usr/bin/osascript -e')
    expect(systemNotificationCommand('linux', "T'", 'B')).toContain("notify-send -- 'T'\"'\"'' 'B'")
    expect(systemNotificationCommand('win32', "T'", 'B')).toContain("BalloonTipTitle = 'T'''")
  })
})
