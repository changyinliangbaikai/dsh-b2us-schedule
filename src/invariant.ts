/** Package-owned invariant companion for dsh-b2us-schedule. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = 'dsh-b2us-schedule'

export const name = 'auto-schedule-invariant'
export const inject = ['invariants']

// No runtime invariant: every durable settings write is schema- and
// owner-validated, while timer recovery and execution transitions are covered
// by deterministic fake-clock composition tests.
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
