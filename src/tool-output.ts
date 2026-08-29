import type { TaskRuntime } from './domain.js'
import { runtimeHistory } from './history.js'

export function renderToolResult(_args: unknown, value: unknown) {
  return [{ type: 'text' as const, text: JSON.stringify(value) }]
}

/** Compact list projection; full retained output is exposed by the history tool only. */
export function runtimeSummary(runtime: TaskRuntime) {
  return {
    taskId: runtime.taskId,
    taskRevision: runtime.taskRevision,
    state: runtime.state,
    nextRunAt: runtime.nextRunAt,
    ...runtime.lastRun === undefined ? {} : { lastRun: runtime.lastRun },
    ...runtime.message === undefined ? {} : { message: runtime.message },
    historyCount: runtimeHistory(runtime).length,
  }
}
