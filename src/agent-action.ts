import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import {
  installModelSelection,
  type Agent,
  type AgentHandle,
  type AgentSetup,
  type ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type TurnEndReason } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-workspace'
import type { RunOutcome, ScheduleAction } from './domain.js'

type AgentAction = Extract<ScheduleAction, { readonly kind: 'agent' }>

/** One scheduled top-level Agent invocation. */
export interface AgentActionRequest {
  readonly taskId: string
  readonly taskName: string
  readonly scheduledAt: string
  readonly action: AgentAction
  readonly timeoutMs: number
  readonly signal: AbortSignal
}

/** Stable facts returned to the scheduler for bounded history persistence. */
export interface AgentActionResult {
  readonly outcome: RunOutcome
  readonly timedOut?: boolean
  readonly error?: string
  readonly agentSessionId?: string
  readonly agentPreset?: string
}

/** Optional Host capability used only by Agent actions. */
export interface AgentActionExecutor {
  execute(request: AgentActionRequest): Promise<AgentActionResult>
}

type AgentWaitResult = 'idle' | 'aborted' | 'timed-out'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** JSON-escaped user-owned instructions delivered as one ordinary Agent turn. */
export function renderAgentTaskFraming(request: Pick<AgentActionRequest, 'taskId' | 'scheduledAt' | 'action'>): string {
  return [
    '[AUTO-SCHEDULE AGENT TASK]',
    'The user created this unattended scheduled task. Execute task_prompt_json as the task instructions, use the session working directory as the current task directory, and report the final result.',
    `scheduled_task_id_json: ${JSON.stringify(request.taskId)}`,
    `occurrence_at: ${request.scheduledAt}`,
    `task_prompt_json: ${JSON.stringify(request.action.prompt)}`,
  ].join('\n')
}

function turnResult(reason: TurnEndReason | undefined): AgentActionResult {
  if (reason === undefined) {
    return { outcome: 'failed', error: 'The scheduled Agent produced no completed turn.' }
  }
  switch (reason.kind) {
    case 'completed':
      return { outcome: 'succeeded' }
    case 'aborted':
      return { outcome: 'aborted', error: 'The scheduled Agent turn was aborted.' }
    case 'blocked':
      return { outcome: 'failed', error: 'The scheduled Agent turn was blocked.' }
    case 'error':
      return { outcome: 'failed', error: `The scheduled Agent failed: ${reason.error.message}` }
    case 'max-tokens':
      return { outcome: 'failed', error: 'The scheduled Agent reached its output-token limit.' }
    case 'interrupted':
      return { outcome: 'failed', error: 'The scheduled Agent turn was interrupted.' }
    default:
      return { outcome: 'failed', error: `The scheduled Agent ended with unsupported status ${JSON.stringify((reason as { kind: unknown }).kind)}.` }
  }
}

/** Attach a fresh scheduled Session when its canonical cwd already belongs to a DSH workspace. */
async function attachToMatchingWorkspace(ctx: Context, agent: Agent): Promise<void> {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return
  const cwd = agent.session.header.cwd
  if (cwd === undefined) return

  let workspace: Awaited<ReturnType<typeof registry.resolveByPath>>
  try {
    workspace = await registry.resolveByPath(cwd)
  } catch (error: unknown) {
    throw new Error(
      `working directory ${JSON.stringify(cwd)} could not be resolved against the DSH workspace registry: ${errorText(error)}`,
      { cause: error },
    )
  }
  if (workspace === undefined) return

  try {
    await workspace.attachSession(agent.id)
  } catch (error: unknown) {
    throw new Error(
      `Session ${JSON.stringify(String(agent.id))} could not attach to existing workspace ${JSON.stringify(workspace.title)}: ${errorText(error)}`,
      { cause: error },
    )
  }
}

async function waitForAgent(
  agent: Agent,
  signal: AbortSignal,
  timeoutMs: number,
  warn: (message: string) => void,
): Promise<AgentWaitResult> {
  if (signal.aborted) return 'aborted'
  const interrupted = Promise.withResolvers<'aborted' | 'timed-out'>()
  let settled = false
  const cancel = (result: 'aborted' | 'timed-out', reason: string): void => {
    if (settled) return
    settled = true
    try {
      agent.cancel({ kind: 'hook', reason })
    } catch (error: unknown) {
      warn(`auto-schedule: could not cancel Agent ${agent.id}: ${errorText(error)}`)
    }
    interrupted.resolve(result)
  }
  const onAbort = (): void => { cancel('aborted', 'scheduled Agent action was cancelled') }
  signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => {
    cancel('timed-out', `scheduled Agent action exceeded ${String(timeoutMs)} ms`)
  }, timeoutMs)
  timer.unref()
  try {
    const result = await Promise.race([
      agent.whenIdle().then(() => 'idle' as const),
      interrupted.promise,
    ])
    settled = true
    if (result !== 'idle') await agent.whenIdle()
    return result
  } finally {
    settled = true
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

/** DSH-native executor: fresh root Agent, durable Session, then cold detach. */
class DshAgentActionExecutor implements AgentActionExecutor {
  constructor(private readonly ctx: Context) {}

  async execute(request: AgentActionRequest): Promise<AgentActionResult> {
    if (request.signal.aborted) {
      return { outcome: 'aborted', error: 'The scheduled Agent action was cancelled before it started.' }
    }
    const agents = this.ctx.get('agents')
    const sessions = this.ctx.get('sessions')
    const defaultModel = this.ctx.get('agentDefaultModel')
    if (agents === undefined || sessions === undefined || defaultModel === undefined) {
      return {
        outcome: 'failed',
        error: 'Agent execution is unavailable: this DSH profile must provide agents, sessions, and agentDefaultModel.',
      }
    }

    let handle: AgentHandle | undefined
    let result: AgentActionResult = { outcome: 'failed', error: 'The scheduled Agent did not start.' }
    try {
      const roster = this.ctx.get('agentPresets')
      if (roster === undefined && request.action.agentPreset !== undefined) {
        return {
          outcome: 'failed',
          error: `Agent preset ${JSON.stringify(request.action.agentPreset)} was requested, but this DSH profile has no Agent preset roster.`,
        }
      }
      const preset = roster === undefined ? undefined : await roster.resolve(request.action.agentPreset)
      const selection = defaultModel.currentSelection()
      const setup: AgentSetup = async (agentCtx) => {
        const selectionRef: ModelSelectionRef = { current: selection, assembled: undefined }
        installModelSelection(agentCtx, selectionRef)
        if (roster !== undefined && preset !== undefined) await roster.mount(agentCtx, preset.id)
      }
      const sessionId = SessionId(`session-${randomUUID()}`)
      handle = await agents.withoutInitiator(() => agents.create({
        sessionId,
        agentOptions: { provider: selection.provider, model: selection.model },
        meta: {
          ...request.action.cwd === undefined ? {} : { cwd: request.action.cwd },
          ...preset === undefined ? {} : { agentPreset: preset.id },
        },
        setup,
        signal: request.signal,
      }))
      try {
        await attachToMatchingWorkspace(this.ctx, handle.agent)
      } catch (error: unknown) {
        result = {
          outcome: 'failed',
          error: `Agent workspace association failed: ${errorText(error)}`,
        }
        return result
      }
      const sessionFacts = {
        agentSessionId: String(handle.agent.id),
        ...preset === undefined ? {} : { agentPreset: preset.id },
      }
      try {
        this.ctx.get('sessionTitle')?.rename(handle.agent.session, request.taskName)
      } catch (error: unknown) {
        this.ctx.logger.warn(`auto-schedule: could not title Agent session ${handle.agent.id}: ${errorText(error)}`)
      }
      if (request.signal.aborted) {
        result = {
          outcome: 'aborted',
          error: 'The scheduled Agent action was cancelled before prompt delivery.',
          ...sessionFacts,
        }
      } else {
        handle.agent.followup(createUserMessage({
          content: [{ type: 'text', text: renderAgentTaskFraming(request) }],
          source: { kind: 'plugin', plugin: 'dsh-b2us-schedule' },
        }))
        const wait = await waitForAgent(
          handle.agent,
          request.signal,
          request.timeoutMs,
          message => { this.ctx.logger.warn(message) },
        )
        if (wait === 'aborted') {
          result = { outcome: 'aborted', error: 'The scheduled Agent action was cancelled.', ...sessionFacts }
        } else if (wait === 'timed-out') {
          result = {
            outcome: 'failed',
            timedOut: true,
            error: `The scheduled Agent exceeded ${String(request.timeoutMs)} ms and was cancelled.`,
            ...sessionFacts,
          }
        } else {
          const end = handle.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
          result = { ...turnResult(end?.data.reason), ...sessionFacts }
        }
      }
      try {
        const persisted = await sessions.flush(handle.agent.session)
        if (!persisted) {
          result = {
            outcome: 'failed',
            error: 'The scheduled Agent finished, but this DSH profile has no Session persistence listener.',
            ...sessionFacts,
          }
        }
      } catch (error: unknown) {
        result = {
          outcome: 'failed',
          error: `The scheduled Agent Session could not be persisted: ${errorText(error)}`,
          ...sessionFacts,
        }
      }
    } catch (error: unknown) {
      result = {
        outcome: request.signal.aborted ? 'aborted' : 'failed',
        error: `Agent execution infrastructure failure: ${errorText(error)}`,
        ...handle === undefined ? {} : { agentSessionId: String(handle.agent.id) },
      }
    } finally {
      if (handle !== undefined) {
        try {
          await handle.dispose()
        } catch (error: unknown) {
          this.ctx.logger.warn(`auto-schedule: Agent session ${handle.agent.id} did not detach cleanly: ${errorText(error)}`)
        }
      }
    }
    return result
  }
}

/** Resolve the optional DSH Agent action capability without making it a plugin load dependency. */
export function createAgentActionExecutor(ctx: Context): AgentActionExecutor {
  return new DshAgentActionExecutor(ctx)
}
