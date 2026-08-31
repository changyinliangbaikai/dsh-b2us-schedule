// @vitest-environment jsdom
import { cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { DEFAULT_SETTINGS } from '../../src/config.js'
import type { AutoScheduleSettings } from '../../src/domain.js'
import { apply, inject, NS } from '../../src/client/index.js'
import { AutoScheduleSettingsPage } from '../../src/client/AutoScheduleSettingsPage.js'

afterEach(() => {
  cleanup()
  document.head.querySelectorAll('style[data-plugin-css="dsh-b2us-schedule"]').forEach(tag => { tag.remove() })
})

class StubScope implements SettingsScope<AutoScheduleSettings> {
  readonly writes: Array<{ field: string; value: unknown }> = []
  private readonly listeners = new Set<() => void>()
  private state: SettingsScopeSnapshot<AutoScheduleSettings> = {
    status: 'ready', value: DEFAULT_SETTINGS, base: {}, user: {}, revision: 0, writable: true, mode: 'host',
  }

  getSnapshot = (): SettingsScopeSnapshot<AutoScheduleSettings> => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  async set(field: string, value: unknown): Promise<void> {
    this.writes.push({ field, value })
  }
  mutate(): Promise<void> {
    return Promise.resolve()
  }
  unset(): Promise<void> {
    return Promise.resolve()
  }
}

type TestEntry = {
  component: unknown
  options: Record<string, unknown>
  locale?: string
  inject?: () => unknown
}

class TestSlots extends Service {
  readonly records: TestEntry[] = []

  constructor(ctx: Context) {
    super(ctx, 'slots')
  }

  inject(_name: string, register: () => () => void): void {
    this.ctx.effect(register, 'test slot injection')
  }

  register(options: Record<string, unknown>, component: unknown): () => void {
    const entry: TestEntry = {
      component,
      options,
      ...(typeof options.locale === 'string' ? { locale: options.locale } : {}),
      ...(typeof options.inject === 'function' ? { inject: options.inject as () => unknown } : {}),
    }
    this.records.push(entry)
    return () => { this.records.splice(this.records.indexOf(entry), 1) }
  }
}

async function bench() {
  const ctx = new Context()
  const dictionaries = new Map<string, Record<string, string>>()
  const locale = {
    register(namespace: string, dictionary: { zh: Record<string, string> }) {
      dictionaries.set(namespace, dictionary.zh)
      return () => { dictionaries.delete(namespace) }
    },
    bind(namespace: string) {
      return (key: string) => dictionaries.get(namespace)?.[key] ?? key
    },
  }
  const slots = new TestSlots(ctx)
  ctx.provide('locale', locale as never)
  const scope = new StubScope()
  ctx.provide('settingsScope', { bind: () => scope } as never)
  const openSession = vi.fn()
  ctx.provide('sessions', { open: openSession } as never)
  return { ctx, locale, openSession, scope, slots }
}

describe('browser plugin apply', () => {
  it('registers a localized independent tab, styles, settings action, and disposal', async () => {
    const test = await bench()
    expect(inject).toEqual(['slots', 'locale', 'settingsScope', 'sessions'])
    const fiber = test.ctx.plugin({ inject: [...inject], apply })
    await fiber
    const entry = test.slots.records[0]!
    expect(entry.component).toBe(AutoScheduleSettingsPage)
    expect(entry.options).toMatchObject({ id: 'auto-schedule', order: 30 })
    expect(entry.locale).toBe(NS)
    expect((entry.options.label as () => string)()).toBe('定时任务')
    expect(document.head.querySelector('style[data-plugin-css="dsh-b2us-schedule"]')).not.toBeNull()
    const injected = (entry.inject as () => {
      saveTasks(tasks: readonly AutoScheduleTask[]): Promise<void>
      openSession(id: string): void
    })()
    await injected.saveTasks([])
    expect(test.scope.writes).toEqual([{ field: 'tasks', value: [] }])
    injected.openSession('session-test')
    expect(test.openSession).toHaveBeenCalledWith('session-test')

    await fiber.dispose()
    expect(test.slots.records).toHaveLength(0)
    expect(document.head.querySelector('style[data-plugin-css="dsh-b2us-schedule"]')).toBeNull()
    await test.ctx.fiber.dispose()
  })
})

type AutoScheduleTask = import('../../src/domain.js').AutoScheduleTask
