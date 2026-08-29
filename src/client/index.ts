/** Browser half: independent Plugins settings tab over the Host Settings namespace. */
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext, SessionId, SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { AutoScheduleSettings } from '../domain.js'
import { AutoScheduleSettingsPage, type AutoScheduleSettingsPageInjected } from './AutoScheduleSettingsPage.js'
import { en, zh, type AutoScheduleLocaleKey } from './locales.js'
import styles from './styles.css?inline'

export type { AutoScheduleSettingsPageInjected, AutoScheduleSettingsPageProps } from './AutoScheduleSettingsPage.js'
export type { AutoScheduleLocaleKey } from './locales.js'
export { draftFromTask, emptyDraft, taskFromDraft, type TaskDraft } from './task-form.js'

export const NS = 'settings.autoSchedule'
export const inject = ['slots', 'locale', 'settingsScope', 'sessions']

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.autoSchedule': AutoScheduleLocaleKey
  }
}

function installStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  const previous = document.querySelector('style[data-plugin-css="dsh-auto-schedule"]')
  if (previous !== null) return () => {}
  const tag = document.createElement('style')
  tag.dataset.pluginCss = 'dsh-auto-schedule'
  tag.textContent = styles
  document.head.appendChild(tag)
  return () => { tag.remove() }
}

function sourceOf(scope: SettingsScope<AutoScheduleSettings>): HostObservable<ReturnType<typeof scope.getSnapshot>> {
  return {
    getSnapshot: () => scope.getSnapshot(),
    subscribe: listener => scope.subscribe(listener),
  }
}

/** Contribute the localized page without importing any Host or sibling runtime values. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'auto-schedule: dictionaries')
  ctx.effect(installStyles, 'auto-schedule: styles')
  const scope = ctx.settingsScope.bind<AutoScheduleSettings>({ namespace: 'auto-schedule' })
  // The source package compiles Host and Client Cordis augmentations together;
  // narrow the browser `sessions` face back to its navigation-only contract.
  const sessions = ctx.sessions as unknown as { open(id: SessionId): void }
  const source = sourceOf(scope)
  const injected = (): AutoScheduleSettingsPageInjected => ({
    hooks: { scheduleSettings: source },
    saveTasks: tasks => scope.set('tasks', tasks),
    openSession: sessionId => { sessions.open(sessionId as SessionId) },
  })
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'auto-schedule',
    order: 30,
    label: () => t('tab'),
    locale: NS,
    inject: injected,
  }, AutoScheduleSettingsPage))
}
