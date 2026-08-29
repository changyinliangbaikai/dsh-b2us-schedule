import type {
  AutoScheduleSettings,
  AutoScheduleTask,
  ScheduleAction,
  ScheduleRule,
} from '../domain.js'
import type { AutoScheduleLocaleKey } from './locales.js'

export interface TaskDraft {
  readonly name: string
  readonly enabled: boolean
  readonly scheduleKind: ScheduleRule['kind']
  readonly cronExpression: string
  readonly timeZone: string
  readonly afterSeconds: string
  readonly atLocal: string
  readonly everySeconds: string
  readonly actionKind: ScheduleAction['kind']
  readonly command: string
  readonly prompt: string
  readonly agentPreset: string
  readonly cwd: string
  readonly timeoutMs: string
  readonly title: string
  readonly body: string
}

export type DraftResult =
  | { readonly ok: true; readonly task: AutoScheduleTask }
  | {
    readonly ok: false
    readonly issue: AutoScheduleLocaleKey
    readonly params?: Record<string, unknown>
  }

function localDateTime(instant: number): string {
  const date = new Date(instant)
  return new Date(instant - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19)
}

export function emptyDraft(settings: AutoScheduleSettings, nowMs = Date.now()): TaskDraft {
  return {
    name: '',
    enabled: true,
    scheduleKind: 'cron',
    cronExpression: '0 9 * * *',
    timeZone: settings.defaultTimeZone,
    afterSeconds: '300',
    atLocal: localDateTime(nowMs + 3_600_000),
    everySeconds: '3600',
    actionKind: 'shell',
    command: '',
    prompt: '',
    agentPreset: '',
    cwd: '',
    timeoutMs: '',
    title: '',
    body: '',
  }
}

export function draftFromTask(task: AutoScheduleTask, settings: AutoScheduleSettings): TaskDraft {
  const base = emptyDraft(settings)
  const schedule = task.schedule
  const action = task.action
  return {
    ...base,
    name: task.name,
    enabled: task.enabled,
    scheduleKind: schedule.kind,
    cronExpression: schedule.kind === 'cron' ? schedule.expression : base.cronExpression,
    timeZone: schedule.kind === 'cron' ? schedule.timeZone : base.timeZone,
    afterSeconds: schedule.kind === 'after' ? String(schedule.afterSeconds) : base.afterSeconds,
    atLocal: schedule.kind === 'at' ? localDateTime(Date.parse(schedule.at)) : base.atLocal,
    everySeconds: schedule.kind === 'every' ? String(schedule.everySeconds) : base.everySeconds,
    actionKind: action.kind,
    command: action.kind === 'shell' ? action.command : '',
    prompt: action.kind === 'agent' ? action.prompt : '',
    agentPreset: action.kind === 'agent' ? action.agentPreset ?? '' : '',
    cwd: action.kind === 'shell' || action.kind === 'agent' ? action.cwd ?? '' : '',
    timeoutMs: action.kind === 'shell' || action.kind === 'agent' ? String(action.timeoutMs ?? '') : '',
    title: action.kind === 'notification' ? action.title : '',
    body: action.kind === 'notification' ? action.body : '',
  }
}

function positiveInteger(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function scheduleFromDraft(draft: TaskDraft): ScheduleRule | undefined {
  switch (draft.scheduleKind) {
    case 'cron':
      return draft.cronExpression.trim().length === 0 || draft.timeZone.trim().length === 0
        ? undefined
        : { kind: 'cron', expression: draft.cronExpression.trim(), timeZone: draft.timeZone.trim() }
    case 'after': {
      const seconds = positiveInteger(draft.afterSeconds)
      return seconds === undefined ? undefined : { kind: 'after', afterSeconds: seconds }
    }
    case 'at': {
      const timestamp = Date.parse(draft.atLocal)
      return Number.isFinite(timestamp) ? { kind: 'at', at: new Date(timestamp).toISOString() } : undefined
    }
    case 'every': {
      const seconds = positiveInteger(draft.everySeconds)
      return seconds === undefined ? undefined : { kind: 'every', everySeconds: seconds }
    }
  }
}

function actionFromDraft(draft: TaskDraft): ScheduleAction | undefined {
  if (draft.actionKind === 'notification') {
    return draft.title.trim().length === 0 || draft.body.trim().length === 0
      ? undefined
      : { kind: 'notification', title: draft.title.trim(), body: draft.body.trim() }
  }
  const timeoutMs = draft.timeoutMs.length === 0 ? undefined : positiveInteger(draft.timeoutMs)
  if (draft.timeoutMs.length > 0 && timeoutMs === undefined) return undefined
  if (draft.actionKind === 'agent') {
    if (draft.prompt.trim().length === 0) return undefined
    return {
      kind: 'agent',
      prompt: draft.prompt.trim(),
      ...(draft.cwd.trim().length === 0 ? {} : { cwd: draft.cwd.trim() }),
      ...(draft.agentPreset.trim().length === 0 ? {} : { agentPreset: draft.agentPreset.trim() }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    }
  }
  if (draft.command.trim().length === 0) return undefined
  return {
    kind: 'shell',
    command: draft.command,
    ...(draft.cwd.trim().length === 0 ? {} : { cwd: draft.cwd.trim() }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  }
}

/** Validate a Web form and produce the exact durable task row. */
export function taskFromDraft(
  draft: TaskDraft,
  settings: AutoScheduleSettings,
  current?: AutoScheduleTask,
  options: { readonly nowMs?: number; readonly id?: string } = {},
): DraftResult {
  const nowMs = options.nowMs ?? Date.now()
  if (draft.name.trim().length === 0) return { ok: false, issue: 'nameRequired' }
  const schedule = scheduleFromDraft(draft)
  if (schedule === undefined) {
    return { ok: false, issue: draft.scheduleKind === 'cron' ? 'cronRequired' : 'positiveSeconds' }
  }
  if (schedule.kind === 'every' && schedule.everySeconds < settings.minIntervalSeconds
    && !same(schedule, current?.schedule)) {
    return { ok: false, issue: 'intervalTooShort', params: { seconds: settings.minIntervalSeconds } }
  }
  if (schedule.kind === 'at' && Date.parse(schedule.at) <= nowMs && !same(schedule, current?.schedule)) {
    return { ok: false, issue: 'futureTime' }
  }
  const action = actionFromDraft(draft)
  if (action === undefined) {
    if (draft.actionKind === 'notification') return { ok: false, issue: 'notificationRequired' }
    if (draft.timeoutMs.length > 0 && positiveInteger(draft.timeoutMs) === undefined) {
      const milliseconds = draft.actionKind === 'agent'
        ? settings.maxAgentTimeoutMs
        : settings.maxShellTimeoutMs
      return { ok: false, issue: 'timeoutInvalid', params: { milliseconds } }
    }
    return { ok: false, issue: draft.actionKind === 'agent' ? 'agentPromptRequired' : 'commandRequired' }
  }
  if (action.kind === 'shell') {
    if (!settings.allowShellActions && !same(action, current?.action)) return { ok: false, issue: 'shellDisabled' }
    if (action.timeoutMs !== undefined && action.timeoutMs > settings.maxShellTimeoutMs) {
      return { ok: false, issue: 'timeoutInvalid', params: { milliseconds: settings.maxShellTimeoutMs } }
    }
    if (byteLength(action.command) > settings.maxCommandBytes) return { ok: false, issue: 'contentTooLarge' }
  } else if (action.kind === 'agent') {
    if (!settings.allowAgentActions && !same(action, current?.action)) {
      return { ok: false, issue: 'agentDisabled' }
    }
    if (action.timeoutMs !== undefined && action.timeoutMs > settings.maxAgentTimeoutMs) {
      return { ok: false, issue: 'timeoutInvalid', params: { milliseconds: settings.maxAgentTimeoutMs } }
    }
    if (byteLength(action.prompt) > settings.maxAgentPromptBytes) {
      return { ok: false, issue: 'contentTooLarge' }
    }
  } else if (byteLength(action.title) + byteLength(action.body) > settings.maxNotificationBytes) {
    return { ok: false, issue: 'contentTooLarge' }
  }

  const executionChanged = current === undefined
    || draft.enabled !== current.enabled
    || !same(schedule, current.schedule)
    || !same(action, current.action)
  const timestamp = new Date(nowMs).toISOString()
  return {
    ok: true,
    task: {
      id: current?.id ?? options.id ?? `auto-schedule-${globalThis.crypto.randomUUID()}`,
      name: draft.name.trim(),
      enabled: draft.enabled,
      schedule,
      action,
      revision: (current?.revision ?? 0) + 1,
      executionRevision: (current?.executionRevision ?? 0) + (executionChanged ? 1 : 0),
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: timestamp,
    },
  }
}
