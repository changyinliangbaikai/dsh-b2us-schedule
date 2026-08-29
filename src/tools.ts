import type { Context } from '@deepseek-ai/cordis'
import {
  defineTool,
  type GenericCallView,
  type PreToolDecision,
  type ToolExecution,
} from '@deepseek-ai/dsh-tools'
import type { AutoScheduleTask, ScheduleAction, ScheduleRule } from './domain.js'
import { ScheduleValidationError } from './domain.js'
import {
  AutoScheduleService,
  TaskNotFoundError,
  type CreateTaskInput,
  type UpdateTaskInput,
} from './service.js'
import { renderToolResult as render, runtimeSummary } from './tool-output.js'
import {
  CREATE_PARAMETERS,
  ERROR_SCHEMA,
  TASK_RESULT_SCHEMA,
  TASK_VIEW_SCHEMA,
  UPDATE_PARAMETERS,
} from './tool-schemas.js'

const SCHEDULE_FIELDS = ['schedule_kind', 'cron_expression', 'time_zone', 'after_seconds', 'at', 'every_seconds'] as const
const ACTION_FIELDS = [
  'action_kind', 'command', 'cwd', 'timeout_ms', 'title', 'body', 'prompt', 'agent_preset',
] as const

interface ToolError {
  readonly code: string
  readonly message: string
}

interface TaskSuccess {
  readonly ok: true
  readonly task: AutoScheduleTask
}

interface ErrorResult {
  readonly ok: false
  readonly error: ToolError
}

type TaskResult = TaskSuccess | ErrorResult

type CreateArgs = {
  name: string
  enabled?: boolean
  schedule_kind: 'cron' | 'after' | 'at' | 'every'
  cron_expression?: string
  time_zone?: string
  after_seconds?: number
  at?: string
  every_seconds?: number
  action_kind: 'shell' | 'agent' | 'notification'
  command?: string
  cwd?: string
  timeout_ms?: number
  title?: string
  body?: string
  prompt?: string
  agent_preset?: string
}

type UpdateArgs = Omit<Partial<CreateArgs>, 'name'> & { id: string; name?: string }

function present(title: string, kind: 'read' | 'other', rawInput?: unknown): GenericCallView {
  return { card: 'generic', title, kind, ...rawInput === undefined ? {} : { rawInput } }
}

function fail(error: unknown): ErrorResult {
  if (error instanceof TaskNotFoundError || error instanceof ScheduleValidationError) {
    return { ok: false, error: { code: error.code, message: error.message } }
  }
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return { ok: false, error: { code: error.code, message: error.message } }
  }
  return { ok: false, error: { code: 'internal_error', message: 'The schedule operation failed.' } }
}

function rejectIrrelevant(args: Record<string, unknown>, allowed: readonly string[], fields: readonly string[]): void {
  const unexpected = fields.find(field => args[field] !== undefined && !allowed.includes(field))
  if (unexpected !== undefined) {
    throw new ScheduleValidationError('invalid_selector', `${unexpected} does not apply to the selected kind.`)
  }
}

function scheduleFromArgs(args: CreateArgs | UpdateArgs, current?: ScheduleRule): ScheduleRule | undefined {
  const hasFields = SCHEDULE_FIELDS.some(field => args[field as keyof typeof args] !== undefined)
  if (!hasFields) return undefined
  const kind = args.schedule_kind ?? current?.kind
  if (kind === undefined) throw new ScheduleValidationError('invalid_selector', 'schedule_kind is required.')
  switch (kind) {
    case 'cron': {
      rejectIrrelevant(args as Record<string, unknown>, ['schedule_kind', 'cron_expression', 'time_zone'], SCHEDULE_FIELDS)
      const prior = current?.kind === 'cron' ? current : undefined
      const expression = args.cron_expression ?? prior?.expression
      if (expression === undefined) throw new ScheduleValidationError('invalid_selector', 'cron_expression is required.')
      return { kind, expression, timeZone: args.time_zone ?? prior?.timeZone ?? '' }
    }
    case 'after': {
      rejectIrrelevant(args as Record<string, unknown>, ['schedule_kind', 'after_seconds'], SCHEDULE_FIELDS)
      const seconds = args.after_seconds ?? (current?.kind === 'after' ? current.afterSeconds : undefined)
      if (seconds === undefined) throw new ScheduleValidationError('invalid_selector', 'after_seconds is required.')
      return { kind, afterSeconds: seconds }
    }
    case 'at': {
      rejectIrrelevant(args as Record<string, unknown>, ['schedule_kind', 'at'], SCHEDULE_FIELDS)
      const at = args.at ?? (current?.kind === 'at' ? current.at : undefined)
      if (at === undefined) throw new ScheduleValidationError('invalid_selector', 'at is required.')
      return { kind, at }
    }
    case 'every': {
      rejectIrrelevant(args as Record<string, unknown>, ['schedule_kind', 'every_seconds'], SCHEDULE_FIELDS)
      const seconds = args.every_seconds ?? (current?.kind === 'every' ? current.everySeconds : undefined)
      if (seconds === undefined) throw new ScheduleValidationError('invalid_selector', 'every_seconds is required.')
      return { kind, everySeconds: seconds }
    }
  }
}

function actionFromArgs(
  args: CreateArgs | UpdateArgs,
  current?: ScheduleAction,
  contextualCwd?: string,
): ScheduleAction | undefined {
  const hasFields = ACTION_FIELDS.some(field => args[field as keyof typeof args] !== undefined)
  if (!hasFields) return undefined
  const kind = args.action_kind ?? current?.kind
  if (kind === undefined) throw new ScheduleValidationError('invalid_selector', 'action_kind is required.')
  if (kind === 'shell') {
    rejectIrrelevant(args as Record<string, unknown>, ['action_kind', 'command', 'cwd', 'timeout_ms'], ACTION_FIELDS)
    const prior = current?.kind === 'shell' ? current : undefined
    const command = args.command ?? prior?.command
    if (command === undefined) throw new ScheduleValidationError('invalid_selector', 'command is required.')
    const cwd = args.cwd ?? prior?.cwd
    const timeoutMs = args.timeout_ms ?? prior?.timeoutMs
    return {
      kind,
      command,
      ...(cwd === undefined ? {} : { cwd }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    }
  }
  if (kind === 'agent') {
    rejectIrrelevant(
      args as Record<string, unknown>,
      ['action_kind', 'prompt', 'cwd', 'agent_preset', 'timeout_ms'],
      ACTION_FIELDS,
    )
    const prior = current?.kind === 'agent' ? current : undefined
    const prompt = args.prompt ?? prior?.prompt
    if (prompt === undefined) throw new ScheduleValidationError('invalid_selector', 'prompt is required.')
    const cwd = args.cwd ?? prior?.cwd ?? contextualCwd
    const agentPreset = args.agent_preset ?? prior?.agentPreset
    const timeoutMs = args.timeout_ms ?? prior?.timeoutMs
    return {
      kind,
      prompt,
      ...(cwd === undefined ? {} : { cwd }),
      ...(agentPreset === undefined ? {} : { agentPreset }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    }
  }
  rejectIrrelevant(args as Record<string, unknown>, ['action_kind', 'title', 'body'], ACTION_FIELDS)
  const prior = current?.kind === 'notification' ? current : undefined
  const title = args.title ?? prior?.title
  const body = args.body ?? prior?.body
  if (title === undefined || body === undefined) {
    throw new ScheduleValidationError('invalid_selector', 'title and body are required.')
  }
  return { kind, title, body }
}

function createInput(args: CreateArgs, contextualCwd?: string): CreateTaskInput {
  const schedule = scheduleFromArgs(args)
  const action = actionFromArgs(args, undefined, contextualCwd)
  if (schedule === undefined || action === undefined) {
    throw new ScheduleValidationError('invalid_selector', 'A schedule and an action are required.')
  }
  return { name: args.name, ...args.enabled === undefined ? {} : { enabled: args.enabled }, schedule, action }
}

function updateInput(args: UpdateArgs, service: AutoScheduleService, contextualCwd?: string): UpdateTaskInput {
  const current = service.list().find(view => view.task.id === args.id)?.task
  if (current === undefined) throw new TaskNotFoundError(args.id)
  const schedule = scheduleFromArgs(args, current.schedule)
  const action = actionFromArgs(args, current.action, contextualCwd)
  return {
    id: args.id,
    ...args.name === undefined ? {} : { name: args.name },
    ...args.enabled === undefined ? {} : { enabled: args.enabled },
    ...schedule === undefined ? {} : { schedule },
    ...action === undefined ? {} : { action },
  }
}

function requiresActionApproval(
  exec: Pick<ToolExecution, 'name' | 'arguments'>,
  service: AutoScheduleService,
  kind: 'shell' | 'agent',
): boolean {
  if (exec.name === 'auto_schedule_create') {
    const args = exec.arguments as Partial<CreateArgs>
    return args.action_kind === kind && args.enabled !== false
  }
  if (exec.name !== 'auto_schedule_update') return false
  const args = exec.arguments as Partial<UpdateArgs>
  if (typeof args.id !== 'string') return false
  const current = service.list().find(view => view.task.id === args.id)?.task
  if (current === undefined) return false
  const resultingEnabled = args.enabled ?? current.enabled
  const resultingKind = args.action_kind ?? current.action.kind
  if (!resultingEnabled || resultingKind !== kind) return false
  return args.enabled === true
    || SCHEDULE_FIELDS.some(field => args[field as keyof typeof args] !== undefined)
    || ACTION_FIELDS.some(field => args[field as keyof typeof args] !== undefined)
}

/** Whether a model-requested CRUD call changes an enabled unattended Shell task. */
export function requiresShellApproval(
  exec: Pick<ToolExecution, 'name' | 'arguments'>,
  service: AutoScheduleService,
): boolean {
  return requiresActionApproval(exec, service, 'shell')
}

/** Whether a model-requested CRUD call changes an enabled unattended Agent task. */
export function requiresAgentApproval(
  exec: Pick<ToolExecution, 'name' | 'arguments'>,
  service: AutoScheduleService,
): boolean {
  return requiresActionApproval(exec, service, 'agent')
}

/** Install the standard DSH approval decision for unattended Shell and Agent mutations. */
export function registerUnattendedApprovalGate(ctx: Context, service: AutoScheduleService): () => void {
  return ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const decision = await next()
    if (decision.kind !== 'allow') return decision
    if (requiresAgentApproval(exec, service)) {
      return {
        kind: 'ask',
        reason: 'This will authorize an unattended scheduled main-Agent turn. It may use the selected preset tools and model, but receives no automatic permission escalation or approval bypass.',
      }
    }
    if (!requiresShellApproval(exec, service)) return decision
    return {
      kind: 'ask',
      reason: 'This will authorize an unattended scheduled command. Future runs remain confined by the active DSH shell sandbox and never auto-escalate.',
    }
  })
}

/** Register the five global conversation management tools as one effect. */
export function registerAutoScheduleTools(ctx: Context, service: AutoScheduleService): () => void {
  const disposers: Array<() => void> = []
  try {
    disposers.push(ctx.tools.register(defineTool({
      name: 'auto_schedule_create',
      description: 'Create a durable scheduled task. Select exactly one schedule and one shell, Agent, or notification action. Enabled Shell and Agent actions require standard DSH approval before storage. Agent actions create a fresh top-level DSH Session, run the prompt with the selected preset, persist it, and record its Session id.',
      parameters: CREATE_PARAMETERS,
      output: { schema: TASK_RESULT_SCHEMA, render },
      async execute(args, exec): Promise<TaskResult> {
        if (exec.signal.aborted) return { ok: false, error: { code: 'cancelled', message: 'The create request was cancelled.' } }
        try {
          const view = await service.create(createInput(args as CreateArgs, exec.agent?.session.header.cwd))
          return { ok: true, task: view.task }
        } catch (error: unknown) {
          return fail(error)
        }
      },
      presentCall: args => present('Create scheduled task', 'other', args.name),
    })))

    disposers.push(ctx.tools.register(defineTool({
      name: 'auto_schedule_update',
      description: 'Modify a durable scheduled task by exact id. Omitted fields are preserved. Changing or enabling an active Shell or Agent task requires standard DSH approval.',
      parameters: UPDATE_PARAMETERS,
      output: { schema: TASK_RESULT_SCHEMA, render },
      async execute(args, exec): Promise<TaskResult> {
        if (exec.signal.aborted) return { ok: false, error: { code: 'cancelled', message: 'The update request was cancelled.' } }
        try {
          const view = await service.update(updateInput(args as UpdateArgs, service, exec.agent?.session.header.cwd))
          return { ok: true, task: view.task }
        } catch (error: unknown) {
          return fail(error)
        }
      },
      presentCall: args => present('Update scheduled task', 'other', args.id),
    })))

    disposers.push(ctx.tools.register(defineTool({
      name: 'auto_schedule_list',
      description: 'List all durable scheduled tasks with compact next-run, last-run, and retained-history-count projections. Use auto_schedule_history to read execution records and output.',
      parameters: {},
      output: {
        schema: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                ok: { type: 'boolean', required: true, const: true },
                tasks: { type: 'array', required: true, items: TASK_VIEW_SCHEMA },
              },
            },
            ERROR_SCHEMA,
          ],
        },
        render,
      },
      async execute(_args, exec) {
        if (exec.signal.aborted) return { ok: false as const, error: { code: 'cancelled', message: 'The list request was cancelled.' } }
        return {
          ok: true as const,
          tasks: service.list().map(view => view.runtime === undefined
            ? { task: view.task }
            : { task: view.task, runtime: JSON.parse(JSON.stringify(runtimeSummary(view.runtime))) }),
        }
      },
      isConcurrencySafe: () => true,
      presentCall: () => present('List scheduled tasks', 'read'),
    })))

    disposers.push(ctx.tools.register(defineTool({
      name: 'auto_schedule_history',
      description: 'Read newest-first persisted execution history for one scheduled task by exact id. The optional limit is capped by the Host retention policy.',
      parameters: {
        id: { type: 'string', required: true, description: 'Exact task id returned by create or list.' },
        limit: { type: 'integer', description: 'Optional positive maximum number of newest records to return.' },
      },
      output: {
        schema: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                ok: { type: 'boolean', required: true, const: true },
                id: { type: 'string', required: true },
                history: { type: 'array', required: true, items: { type: 'json' } },
              },
            },
            ERROR_SCHEMA,
          ],
        },
        render,
      },
      async execute(args, exec) {
        if (exec.signal.aborted) return { ok: false as const, error: { code: 'cancelled', message: 'The history request was cancelled.' } }
        try {
          return {
            ok: true as const,
            id: args.id,
            history: JSON.parse(JSON.stringify(service.history(args.id, args.limit))),
          }
        } catch (error: unknown) {
          return fail(error)
        }
      },
      isConcurrencySafe: () => true,
      presentCall: args => present('Read scheduled task history', 'read', args.id),
    })))

    disposers.push(ctx.tools.register(defineTool({
      name: 'auto_schedule_delete',
      description: 'Delete one durable scheduled task by its exact id. Deleting a running task aborts its active Shell or Agent execution.',
      parameters: { id: { type: 'string', required: true } },
      output: {
        schema: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                ok: { type: 'boolean', required: true, const: true },
                id: { type: 'string', required: true },
                deleted: { type: 'boolean', required: true },
              },
            },
            ERROR_SCHEMA,
          ],
        },
        render,
      },
      async execute(args, exec) {
        if (exec.signal.aborted) return { ok: false, error: { code: 'cancelled', message: 'The delete request was cancelled.' } }
        try {
          return { ok: true, id: args.id, deleted: await service.delete(args.id) }
        } catch (error: unknown) {
          return fail(error)
        }
      },
      presentCall: args => present('Delete scheduled task', 'other', args.id),
    })))
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }
  let active = true
  return () => {
    if (!active) return
    active = false
    for (const dispose of disposers.reverse()) dispose()
  }
}
