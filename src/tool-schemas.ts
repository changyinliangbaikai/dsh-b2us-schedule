const SCHEDULE_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true, const: 'cron' },
        expression: { type: 'string', required: true },
        timeZone: { type: 'string', required: true },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true, const: 'after' },
        afterSeconds: { type: 'integer', required: true },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true, const: 'at' },
        at: { type: 'string', required: true },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true, const: 'every' },
        everySeconds: { type: 'integer', required: true },
      },
    },
  ],
} as const

const ACTION_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true, const: 'agent' },
        prompt: { type: 'string', required: true },
        cwd: { type: 'string' },
        agentPreset: { type: 'string' },
        timeoutMs: { type: 'integer' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true, const: 'shell' },
        command: { type: 'string', required: true },
        cwd: { type: 'string' },
        timeoutMs: { type: 'integer' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true, const: 'notification' },
        title: { type: 'string', required: true },
        body: { type: 'string', required: true },
      },
    },
  ],
} as const

const TASK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    name: { type: 'string', required: true },
    enabled: { type: 'boolean', required: true },
    schedule: { ...SCHEDULE_SCHEMA, required: true },
    action: { ...ACTION_SCHEMA, required: true },
    revision: { type: 'integer', required: true },
    executionRevision: { type: 'integer', required: true },
    createdAt: { type: 'string', required: true },
    updatedAt: { type: 'string', required: true },
  },
} as const

export const ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true, const: false },
    error: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        code: { type: 'string', required: true },
        message: { type: 'string', required: true },
      },
    },
  },
} as const

export const TASK_RESULT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean', required: true, const: true },
        task: { ...TASK_SCHEMA, required: true },
      },
    },
    ERROR_SCHEMA,
  ],
} as const

export const TASK_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    task: { ...TASK_SCHEMA, required: true },
    runtime: { type: 'json' },
  },
} as const

export const CREATE_PARAMETERS = {
  name: { type: 'string', required: true, description: 'Human-readable task name.' },
  enabled: { type: 'boolean', description: 'Whether the task is active immediately. Defaults to true.' },
  schedule_kind: { type: 'string', required: true, enum: ['cron', 'after', 'at', 'every'] },
  cron_expression: { type: 'string', description: 'Cron expression for schedule_kind=cron.' },
  time_zone: { type: 'string', description: 'IANA timezone for cron; plugin default when omitted.' },
  after_seconds: { type: 'integer', description: 'Positive one-shot delay in seconds.' },
  at: { type: 'string', description: 'Future ISO date-time with explicit Z or numeric UTC offset.' },
  every_seconds: { type: 'integer', description: 'Positive fixed interval in seconds.' },
  action_kind: { type: 'string', required: true, enum: ['shell', 'agent', 'notification'] },
  command: { type: 'string', description: 'Shell command or shell-script invocation.' },
  cwd: { type: 'string', description: 'Optional working directory for Shell or Agent actions.' },
  timeout_ms: { type: 'integer', description: 'Optional Shell or Agent timeout; Host policy may cap it.' },
  title: { type: 'string', description: 'System-notification title.' },
  body: { type: 'string', description: 'System-notification body.' },
  prompt: { type: 'string', description: 'Instructions for a fresh top-level DSH Agent Session.' },
  agent_preset: { type: 'string', description: 'Optional Agent preset id; the effective DSH default is used when omitted.' },
} as const

export const UPDATE_PARAMETERS = {
  id: { type: 'string', required: true, description: 'Exact task id returned by create or list.' },
  name: { type: 'string' },
  enabled: { type: 'boolean' },
  schedule_kind: { type: 'string', enum: ['cron', 'after', 'at', 'every'] },
  cron_expression: { type: 'string' },
  time_zone: { type: 'string' },
  after_seconds: { type: 'integer' },
  at: { type: 'string' },
  every_seconds: { type: 'integer' },
  action_kind: { type: 'string', enum: ['shell', 'agent', 'notification'] },
  command: { type: 'string' },
  cwd: { type: 'string' },
  timeout_ms: { type: 'integer' },
  title: { type: 'string' },
  body: { type: 'string' },
  prompt: { type: 'string' },
  agent_preset: { type: 'string' },
} as const
