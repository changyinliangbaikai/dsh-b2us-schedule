import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import type { SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {
  HostObservable,
  InjectFace,
  PropsLocale,
  PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {
  AutoScheduleSettings,
  AutoScheduleTask,
  RuntimeState,
  TaskRuntime,
} from '../domain.js'
import { runtimeHistory } from '../history.js'
import { draftFromTask, emptyDraft, taskFromDraft, type TaskDraft } from './task-form.js'
import { RunHistory } from './RunHistory.js'

export interface AutoScheduleSettingsPageInjected {
  readonly hooks: {
    readonly scheduleSettings: HostObservable<SettingsScopeSnapshot<AutoScheduleSettings>>
  }
  readonly saveTasks: (tasks: readonly AutoScheduleTask[]) => Promise<void>
  readonly openSession: (sessionId: string) => void
}

export type AutoScheduleSettingsPageProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.autoSchedule'>
  & InjectFace<AutoScheduleSettingsPageInjected>

const STATUS_KEYS: Record<RuntimeState, Parameters<AutoScheduleSettingsPageProps['t']>[0]> = {
  scheduled: 'statusScheduled',
  running: 'statusRunning',
  succeeded: 'statusSucceeded',
  failed: 'statusFailed',
  completed: 'statusCompleted',
  disabled: 'statusDisabled',
  blocked: 'statusBlocked',
}

function displayDate(value: string): string {
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })
}

function scheduleLabel(task: AutoScheduleTask, t: AutoScheduleSettingsPageProps['t']): string {
  switch (task.schedule.kind) {
    case 'cron': return t('scheduleCron', { expression: task.schedule.expression, timeZone: task.schedule.timeZone })
    case 'after': return t('scheduleAfter', { seconds: task.schedule.afterSeconds })
    case 'at': return t('scheduleAt', { time: displayDate(task.schedule.at) })
    case 'every': return t('scheduleEvery', { seconds: task.schedule.everySeconds })
  }
}

function TaskForm(props: {
  readonly draft: TaskDraft
  readonly update: (patch: Partial<TaskDraft>) => void
  readonly submit: (event: FormEvent<HTMLFormElement>) => void
  readonly cancel: () => void
  readonly busy: boolean
  readonly t: AutoScheduleSettingsPageProps['t']
}): ReactNode {
  const { draft, update, submit, cancel, busy, t } = props
  return (
    <form className="das-form" onSubmit={submit}>
      <div className="das-form-grid">
        <label className="das-field das-span-2">
          <span>{t('name')}</span>
          <input value={draft.name} onChange={event => { update({ name: event.currentTarget.value }) }} autoFocus />
        </label>
        <label className="das-toggle das-span-2">
          <input type="checkbox" checked={draft.enabled} onChange={event => { update({ enabled: event.currentTarget.checked }) }} />
          <span>{t('enabled')}</span>
        </label>
        <label className="das-field">
          <span>{t('scheduleType')}</span>
          <select value={draft.scheduleKind} onChange={event => { update({ scheduleKind: event.currentTarget.value as TaskDraft['scheduleKind'] }) }}>
            <option value="cron">{t('cron')}</option>
            <option value="after">{t('after')}</option>
            <option value="at">{t('at')}</option>
            <option value="every">{t('every')}</option>
          </select>
        </label>
        {draft.scheduleKind === 'cron' ? (
          <>
            <label className="das-field">
              <span>{t('cronExpression')}</span>
              <input value={draft.cronExpression} onChange={event => { update({ cronExpression: event.currentTarget.value }) }} placeholder="0 9 * * *" />
            </label>
            <label className="das-field das-span-2">
              <span>{t('timeZone')}</span>
              <input value={draft.timeZone} onChange={event => { update({ timeZone: event.currentTarget.value }) }} placeholder="Asia/Shanghai" />
              <small>{t('cronHint')}</small>
            </label>
          </>
        ) : null}
        {draft.scheduleKind === 'after' ? (
          <label className="das-field">
            <span>{t('afterSeconds')}</span>
            <input inputMode="numeric" value={draft.afterSeconds} onChange={event => { update({ afterSeconds: event.currentTarget.value }) }} />
          </label>
        ) : null}
        {draft.scheduleKind === 'at' ? (
          <label className="das-field">
            <span>{t('atTime')}</span>
            <input type="datetime-local" step="1" value={draft.atLocal} onChange={event => { update({ atLocal: event.currentTarget.value }) }} />
          </label>
        ) : null}
        {draft.scheduleKind === 'every' ? (
          <label className="das-field">
            <span>{t('everySeconds')}</span>
            <input inputMode="numeric" value={draft.everySeconds} onChange={event => { update({ everySeconds: event.currentTarget.value }) }} />
          </label>
        ) : null}
        <label className="das-field">
          <span>{t('actionType')}</span>
          <select value={draft.actionKind} onChange={event => { update({ actionKind: event.currentTarget.value as TaskDraft['actionKind'] }) }}>
            <option value="shell">{t('shell')}</option>
            <option value="agent">{t('agent')}</option>
            <option value="notification">{t('notification')}</option>
          </select>
        </label>
        {draft.actionKind === 'shell' ? (
          <>
            <label className="das-field das-span-2">
              <span>{t('command')}</span>
              <textarea rows={3} value={draft.command} onChange={event => { update({ command: event.currentTarget.value }) }} placeholder="./scripts/backup.sh" />
              <small>{t('shellHint')}</small>
            </label>
            <label className="das-field">
              <span>{t('cwd')}</span>
              <input value={draft.cwd} onChange={event => { update({ cwd: event.currentTarget.value }) }} />
            </label>
            <label className="das-field">
              <span>{t('timeout')}</span>
              <input inputMode="numeric" value={draft.timeoutMs} onChange={event => { update({ timeoutMs: event.currentTarget.value }) }} />
            </label>
          </>
        ) : null}
        {draft.actionKind === 'agent' ? (
          <>
            <label className="das-field das-span-2">
              <span>{t('agentPrompt')}</span>
              <textarea aria-label={t('agentPrompt')} rows={8} value={draft.prompt} onChange={event => { update({ prompt: event.currentTarget.value }) }} />
              <small>{t('agentHint')}</small>
            </label>
            <label className="das-field">
              <span>{t('cwd')}</span>
              <input value={draft.cwd} onChange={event => { update({ cwd: event.currentTarget.value }) }} />
            </label>
            <label className="das-field">
              <span>{t('agentPreset')}</span>
              <input value={draft.agentPreset} onChange={event => { update({ agentPreset: event.currentTarget.value }) }} />
            </label>
            <label className="das-field">
              <span>{t('timeout')}</span>
              <input inputMode="numeric" value={draft.timeoutMs} onChange={event => { update({ timeoutMs: event.currentTarget.value }) }} />
            </label>
          </>
        ) : null}
        {draft.actionKind === 'notification' ? (
          <>
            <label className="das-field">
              <span>{t('notificationTitle')}</span>
              <input value={draft.title} onChange={event => { update({ title: event.currentTarget.value }) }} />
            </label>
            <label className="das-field das-span-2">
              <span>{t('notificationBody')}</span>
              <textarea rows={3} value={draft.body} onChange={event => { update({ body: event.currentTarget.value }) }} />
            </label>
          </>
        ) : null}
      </div>
      <div className="das-form-actions">
        <button className="das-button das-button-secondary" type="button" onClick={cancel} disabled={busy}>{t('cancel')}</button>
        <button className="das-button das-button-primary" type="submit" disabled={busy}>{t('save')}</button>
      </div>
    </form>
  )
}

function TaskCard(props: {
  readonly task: AutoScheduleTask
  readonly runtime?: TaskRuntime
  readonly edit: () => void
  readonly remove: () => void
  readonly toggle: () => void
  readonly busy: boolean
  readonly writable: boolean
  readonly openSession: (sessionId: string) => void
  readonly t: AutoScheduleSettingsPageProps['t']
}): ReactNode {
  const { task, runtime, edit, remove, toggle, busy, writable, openSession, t } = props
  const state: RuntimeState = runtime?.state ?? (task.enabled ? 'scheduled' : 'disabled')
  const history = runtime === undefined ? [] : runtimeHistory(runtime)
  return (
    <li className="das-task" data-state={state}>
      <div className="das-task-main">
        <label className="das-switch" title={t('enabled')}>
          <input
            type="checkbox"
            aria-label={t('enabled')}
            checked={task.enabled}
            onChange={toggle}
            disabled={!writable || busy}
          />
          <span aria-hidden="true" />
        </label>
        <div className="das-task-copy">
          <div className="das-task-title-row">
            <strong>{task.name}</strong>
            <span className="das-badge" data-action={task.action.kind}>{t(task.action.kind)}</span>
            <span className="das-status" data-state={state}>{t(STATUS_KEYS[state])}</span>
          </div>
          <p>{scheduleLabel(task, t)}</p>
          <div className="das-runtime-grid">
            <span><b>{t('nextRun')}</b>{runtime?.nextRunAt === null || runtime?.nextRunAt === undefined ? t('noNextRun') : displayDate(runtime.nextRunAt)}</span>
            <span><b>{t('lastRun')}</b>{runtime?.lastRun === undefined ? t('neverRun') : displayDate(runtime.lastRun.finishedAt)}</span>
          </div>
          {runtime?.message !== undefined ? <p className="das-runtime-message">{runtime.message}</p> : null}
          <RunHistory history={history} openSession={openSession} t={t} />
        </div>
      </div>
      <div className="das-task-actions">
        <button type="button" onClick={edit} disabled={!writable || busy}>{t('edit')}</button>
        <button type="button" className="das-danger" onClick={remove} disabled={!writable || busy}>{t('remove')}</button>
      </div>
    </li>
  )
}

/** Independent Settings > Plugins tab for direct scheduled-task management. */
export function AutoScheduleSettingsPage({
  useScheduleSettings,
  saveTasks,
  openSession,
  t,
}: AutoScheduleSettingsPageProps): ReactNode {
  const snapshot = useScheduleSettings(value => value)
  const settings = snapshot.value
  const [draft, setDraft] = useState<TaskDraft | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const runtime = useMemo(
    () => new Map(settings?.runtime.map(row => [row.taskId, row]) ?? []),
    [settings?.runtime],
  )

  if (snapshot.status === 'loading') return <p className="das-status-page">{t('loading')}</p>
  if (snapshot.status === 'unavailable' || settings === undefined) {
    return <p className="das-status-page" role="alert">{t('unavailable')}</p>
  }

  const beginCreate = (): void => {
    setEditingId(null)
    setDraft(emptyDraft(settings))
    setNotice(null)
  }
  const beginEdit = (task: AutoScheduleTask): void => {
    setEditingId(task.id)
    setDraft(draftFromTask(task, settings))
    setNotice(null)
  }
  const closeForm = (): void => {
    setEditingId(null)
    setDraft(null)
  }
  const commit = async (tasks: readonly AutoScheduleTask[], success: string): Promise<void> => {
    setBusy(true)
    setNotice(null)
    try {
      await saveTasks(tasks)
      setNotice({ kind: 'ok', text: success })
    } catch {
      setNotice({ kind: 'error', text: t('saveFailed') })
      throw new Error('save failed')
    } finally {
      setBusy(false)
    }
  }
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (draft === null) return
    const current = editingId === null ? undefined : settings.tasks.find(task => task.id === editingId)
    const result = taskFromDraft(draft, settings, current)
    if (!result.ok) {
      setNotice({ kind: 'error', text: t(result.issue, result.params) })
      return
    }
    const unattendedChanged = result.task.enabled
      && (result.task.action.kind === 'shell' || result.task.action.kind === 'agent')
      && (current === undefined || result.task.executionRevision !== current.executionRevision)
    if (unattendedChanged) {
      const confirmKey = result.task.action.kind === 'agent' ? 'agentConfirm' : 'shellConfirm'
      if (!window.confirm(t(confirmKey))) return
    }
    const tasks = current === undefined
      ? [...settings.tasks, result.task]
      : settings.tasks.map(task => task.id === current.id ? result.task : task)
    void commit(tasks, t('saved')).then(closeForm).catch(() => {})
  }
  const toggle = (task: AutoScheduleTask): void => {
    if (!task.enabled && (task.action.kind === 'shell' || task.action.kind === 'agent')) {
      const confirmKey = task.action.kind === 'agent' ? 'agentConfirm' : 'shellConfirm'
      if (!window.confirm(t(confirmKey))) return
    }
    const next: AutoScheduleTask = {
      ...task,
      enabled: !task.enabled,
      revision: task.revision + 1,
      executionRevision: task.executionRevision + 1,
      updatedAt: new Date().toISOString(),
    }
    void commit(settings.tasks.map(row => row.id === task.id ? next : row), t('saved')).catch(() => {})
  }
  const remove = (task: AutoScheduleTask): void => {
    if (!window.confirm(t('deleteConfirm'))) return
    void commit(settings.tasks.filter(row => row.id !== task.id), t('removed')).then(() => {
      if (editingId === task.id) closeForm()
    }).catch(() => {})
  }

  const enabledCount = settings.tasks.filter(task => task.enabled).length
  const nextCount = settings.runtime.filter(row => row.nextRunAt !== null).length
  return (
    <section className="das-page">
      <header className="das-header">
        <div>
          <h2>{t('title')}</h2>
          <p>{t('subtitle')}</p>
        </div>
        <button className="das-button das-button-primary" type="button" onClick={beginCreate} disabled={!snapshot.writable || busy}>{t('add')}</button>
      </header>
      <div className="das-summary">
        <span><b>{settings.tasks.length}</b>{t('total')}</span>
        <span><b>{enabledCount}</b>{t('enabledCount')}</span>
        <span><b>{nextCount}</b>{t('nextCount')}</span>
      </div>
      <p className="das-sandbox-note">{t('sandboxNote')}</p>
      {!snapshot.writable ? <p className="das-alert" role="alert">{t('readOnly')}</p> : null}
      {notice !== null ? <p className="das-notice" data-kind={notice.kind} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}</p> : null}
      {draft !== null ? (
        <TaskForm
          draft={draft}
          update={patch => { setDraft(value => value === null ? null : { ...value, ...patch }) }}
          submit={submit}
          cancel={closeForm}
          busy={busy}
          t={t}
        />
      ) : null}
      {settings.tasks.length === 0 && draft === null ? (
        <div className="das-empty">
          <div aria-hidden="true">◷</div>
          <h3>{t('emptyTitle')}</h3>
          <p>{t('emptyBody')}</p>
        </div>
      ) : (
        <ul className="das-tasks">
          {settings.tasks.map((task) => {
            const taskRuntime = runtime.get(task.id)
            return (
              <TaskCard
                key={task.id}
                task={task}
                {...taskRuntime === undefined ? {} : { runtime: taskRuntime }}
                edit={() => { beginEdit(task) }}
                remove={() => { remove(task) }}
                toggle={() => { toggle(task) }}
                busy={busy}
                writable={snapshot.writable}
                openSession={openSession}
                t={t}
              />
            )
          })}
        </ul>
      )}
    </section>
  )
}
