import type { LastRun, TaskRuntime } from './domain.js'

/** Stable occurrence identity used only to prevent migration/append duplicates. */
export function runKey(run: LastRun): string {
  return `${run.scheduledAt}\u0000${run.startedAt}\u0000${run.finishedAt}`
}

/** Read a v0.1-compatible runtime as a newest-first execution history. */
export function runtimeHistory(runtime: TaskRuntime): readonly LastRun[] {
  const history = runtime.history ?? []
  if (runtime.lastRun === undefined) return history
  const key = runKey(runtime.lastRun)
  return history.some(run => runKey(run) === key) ? history : [runtime.lastRun, ...history]
}
