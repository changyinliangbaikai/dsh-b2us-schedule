import { Cron } from 'croner'

/** Supported user-visible schedule selectors. */
export type ScheduleRule =
  | { readonly kind: 'cron'; readonly expression: string; readonly timeZone: string }
  | { readonly kind: 'after'; readonly afterSeconds: number }
  | { readonly kind: 'at'; readonly at: string }
  | { readonly kind: 'every'; readonly everySeconds: number }

/** Supported unattended actions. Shell scripts use the shell action too. */
export type ScheduleAction =
  | {
    readonly kind: 'shell'
    readonly command: string
    readonly cwd?: string
    readonly timeoutMs?: number
  }
  | {
    readonly kind: 'agent'
    /** User-authored task instructions delivered to a fresh top-level Agent session. */
    readonly prompt: string
    readonly cwd?: string
    /** Omitted uses the effective DSH default Agent preset at execution time. */
    readonly agentPreset?: string
    readonly timeoutMs?: number
  }
  | {
    readonly kind: 'notification'
    readonly title: string
    readonly body: string
  }

/** Durable user-owned task definition stored in the Settings document. */
export interface AutoScheduleTask {
  readonly id: string
  readonly name: string
  readonly enabled: boolean
  readonly schedule: ScheduleRule
  readonly action: ScheduleAction
  /** Monotonic edit revision for UI conflict/audit display. */
  readonly revision: number
  /** Increments only when enablement, timing, or action changes. */
  readonly executionRevision: number
  readonly createdAt: string
  readonly updatedAt: string
}

export type RunOutcome = 'succeeded' | 'failed' | 'aborted'

/** Bounded result retained for one completed occurrence. */
export interface LastRun {
  readonly scheduledAt: string
  readonly startedAt: string
  readonly finishedAt: string
  readonly outcome: RunOutcome
  readonly exitCode?: number | null
  readonly timedOut?: boolean
  readonly sandboxDenied?: boolean
  readonly stdout?: string
  readonly stderr?: string
  readonly error?: string
  /** Persisted top-level DSH Session created for an Agent action. */
  readonly agentSessionId?: string
  /** Effective preset used to compose the scheduled Agent, when the Host has a preset roster. */
  readonly agentPreset?: string
}

export type RuntimeState =
  | 'scheduled'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'completed'
  | 'disabled'
  | 'blocked'

/** Host-owned execution projection, kept separate from the task array. */
export interface TaskRuntime {
  readonly taskId: string
  readonly taskRevision: number
  readonly state: RuntimeState
  readonly nextRunAt: string | null
  readonly lastRun?: LastRun
  /** Newest-first bounded history. Optional only for v0.1.x document compatibility. */
  readonly history?: readonly LastRun[]
  readonly message?: string
}

/** Fully resolved namespace served to the Host and Web settings page. */
export interface AutoScheduleSettings {
  readonly tasks: readonly AutoScheduleTask[]
  readonly runtime: readonly TaskRuntime[]
  readonly allowShellActions: boolean
  readonly allowAgentActions: boolean
  readonly defaultTimeZone: string
  readonly minIntervalSeconds: number
  readonly maxHistoryEntriesPerTask: number
  readonly maxShellTimeoutMs: number
  readonly defaultAgentTimeoutMs: number
  readonly maxAgentTimeoutMs: number
  readonly maxAgentPromptBytes: number
  readonly shellOutputMaxBytes: number
  readonly maxCommandBytes: number
  readonly maxNotificationBytes: number
  readonly notificationTimeoutMs: number
  readonly schedulerRetryMs: number
}

export interface PolicyIssue {
  readonly code:
    | 'shell_disabled'
    | 'agent_disabled'
    | 'agent_prompt_too_large'
    | 'frequency_too_high'
    | 'timeout_too_high'
    | 'command_too_large'
    | 'notification_too_large'
    | 'not_future'
    | 'cron_exhausted'
  readonly message: string
}

/** Stable validation failure used at every settings and tool boundary. */
export class ScheduleValidationError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ScheduleValidationError'
    this.code = code
  }
}

const OFFSET_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|([+-])(\d{2}):(\d{2}))$/
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

/** Return a canonical UTC instant, requiring an explicit offset. */
export function canonicalInstant(value: string): string {
  const parts = OFFSET_DATE_TIME.exec(value)
  if (parts === null) {
    throw new ScheduleValidationError(
      'invalid_time',
      'at must be an ISO date-time with seconds and an explicit Z or numeric UTC offset.',
    )
  }
  const year = Number(parts[1])
  const month = Number(parts[2])
  const day = Number(parts[3])
  const hour = Number(parts[4])
  const minute = Number(parts[5])
  const second = Number(parts[6])
  const offsetHour = parts[8] === undefined ? 0 : Number(parts[8])
  const offsetMinute = parts[9] === undefined ? 0 : Number(parts[9])
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (month < 1 || month > 12 || day < 1 || day > (days[month - 1] ?? 0)
    || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
    throw new ScheduleValidationError('invalid_time', 'at is not a real calendar instant.')
  }
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) {
    throw new ScheduleValidationError('invalid_time', 'at is not a real calendar instant.')
  }
  return new Date(timestamp).toISOString()
}

/** Validate and preserve an IANA zone or UTC identifier. */
export function validTimeZone(value: string): boolean {
  if (value.length === 0 || value.trim() !== value) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0)
    return value === 'UTC' || value.includes('/')
  } catch {
    return false
  }
}

/** Resolve the first Cron occurrence strictly after `afterMs`. */
export function nextCronOccurrence(rule: Extract<ScheduleRule, { kind: 'cron' }>, afterMs: number): number | null {
  let cron: Cron
  try {
    cron = new Cron(rule.expression, { paused: true, timezone: rule.timeZone })
  } catch (cause) {
    throw new ScheduleValidationError(
      'invalid_cron',
      `Invalid cron expression: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
  try {
    return cron.nextRun(new Date(afterMs))?.getTime() ?? null
  } finally {
    cron.stop()
  }
}

/** Compute two Cron occurrences to enforce the configured cadence floor. */
export function cronIntervalSeconds(rule: Extract<ScheduleRule, { kind: 'cron' }>, afterMs: number): number | null {
  const first = nextCronOccurrence(rule, afterMs)
  if (first === null) return null
  const second = nextCronOccurrence(rule, first)
  return second === null ? null : (second - first) / 1_000
}

function requireNonBlank(field: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ScheduleValidationError('invalid_task', `${field} must be a non-empty string.`)
  }
}

function requireSafePositive(field: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new ScheduleValidationError('invalid_task', `${field} must be a positive safe integer.`)
  }
}

function requireIso(field: string, value: unknown): asserts value is string {
  requireNonBlank(field, value)
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new ScheduleValidationError('invalid_task', `${field} must be a canonical UTC ISO instant.`)
  }
}

/** Strictly validate one persisted execution result. */
export function assertLastRun(run: unknown): asserts run is LastRun {
  if (typeof run !== 'object' || run === null || Array.isArray(run)) {
    throw new ScheduleValidationError('invalid_runtime', 'run history entry must be an object.')
  }
  const row = run as Record<string, unknown>
  requireIso('run.scheduledAt', row.scheduledAt)
  requireIso('run.startedAt', row.startedAt)
  requireIso('run.finishedAt', row.finishedAt)
  if (Date.parse(row.finishedAt) < Date.parse(row.startedAt)) {
    throw new ScheduleValidationError('invalid_runtime', 'run.finishedAt must not precede run.startedAt.')
  }
  if (!['succeeded', 'failed', 'aborted'].includes(String(row.outcome))) {
    throw new ScheduleValidationError('invalid_runtime', 'run.outcome is unsupported.')
  }
  if (row.exitCode !== undefined && row.exitCode !== null
    && (typeof row.exitCode !== 'number' || !Number.isSafeInteger(row.exitCode))) {
    throw new ScheduleValidationError('invalid_runtime', 'run.exitCode must be an integer or null.')
  }
  for (const field of ['timedOut', 'sandboxDenied'] as const) {
    if (row[field] !== undefined && typeof row[field] !== 'boolean') {
      throw new ScheduleValidationError('invalid_runtime', `run.${field} must be boolean.`)
    }
  }
  for (const field of ['stdout', 'stderr', 'error'] as const) {
    if (row[field] !== undefined && typeof row[field] !== 'string') {
      throw new ScheduleValidationError('invalid_runtime', `run.${field} must be a string.`)
    }
  }
  for (const field of ['agentSessionId', 'agentPreset'] as const) {
    if (row[field] !== undefined) requireNonBlank(`run.${field}`, row[field])
  }
}

/** Strictly validate one durable task independently of deployment policy. */
export function assertTask(task: unknown): asserts task is AutoScheduleTask {
  if (typeof task !== 'object' || task === null || Array.isArray(task)) {
    throw new ScheduleValidationError('invalid_task', 'task must be an object.')
  }
  const row = task as Record<string, unknown>
  requireNonBlank('task.id', row.id)
  if (!TASK_ID.test(row.id)) {
    throw new ScheduleValidationError('invalid_task', 'task.id contains unsupported characters or is too long.')
  }
  requireNonBlank('task.name', row.name)
  if (typeof row.enabled !== 'boolean') {
    throw new ScheduleValidationError('invalid_task', 'task.enabled must be boolean.')
  }
  requireSafePositive('task.revision', row.revision)
  requireSafePositive('task.executionRevision', row.executionRevision)
  requireIso('task.createdAt', row.createdAt)
  requireIso('task.updatedAt', row.updatedAt)

  const schedule = row.schedule as Record<string, unknown> | null
  if (typeof schedule !== 'object' || schedule === null || Array.isArray(schedule)) {
    throw new ScheduleValidationError('invalid_task', 'task.schedule must be an object.')
  }
  switch (schedule.kind) {
    case 'cron':
      requireNonBlank('schedule.expression', schedule.expression)
      requireNonBlank('schedule.timeZone', schedule.timeZone)
      if (!validTimeZone(schedule.timeZone)) {
        throw new ScheduleValidationError('invalid_time_zone', 'schedule.timeZone must be UTC or an IANA Area/Location.')
      }
      nextCronOccurrence(schedule as Extract<ScheduleRule, { kind: 'cron' }>, Date.now())
      break
    case 'after':
      requireSafePositive('schedule.afterSeconds', schedule.afterSeconds)
      break
    case 'at':
      requireNonBlank('schedule.at', schedule.at)
      if (canonicalInstant(schedule.at) !== schedule.at) {
        throw new ScheduleValidationError('invalid_time', 'schedule.at must be stored in canonical UTC form.')
      }
      break
    case 'every':
      requireSafePositive('schedule.everySeconds', schedule.everySeconds)
      break
    default:
      throw new ScheduleValidationError('invalid_task', 'task.schedule.kind is unsupported.')
  }

  const action = row.action as Record<string, unknown> | null
  if (typeof action !== 'object' || action === null || Array.isArray(action)) {
    throw new ScheduleValidationError('invalid_task', 'task.action must be an object.')
  }
  switch (action.kind) {
    case 'shell':
      requireNonBlank('action.command', action.command)
      if (action.cwd !== undefined) requireNonBlank('action.cwd', action.cwd)
      if (action.timeoutMs !== undefined) requireSafePositive('action.timeoutMs', action.timeoutMs)
      break
    case 'notification':
      requireNonBlank('action.title', action.title)
      requireNonBlank('action.body', action.body)
      break
    case 'agent':
      requireNonBlank('action.prompt', action.prompt)
      if (action.cwd !== undefined) requireNonBlank('action.cwd', action.cwd)
      if (action.agentPreset !== undefined) requireNonBlank('action.agentPreset', action.agentPreset)
      if (action.timeoutMs !== undefined) requireSafePositive('action.timeoutMs', action.timeoutMs)
      break
    default:
      throw new ScheduleValidationError('invalid_task', 'task.action.kind is unsupported.')
  }
}

/** Strictly validate one Host-owned runtime row. */
export function assertRuntime(runtime: unknown): asserts runtime is TaskRuntime {
  if (typeof runtime !== 'object' || runtime === null || Array.isArray(runtime)) {
    throw new ScheduleValidationError('invalid_runtime', 'runtime entry must be an object.')
  }
  const row = runtime as Record<string, unknown>
  requireNonBlank('runtime.taskId', row.taskId)
  requireSafePositive('runtime.taskRevision', row.taskRevision)
  if (!['scheduled', 'running', 'succeeded', 'failed', 'completed', 'disabled', 'blocked'].includes(String(row.state))) {
    throw new ScheduleValidationError('invalid_runtime', 'runtime.state is unsupported.')
  }
  if (row.nextRunAt !== null) requireIso('runtime.nextRunAt', row.nextRunAt)
  if (row.lastRun !== undefined) assertLastRun(row.lastRun)
  if (row.history !== undefined) {
    if (!Array.isArray(row.history)) {
      throw new ScheduleValidationError('invalid_runtime', 'runtime.history must be an array.')
    }
    for (const run of row.history) assertLastRun(run)
  }
  if (row.message !== undefined && typeof row.message !== 'string') {
    throw new ScheduleValidationError('invalid_runtime', 'runtime.message must be a string.')
  }
}

/** Determine whether a structurally valid task is executable under current policy. */
export function taskPolicyIssue(
  task: AutoScheduleTask,
  settings: AutoScheduleSettings,
  nowMs: number,
  requireFuture = false,
): PolicyIssue | undefined {
  const rule = task.schedule
  if (rule.kind === 'every' && rule.everySeconds < settings.minIntervalSeconds) {
    return {
      code: 'frequency_too_high',
      message: `everySeconds must be at least ${String(settings.minIntervalSeconds)}.`,
    }
  }
  if (rule.kind === 'cron') {
    const cadence = cronIntervalSeconds(rule, nowMs)
    if (cadence !== null && cadence < settings.minIntervalSeconds) {
      return {
        code: 'frequency_too_high',
        message: `cron cadence must be at least ${String(settings.minIntervalSeconds)} seconds.`,
      }
    }
    if (nextCronOccurrence(rule, nowMs) === null) {
      return { code: 'cron_exhausted', message: 'cron expression has no future occurrence.' }
    }
  }
  if (rule.kind === 'at' && requireFuture && Date.parse(rule.at) <= nowMs) {
    return { code: 'not_future', message: 'at must be strictly in the future.' }
  }

  if (task.action.kind === 'shell') {
    if (!settings.allowShellActions) {
      return { code: 'shell_disabled', message: 'Shell actions are disabled by plugin settings.' }
    }
    if (Buffer.byteLength(task.action.command) > settings.maxCommandBytes) {
      return { code: 'command_too_large', message: 'Shell command exceeds maxCommandBytes.' }
    }
    if (task.action.timeoutMs !== undefined && task.action.timeoutMs > settings.maxShellTimeoutMs) {
      return { code: 'timeout_too_high', message: 'Shell timeout exceeds maxShellTimeoutMs.' }
    }
  } else if (task.action.kind === 'agent') {
    if (!settings.allowAgentActions) {
      return { code: 'agent_disabled', message: 'Agent actions are disabled by plugin settings.' }
    }
    if (Buffer.byteLength(task.action.prompt) > settings.maxAgentPromptBytes) {
      return { code: 'agent_prompt_too_large', message: 'Agent prompt exceeds maxAgentPromptBytes.' }
    }
    if (task.action.timeoutMs !== undefined && task.action.timeoutMs > settings.maxAgentTimeoutMs) {
      return { code: 'timeout_too_high', message: 'Agent timeout exceeds maxAgentTimeoutMs.' }
    }
  } else if (Buffer.byteLength(task.action.title) + Buffer.byteLength(task.action.body)
    > settings.maxNotificationBytes) {
    return { code: 'notification_too_large', message: 'Notification content exceeds maxNotificationBytes.' }
  }
  return undefined
}

/** First occurrence for a new or revised task. */
export function initialOccurrence(task: AutoScheduleTask): number | null {
  const anchor = Date.parse(task.updatedAt)
  switch (task.schedule.kind) {
    case 'after': return anchor + task.schedule.afterSeconds * 1_000
    case 'at': return Date.parse(task.schedule.at)
    case 'every': return anchor + task.schedule.everySeconds * 1_000
    case 'cron': return nextCronOccurrence(task.schedule, anchor)
  }
}

/** Next recurring occurrence after one dispatch decision, skipping backlog. */
export function nextRecurringOccurrence(
  task: AutoScheduleTask,
  decisionMs: number,
  scheduledMs: number,
): number | null {
  if (task.schedule.kind === 'cron') {
    return nextCronOccurrence(task.schedule, Math.max(decisionMs, scheduledMs))
  }
  if (task.schedule.kind !== 'every') return null
  const anchor = Date.parse(task.updatedAt)
  const interval = task.schedule.everySeconds * 1_000
  const index = Math.floor((Math.max(decisionMs, scheduledMs) - anchor) / interval) + 1
  return anchor + index * interval
}

/** JSON structural equality for immutable Settings projections. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b)
      && a.length === b.length
      && a.every((entry, index) => deepEqual(entry, b[index]))
  }
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length
    && keys.every(key => key in right && deepEqual(left[key], right[key]))
}
