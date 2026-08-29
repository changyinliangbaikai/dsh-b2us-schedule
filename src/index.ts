/** Durable conversational and Web-managed task scheduler for DeepSeek Harness. */
import type { Context } from '@deepseek-ai/cordis'
import { Config, type Config as PluginConfig } from './config.js'
import { AutoScheduleService } from './service.js'
import { registerAutoScheduleTools, registerUnattendedApprovalGate } from './tools.js'

export type * from './domain.js'
export type { Config as AutoScheduleConfig } from './config.js'
export type { CreateTaskInput, TaskView, UpdateTaskInput } from './service.js'
export {
  AUTO_SCHEDULE_NAMESPACE,
  DEFAULT_SETTINGS,
  Config,
  assertSettings,
  resolveSettings,
} from './config.js'
export { AutoScheduleRuntime, systemClock } from './scheduler.js'
export {
  createAgentActionExecutor,
  renderAgentTaskFraming,
  type AgentActionExecutor,
  type AgentActionRequest,
  type AgentActionResult,
} from './agent-action.js'
export { AutoScheduleService, TaskNotFoundError } from './service.js'
export {
  registerAutoScheduleTools,
  registerUnattendedApprovalGate,
  requiresAgentApproval,
  requiresShellApproval,
} from './tools.js'

/** Loader-safe Cordis function-plugin name. */
export const name = 'auto-schedule'
/** Services used by the durable namespace, tools, and DSH command executor. */
export const inject = ['settings', 'tools', 'shell']
/** Loader schema exported at the package root. */
export { Config as AutoSchedulePluginConfig }

/** Mount the Host service, scheduler projection, tool set, and approval gate. */
export async function apply(ctx: Context, config: PluginConfig): Promise<void> {
  const service = new AutoScheduleService(ctx, config)
  ctx.effect(() => () => service.dispose(), 'auto-schedule: runtime lifecycle')
  await service.start()
  ctx.effect(() => registerAutoScheduleTools(ctx, service), 'auto-schedule: conversation tools')
  ctx.effect(() => registerUnattendedApprovalGate(ctx, service), 'auto-schedule: unattended action approval gate')
}
