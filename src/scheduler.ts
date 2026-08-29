import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type { ShellExecutor, ShellRunResult } from '@deepseek-ai/dsh-shell'
import type { AgentActionExecutor } from './agent-action.js'
import {
  deepEqual,
  initialOccurrence,
  nextRecurringOccurrence,
  taskPolicyIssue,
  type AutoScheduleSettings,
  type AutoScheduleTask,
  type LastRun,
  type TaskRuntime,
} from './domain.js'
import { runKey, runtimeHistory } from './history.js'
import { systemNotificationCommand } from './notification.js'

const MAX_TIMER_DELAY_MS = 2_147_483_647

export interface SchedulerClock {
  now(): number
  setTimer(callback: () => void, delayMs: number): unknown
  clearTimer(handle: unknown): void
}

export const systemClock: SchedulerClock = {
  now: Date.now,
  setTimer(callback, delayMs) {
    const handle = setTimeout(callback, delayMs)
    handle.unref()
    return handle
  },
  clearTimer(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}

export interface SchedulerLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

interface ActiveRun {
  readonly taskId: string
  readonly executionRevision: number
  readonly controller: AbortController
}

interface ActionResult {
  readonly run: LastRun
  readonly message?: string
}

function runtimeMap(rows: readonly TaskRuntime[]): Map<string, TaskRuntime> {
  return new Map(rows.map(row => [row.taskId, row]))
}

function orderedRuntime(tasks: readonly AutoScheduleTask[], rows: ReadonlyMap<string, TaskRuntime>): TaskRuntime[] {
  return tasks.flatMap(task => {
    const row = rows.get(task.id)
    return row === undefined ? [] : [row]
  })
}

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString()
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function outputText(text: string, truncated: boolean): string | undefined {
  if (text.length === 0 && !truncated) return undefined
  return truncated ? `${text}\n[output truncated by DSH shell executor]` : text
}

function retainedRuns(current: TaskRuntime | undefined, limit: number): Pick<TaskRuntime, 'history' | 'lastRun'> {
  if (current === undefined) return { history: [] }
  const history = runtimeHistory(current).slice(0, limit)
  const lastRun = current.lastRun ?? history[0]
  return { history, ...lastRun === undefined ? {} : { lastRun } }
}

function appendRun(current: TaskRuntime, run: LastRun, limit: number): readonly LastRun[] {
  const key = runKey(run)
  return [run, ...runtimeHistory(current).filter(candidate => runKey(candidate) !== key)].slice(0, limit)
}

/** Durable timer projection and serial unattended executor. */
export class AutoScheduleRuntime {
  private readonly scope: SettingsScope<AutoScheduleSettings>
  private readonly shell: ShellExecutor
  private readonly agent: AgentActionExecutor
  private readonly logger: SchedulerLogger
  private readonly clock: SchedulerClock
  private readonly platform: NodeJS.Platform
  private active = false
  private driveRequested = false
  private draining = false
  private tail: Promise<void> = Promise.resolve()
  private timer: unknown
  private stopWatch: (() => void) | undefined
  private activeRun: ActiveRun | undefined

  constructor(options: {
    scope: SettingsScope<AutoScheduleSettings>
    shell: ShellExecutor
    agent: AgentActionExecutor
    logger: SchedulerLogger
    clock?: SchedulerClock
    platform?: NodeJS.Platform
  }) {
    this.scope = options.scope
    this.shell = options.shell
    this.agent = options.agent
    this.logger = options.logger
    this.clock = options.clock ?? systemClock
    this.platform = options.platform ?? process.platform
  }

  /** Attach the settings observer and materialize the first timer projection. */
  async start(): Promise<void> {
    if (this.active) return
    this.active = true
    this.stopWatch = this.scope.watch((next) => {
      const run = this.activeRun
      if (run !== undefined) {
        const task = next.tasks.find(candidate => candidate.id === run.taskId)
        if (task === undefined || !task.enabled || task.executionRevision !== run.executionRevision) {
          run.controller.abort('scheduled task changed while running')
        }
      }
      this.requestDrive()
    })
    this.requestDrive()
    await this.settle()
  }

  /** Cancel timers and the active DSH shell call, then join scheduler work. */
  async dispose(): Promise<void> {
    if (!this.active) return
    this.active = false
    this.driveRequested = false
    this.clearArmedTimer()
    this.stopWatch?.()
    this.stopWatch = undefined
    this.activeRun?.controller.abort('auto-schedule plugin disposed')
    await this.settle()
  }

  /** Test/diagnostic barrier for all work queued before it stabilizes. */
  async settle(): Promise<void> {
    while (true) {
      const observed = this.tail
      await observed
      if (observed === this.tail) return
    }
  }

  private clearArmedTimer(): void {
    if (this.timer === undefined) return
    this.clock.clearTimer(this.timer)
    this.timer = undefined
  }

  private armAt(timestamp: number): void {
    if (!this.active) return
    this.clearArmedTimer()
    const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, timestamp - this.clock.now()))
    this.timer = this.clock.setTimer(() => {
      this.timer = undefined
      this.requestDrive()
    }, delay)
  }

  private requestDrive(): void {
    if (!this.active) return
    this.driveRequested = true
    if (this.draining) return
    this.draining = true
    this.tail = this.tail.then(async () => {
      while (this.active && this.driveRequested) {
        this.driveRequested = false
        try {
          await this.driveOnce()
        } catch (error: unknown) {
          this.logger.error(`auto-schedule: scheduler drive failed: ${errorText(error)}`)
          this.armAt(this.clock.now() + this.scope.get().schedulerRetryMs)
          break
        }
      }
    }).finally(() => {
      this.draining = false
      if (this.active && this.driveRequested) this.requestDrive()
    })
  }

  private reconcile(settings: AutoScheduleSettings): TaskRuntime[] {
    const previous = runtimeMap(settings.runtime)
    const next = new Map<string, TaskRuntime>()
    const now = this.clock.now()
    for (const task of settings.tasks) {
      const current = previous.get(task.id)
      if (!task.enabled) {
        next.set(task.id, {
          taskId: task.id,
          taskRevision: task.executionRevision,
          state: 'disabled',
          nextRunAt: null,
          ...retainedRuns(current, settings.maxHistoryEntriesPerTask),
        })
        continue
      }

      const issue = taskPolicyIssue(task, settings, now)
      const mayDeliverFinalPersistedCron = issue?.code === 'cron_exhausted'
        && current?.taskRevision === task.executionRevision
        && current.nextRunAt !== null
      if (issue !== undefined && !mayDeliverFinalPersistedCron) {
        next.set(task.id, {
          taskId: task.id,
          taskRevision: task.executionRevision,
          state: issue.code === 'cron_exhausted' ? 'completed' : 'blocked',
          nextRunAt: null,
          message: issue.message,
          ...retainedRuns(current, settings.maxHistoryEntriesPerTask),
        })
        continue
      }

      if (current !== undefined && current.taskRevision === task.executionRevision
        && current.state !== 'disabled' && current.state !== 'blocked') {
        if (current.state === 'running'
          && (this.activeRun?.taskId !== task.id
            || this.activeRun.executionRevision !== task.executionRevision)) {
          next.set(task.id, {
            ...current,
            ...retainedRuns(current, settings.maxHistoryEntriesPerTask),
            state: 'scheduled',
            message: 'Recovered an interrupted occurrence.',
          })
        } else {
          next.set(task.id, { ...current, ...retainedRuns(current, settings.maxHistoryEntriesPerTask) })
        }
        continue
      }

      const first = initialOccurrence(task)
      next.set(task.id, {
        taskId: task.id,
        taskRevision: task.executionRevision,
        state: first === null ? 'completed' : 'scheduled',
        nextRunAt: first === null ? null : iso(first),
        ...first === null ? { message: 'No future occurrence.' } : {},
        ...retainedRuns(current, settings.maxHistoryEntriesPerTask),
      })
    }
    return orderedRuntime(settings.tasks, next)
  }

  private async driveOnce(): Promise<void> {
    this.clearArmedTimer()
    let settings = this.scope.get()
    const reconciled = this.reconcile(settings)
    if (!deepEqual(reconciled, settings.runtime)) {
      await this.scope.update({ runtime: reconciled })
      settings = this.scope.get()
    }

    const now = this.clock.now()
    const runtimes = runtimeMap(settings.runtime)
    const due = settings.tasks.flatMap(task => {
      const runtime = runtimes.get(task.id)
      if (!task.enabled || runtime?.nextRunAt === null || runtime?.nextRunAt === undefined) return []
      return Date.parse(runtime.nextRunAt) <= now ? [{ task, runtime }] : []
    }).sort((left, right) => Date.parse(left.runtime.nextRunAt as string) - Date.parse(right.runtime.nextRunAt as string))

    if (due.length > 0) {
      for (const row of due) {
        if (!this.active) return
        await this.dispatch(row.task.id, row.task.executionRevision, row.runtime.nextRunAt as string)
      }
      this.driveRequested = true
      return
    }

    const nextTimestamp = settings.runtime.reduce<number | null>((earliest, runtime) => {
      if (runtime.nextRunAt === null) return earliest
      const timestamp = Date.parse(runtime.nextRunAt)
      return earliest === null || timestamp < earliest ? timestamp : earliest
    }, null)
    if (nextTimestamp !== null) this.armAt(nextTimestamp)
  }

  private async replaceRuntime(taskId: string, replacement: TaskRuntime | undefined): Promise<void> {
    const settings = this.scope.get()
    const rows = runtimeMap(settings.runtime)
    if (replacement === undefined) rows.delete(taskId)
    else rows.set(taskId, replacement)
    await this.scope.update({ runtime: orderedRuntime(settings.tasks, rows) })
  }

  private async dispatch(taskId: string, executionRevision: number, scheduledAt: string): Promise<void> {
    const settings = this.scope.get()
    const task = settings.tasks.find(candidate => candidate.id === taskId)
    const runtime = settings.runtime.find(candidate => candidate.taskId === taskId)
    if (task === undefined || runtime === undefined || !task.enabled
      || task.executionRevision !== executionRevision
      || runtime.taskRevision !== executionRevision
      || runtime.nextRunAt !== scheduledAt) return

    const startedMs = this.clock.now()
    const controller = new AbortController()
    await this.replaceRuntime(taskId, { ...runtime, state: 'running', message: 'Executing.' })

    let result: ActionResult
    this.activeRun = { taskId, executionRevision, controller }
    try {
      result = await this.executeAction(task, settings, scheduledAt, startedMs, controller.signal)
    } finally {
      this.activeRun = undefined
    }
    if (!this.active) return

    const latest = this.scope.get()
    const currentTask = latest.tasks.find(candidate => candidate.id === taskId)
    const currentRuntime = latest.runtime.find(candidate => candidate.taskId === taskId)
    if (currentTask === undefined || currentRuntime === undefined) return
    const history = appendRun(currentRuntime, result.run, latest.maxHistoryEntriesPerTask)
    if (currentTask.executionRevision !== executionRevision) {
      await this.replaceRuntime(taskId, {
        ...currentRuntime,
        lastRun: result.run,
        history,
        ...result.message === undefined ? {} : { message: result.message },
      })
      this.logger.info(`auto-schedule: task ${taskId} ${result.run.outcome}`)
      return
    }
    const finishedMs = Date.parse(result.run.finishedAt)
    const next = nextRecurringOccurrence(currentTask, finishedMs, Date.parse(scheduledAt))
    await this.replaceRuntime(taskId, {
      taskId,
      taskRevision: executionRevision,
      state: result.run.outcome === 'succeeded' ? 'succeeded' : 'failed',
      nextRunAt: next === null ? null : iso(next),
      lastRun: result.run,
      history,
      ...result.message === undefined ? {} : { message: result.message },
    })
    this.logger.info(`auto-schedule: task ${taskId} ${result.run.outcome}`)
  }

  private async executeAction(
    task: AutoScheduleTask,
    settings: AutoScheduleSettings,
    scheduledAt: string,
    startedMs: number,
    signal: AbortSignal,
  ): Promise<ActionResult> {
    if (task.action.kind === 'agent') {
      let result
      try {
        result = await this.agent.execute({
          taskId: task.id,
          taskName: task.name,
          scheduledAt,
          action: task.action,
          timeoutMs: task.action.timeoutMs ?? settings.defaultAgentTimeoutMs,
          signal,
        })
      } catch (error: unknown) {
        const message = `Agent executor infrastructure failure: ${errorText(error)}`
        return {
          message,
          run: {
            scheduledAt,
            startedAt: iso(startedMs),
            finishedAt: iso(this.clock.now()),
            outcome: signal.aborted ? 'aborted' : 'failed',
            error: message,
          },
        }
      }
      const message = result.error ?? (result.agentSessionId === undefined
        ? 'Scheduled Agent completed.'
        : `Scheduled Agent completed in session ${result.agentSessionId}.`)
      return {
        message,
        run: {
          scheduledAt,
          startedAt: iso(startedMs),
          finishedAt: iso(this.clock.now()),
          outcome: result.outcome,
          ...result.timedOut === undefined ? {} : { timedOut: result.timedOut },
          ...result.error === undefined ? {} : { error: result.error },
          ...result.agentSessionId === undefined ? {} : { agentSessionId: result.agentSessionId },
          ...result.agentPreset === undefined ? {} : { agentPreset: result.agentPreset },
        },
      }
    }
    try {
      const request = task.action.kind === 'shell'
        ? {
            command: task.action.command,
            ...task.action.cwd === undefined ? {} : { workdir: task.action.cwd },
            ...task.action.timeoutMs === undefined ? {} : { timeoutMs: task.action.timeoutMs },
            stdoutMaxBytes: settings.shellOutputMaxBytes,
            signal,
          }
        : {
            command: systemNotificationCommand(this.platform, task.action.title, task.action.body),
            timeoutMs: settings.notificationTimeoutMs,
            stdoutMaxBytes: settings.shellOutputMaxBytes,
            signal,
          }
      const result = await this.shell.run(this.shell.resolve(request))
      return this.shellResult(result, scheduledAt, startedMs)
    } catch (error: unknown) {
      const finishedAt = iso(this.clock.now())
      const message = `Executor infrastructure failure: ${errorText(error)}`
      return {
        message,
        run: {
          scheduledAt,
          startedAt: iso(startedMs),
          finishedAt,
          outcome: signal.aborted ? 'aborted' : 'failed',
          error: message,
        },
      }
    }
  }

  private shellResult(result: ShellRunResult, scheduledAt: string, startedMs: number): ActionResult {
    const sandboxDenied = result.sandbox?.denied === true || result.sandbox?.runnerFailed === true
    const succeeded = result.exitCode === 0 && !result.timedOut && !result.aborted && !sandboxDenied
    const outcome = result.aborted ? 'aborted' : succeeded ? 'succeeded' : 'failed'
    const message = succeeded
      ? undefined
      : result.timedOut
        ? `Timed out after ${String(result.timeoutMs)} ms.`
        : sandboxDenied
          ? 'DSH shell sandbox denied the scheduled action.'
          : result.aborted
            ? 'Scheduled action was aborted.'
            : `Command exited with status ${String(result.exitCode)}.`
    const stdout = outputText(result.stdout.text, result.stdout.truncated)
    const stderr = outputText(result.stderr.text, result.stderr.truncated)
    return {
      ...message === undefined ? {} : { message },
      run: {
        scheduledAt,
        startedAt: iso(startedMs),
        finishedAt: iso(this.clock.now()),
        outcome,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        sandboxDenied,
        ...(stdout === undefined ? {} : { stdout }),
        ...(stderr === undefined ? {} : { stderr }),
        ...message === undefined ? {} : { error: message },
      },
    }
  }
}
