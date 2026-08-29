import type { SchedulerClock } from '../../src/scheduler.js'

export class ManualClock implements SchedulerClock {
  private timestamp: number
  private handle = 0
  private timers = new Map<number, { readonly at: number; readonly callback: () => void }>()

  constructor(instant: string | number) {
    this.timestamp = typeof instant === 'number' ? instant : Date.parse(instant)
  }

  now = (): number => this.timestamp

  setTimer(callback: () => void, delayMs: number): unknown {
    const handle = ++this.handle
    this.timers.set(handle, { at: this.timestamp + delayMs, callback })
    return handle
  }

  clearTimer(handle: unknown): void {
    this.timers.delete(handle as number)
  }

  /** Move wall time and run every timer that was due at the sampled destination once. */
  advance(milliseconds: number): void {
    this.timestamp += milliseconds
    const due = [...this.timers.entries()]
      .filter(([, timer]) => timer.at <= this.timestamp)
      .sort((left, right) => left[1].at - right[1].at)
    for (const [handle, timer] of due) {
      if (!this.timers.delete(handle)) continue
      timer.callback()
    }
  }

  get nextTimerAt(): number | undefined {
    return [...this.timers.values()].reduce<number | undefined>(
      (earliest, timer) => earliest === undefined || timer.at < earliest ? timer.at : earliest,
      undefined,
    )
  }
}
