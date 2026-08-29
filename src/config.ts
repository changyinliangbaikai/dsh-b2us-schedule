import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  assertRuntime,
  assertTask,
  validTimeZone,
  type AutoScheduleSettings,
  type AutoScheduleTask,
  type TaskRuntime,
} from './domain.js'

export const AUTO_SCHEDULE_NAMESPACE = settingsNamespace('auto-schedule')

export const DEFAULT_SETTINGS: AutoScheduleSettings = Object.freeze({
  tasks: Object.freeze([]),
  runtime: Object.freeze([]),
  allowShellActions: true,
  allowAgentActions: true,
  defaultTimeZone: 'UTC',
  minIntervalSeconds: 1,
  maxHistoryEntriesPerTask: 50,
  maxShellTimeoutMs: 600_000,
  defaultAgentTimeoutMs: 900_000,
  maxAgentTimeoutMs: 3_600_000,
  maxAgentPromptBytes: 65_536,
  shellOutputMaxBytes: 16_384,
  maxCommandBytes: 32_768,
  maxNotificationBytes: 8_192,
  notificationTimeoutMs: 15_000,
  schedulerRetryMs: 5_000,
})

/** Loader config. Every field is optional before Schemastery applies defaults. */
export interface Config {
  tasks?: AutoScheduleTask[]
  runtime?: TaskRuntime[]
  allowShellActions?: boolean
  allowAgentActions?: boolean
  defaultTimeZone?: string
  minIntervalSeconds?: number
  maxHistoryEntriesPerTask?: number
  maxShellTimeoutMs?: number
  defaultAgentTimeoutMs?: number
  maxAgentTimeoutMs?: number
  maxAgentPromptBytes?: number
  shellOutputMaxBytes?: number
  maxCommandBytes?: number
  maxNotificationBytes?: number
  notificationTimeoutMs?: number
  schedulerRetryMs?: number
}

export const Config: z<Config> = z.object({
  tasks: z.array(z.any()).default([]),
  runtime: z.array(z.any()).default([]),
  allowShellActions: z.boolean().default(DEFAULT_SETTINGS.allowShellActions),
  allowAgentActions: z.boolean().default(DEFAULT_SETTINGS.allowAgentActions),
  defaultTimeZone: z.string().default(DEFAULT_SETTINGS.defaultTimeZone),
  minIntervalSeconds: z.number().step(1).min(1).default(DEFAULT_SETTINGS.minIntervalSeconds),
  maxHistoryEntriesPerTask: z.number().step(1).min(1).max(1_000)
    .default(DEFAULT_SETTINGS.maxHistoryEntriesPerTask),
  maxShellTimeoutMs: z.number().step(1).min(1).default(DEFAULT_SETTINGS.maxShellTimeoutMs),
  defaultAgentTimeoutMs: z.number().step(1).min(1).default(DEFAULT_SETTINGS.defaultAgentTimeoutMs),
  maxAgentTimeoutMs: z.number().step(1).min(1).default(DEFAULT_SETTINGS.maxAgentTimeoutMs),
  maxAgentPromptBytes: z.number().step(1).min(1).default(DEFAULT_SETTINGS.maxAgentPromptBytes),
  shellOutputMaxBytes: z.number().step(1).min(1).default(DEFAULT_SETTINGS.shellOutputMaxBytes),
  maxCommandBytes: z.number().step(1).min(1).default(DEFAULT_SETTINGS.maxCommandBytes),
  maxNotificationBytes: z.number().step(1).min(1).default(DEFAULT_SETTINGS.maxNotificationBytes),
  notificationTimeoutMs: z.number().step(1).min(1).default(DEFAULT_SETTINGS.notificationTimeoutMs),
  schedulerRetryMs: z.number().step(1).min(1).default(DEFAULT_SETTINGS.schedulerRetryMs),
})

/** Project the loader-resolved object into the exact runtime type. */
export function resolveSettings(config: Config): AutoScheduleSettings {
  return { ...DEFAULT_SETTINGS, ...config } as AutoScheduleSettings
}

/** Validate the complete Settings namespace before accepting a write. */
export function assertSettings(value: Config): void {
  const settings = resolveSettings(value)
  if (!validTimeZone(settings.defaultTimeZone)) {
    throw new Error('auto-schedule: defaultTimeZone must be UTC or an IANA Area/Location name')
  }
  if (settings.defaultAgentTimeoutMs > settings.maxAgentTimeoutMs) {
    throw new Error('auto-schedule: defaultAgentTimeoutMs must not exceed maxAgentTimeoutMs')
  }
  const ids = new Set<string>()
  for (const task of settings.tasks) {
    assertTask(task)
    if (ids.has(task.id)) throw new Error(`auto-schedule: duplicate task id ${JSON.stringify(task.id)}`)
    ids.add(task.id)
  }
  const runtimeIds = new Set<string>()
  for (const runtime of settings.runtime) {
    assertRuntime(runtime)
    if (runtimeIds.has(runtime.taskId)) {
      throw new Error(`auto-schedule: duplicate runtime task id ${JSON.stringify(runtime.taskId)}`)
    }
    runtimeIds.add(runtime.taskId)
  }
}
