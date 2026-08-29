import { randomUUID } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import {
  assertTask,
  canonicalInstant,
  deepEqual,
  ScheduleValidationError,
  taskPolicyIssue,
  type AutoScheduleSettings,
  type AutoScheduleTask,
  type LastRun,
  type ScheduleAction,
  type ScheduleRule,
  type TaskRuntime,
} from './domain.js'
import { runtimeHistory } from './history.js'
import { createAgentActionExecutor, type AgentActionExecutor } from './agent-action.js'
import {
  AUTO_SCHEDULE_NAMESPACE,
  Config,
  assertSettings,
  resolveSettings,
  type Config as PluginConfig,
} from './config.js'
import { AutoScheduleRuntime, systemClock, type SchedulerClock } from './scheduler.js'

export interface CreateTaskInput {
  readonly name: string
  readonly enabled?: boolean
  readonly schedule: ScheduleRule
  readonly action: ScheduleAction
}

export interface UpdateTaskInput {
  readonly id: string
  readonly name?: string
  readonly enabled?: boolean
  readonly schedule?: ScheduleRule
  readonly action?: ScheduleAction
}

export interface TaskView {
  readonly task: AutoScheduleTask
  readonly runtime?: TaskRuntime
}

export class TaskNotFoundError extends Error {
  readonly code = 'task_not_found'

  constructor(id: string) {
    super(`No scheduled task exists with id ${JSON.stringify(id)}.`)
    this.name = 'TaskNotFoundError'
  }
}

function normalizeRule(rule: ScheduleRule, defaultTimeZone: string): ScheduleRule {
  switch (rule.kind) {
    case 'cron': return {
      kind: 'cron',
      expression: rule.expression.trim(),
      timeZone: rule.timeZone.trim() || defaultTimeZone,
    }
    case 'after': return { kind: 'after', afterSeconds: rule.afterSeconds }
    case 'at': return { kind: 'at', at: canonicalInstant(rule.at) }
    case 'every': return { kind: 'every', everySeconds: rule.everySeconds }
  }
}

function normalizeAction(action: ScheduleAction): ScheduleAction {
  if (action.kind === 'notification') {
    return { kind: 'notification', title: action.title.trim(), body: action.body.trim() }
  }
  if (action.kind === 'agent') {
    return {
      kind: 'agent',
      prompt: action.prompt.trim(),
      ...action.cwd === undefined ? {} : { cwd: action.cwd.trim() },
      ...action.agentPreset === undefined ? {} : { agentPreset: action.agentPreset.trim() },
      ...action.timeoutMs === undefined ? {} : { timeoutMs: action.timeoutMs },
    }
  }
  return {
    kind: 'shell',
    command: action.command,
    ...action.cwd === undefined ? {} : { cwd: action.cwd.trim() },
    ...action.timeoutMs === undefined ? {} : { timeoutMs: action.timeoutMs },
  }
}

/** Host service owning durable CRUD and the disposable timer projection. */
export class AutoScheduleService extends Service {
  private readonly scope: SettingsScope<AutoScheduleSettings>
  private readonly runtime: AutoScheduleRuntime
  private readonly clock: SchedulerClock
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(
    ctx: Context,
    config: PluginConfig,
    clock?: SchedulerClock,
    agentExecutor: AgentActionExecutor = createAgentActionExecutor(ctx),
  ) {
    super(ctx, 'autoSchedule')
    const base = resolveSettings(config)
    assertSettings(base as unknown as PluginConfig)
    this.clock = clock ?? systemClock
    this.scope = ctx.settings.register(AUTO_SCHEDULE_NAMESPACE, Config, {
      base: base as unknown as PluginConfig,
      validate: value => { assertSettings(value as PluginConfig) },
    }) as unknown as SettingsScope<AutoScheduleSettings>
    this.runtime = new AutoScheduleRuntime({
      scope: this.scope,
      shell: ctx.shell,
      agent: agentExecutor,
      logger: ctx.logger,
      clock: this.clock,
    })
  }

  async start(): Promise<void> {
    await this.runtime.start()
  }

  async dispose(): Promise<void> {
    await this.runtime.dispose()
    await this.mutationTail
  }

  async settle(): Promise<void> {
    await this.runtime.settle()
  }

  settings(): AutoScheduleSettings {
    return this.scope.get()
  }

  list(): readonly TaskView[] {
    const settings = this.scope.get()
    const runtime = new Map(settings.runtime.map(row => [row.taskId, row]))
    return settings.tasks.map((task): TaskView => {
      const row = runtime.get(task.id)
      return row === undefined ? { task } : { task, runtime: row }
    })
  }

  history(id: string, limit?: number): readonly LastRun[] {
    const settings = this.scope.get()
    if (!settings.tasks.some(task => task.id === id)) throw new TaskNotFoundError(id)
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) {
      throw new ScheduleValidationError('invalid_limit', 'History limit must be a positive integer.')
    }
    const runtime = settings.runtime.find(row => row.taskId === id)
    if (runtime === undefined) return []
    const count = Math.min(limit ?? settings.maxHistoryEntriesPerTask, settings.maxHistoryEntriesPerTask)
    return runtimeHistory(runtime).slice(0, count)
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.then(operation, operation)
    this.mutationTail = run.then(() => undefined, () => undefined)
    return run
  }

  create(input: CreateTaskInput): Promise<TaskView> {
    return this.serialize(async () => {
      const settings = this.scope.get()
      const now = this.clock.now()
      const timestamp = new Date(now).toISOString()
      const task: AutoScheduleTask = {
        id: `auto-schedule-${randomUUID()}`,
        name: input.name.trim(),
        enabled: input.enabled ?? true,
        schedule: normalizeRule(input.schedule, settings.defaultTimeZone),
        action: normalizeAction(input.action),
        revision: 1,
        executionRevision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      assertTask(task)
      const issue = taskPolicyIssue(task, settings, now, true)
      if (issue !== undefined) throw Object.assign(new Error(issue.message), { code: issue.code })
      await this.scope.update({ tasks: [...settings.tasks, task] })
      return { task }
    })
  }

  update(input: UpdateTaskInput): Promise<TaskView> {
    return this.serialize(async () => {
      const settings = this.scope.get()
      const index = settings.tasks.findIndex(task => task.id === input.id)
      if (index < 0) throw new TaskNotFoundError(input.id)
      const current = settings.tasks[index] as AutoScheduleTask
      const candidate = {
        name: input.name === undefined ? current.name : input.name.trim(),
        enabled: input.enabled ?? current.enabled,
        schedule: input.schedule === undefined
          ? current.schedule
          : normalizeRule(input.schedule, settings.defaultTimeZone),
        action: input.action === undefined ? current.action : normalizeAction(input.action),
      }
      const executionChanged = candidate.enabled !== current.enabled
        || !deepEqual(candidate.schedule, current.schedule)
        || !deepEqual(candidate.action, current.action)
      if (!executionChanged && candidate.name === current.name) {
        const runtime = settings.runtime.find(row => row.taskId === current.id)
        return { task: current, ...runtime === undefined ? {} : { runtime } }
      }
      const next: AutoScheduleTask = {
        ...current,
        ...candidate,
        revision: current.revision + 1,
        executionRevision: current.executionRevision + (executionChanged ? 1 : 0),
        updatedAt: new Date(this.clock.now()).toISOString(),
      }
      assertTask(next)
      const issue = taskPolicyIssue(next, settings, this.clock.now(), input.schedule !== undefined)
      if (issue !== undefined) throw Object.assign(new Error(issue.message), { code: issue.code })
      const tasks = [...settings.tasks]
      tasks[index] = next
      await this.scope.update({ tasks })
      const runtime = this.scope.get().runtime.find(row => row.taskId === next.id)
      return { task: next, ...runtime === undefined ? {} : { runtime } }
    })
  }

  delete(id: string): Promise<boolean> {
    return this.serialize(async () => {
      const settings = this.scope.get()
      const tasks = settings.tasks.filter(task => task.id !== id)
      if (tasks.length === settings.tasks.length) return false
      await this.scope.update({ tasks })
      return true
    })
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    autoSchedule: AutoScheduleService
  }
}
