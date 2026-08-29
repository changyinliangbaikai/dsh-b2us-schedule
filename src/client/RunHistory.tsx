import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { LastRun, RunOutcome } from '../domain.js'

type HistoryTranslate = PropsLocale<'settings.autoSchedule'>['t']

const OUTCOME_KEYS: Record<RunOutcome, Parameters<HistoryTranslate>[0]> = {
  succeeded: 'statusSucceeded',
  failed: 'statusFailed',
  aborted: 'statusAborted',
}

function displayDate(value: string): string {
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })
}

function durationMs(run: LastRun): number {
  return Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt))
}

/** Newest-first, bounded execution history for one task. */
export function RunHistory(props: {
  readonly history: readonly LastRun[]
  readonly openSession: (sessionId: string) => void
  readonly t: HistoryTranslate
}): ReactNode {
  const { history, openSession, t } = props
  if (history.length === 0) return null
  return (
    <details className="das-history">
      <summary>{t('historySummary', { count: history.length })}</summary>
      <ol className="das-history-list">
        {history.map(run => (
          <li key={`${run.scheduledAt}:${run.startedAt}:${run.finishedAt}`}>
            <details className="das-history-run">
              <summary>
                <span className="das-history-outcome" data-outcome={run.outcome}>{t(OUTCOME_KEYS[run.outcome])}</span>
                <time dateTime={run.finishedAt}>{displayDate(run.finishedAt)}</time>
              </summary>
              <div className="das-history-body">
                <dl className="das-history-meta">
                  <div><dt>{t('historyScheduled')}</dt><dd>{displayDate(run.scheduledAt)}</dd></div>
                  <div><dt>{t('historyStarted')}</dt><dd>{displayDate(run.startedAt)}</dd></div>
                  <div><dt>{t('historyDuration')}</dt><dd>{t('historyDurationMs', { milliseconds: durationMs(run) })}</dd></div>
                  {run.exitCode === undefined ? null : (
                    <div><dt>{t('historyExitCode')}</dt><dd>{run.exitCode === null ? t('none') : String(run.exitCode)}</dd></div>
                  )}
                  {run.agentPreset === undefined ? null : (
                    <div><dt>{t('agentPreset')}</dt><dd>{run.agentPreset}</dd></div>
                  )}
                </dl>
                {run.agentSessionId === undefined ? null : (
                  <div className="das-history-session">
                    <span>{t('agentSession')}: <code>{run.agentSessionId}</code></span>
                    <button type="button" onClick={() => { openSession(run.agentSessionId as string) }}>
                      {t('openAgentSession')}
                    </button>
                  </div>
                )}
                {run.error === undefined ? null : <p className="das-history-error">{run.error}</p>}
                {run.stdout === undefined && run.stderr === undefined ? null : (
                  <div className="das-run-output">
                    {run.stdout === undefined ? null : <section><b>{t('stdout')}</b><pre>{run.stdout}</pre></section>}
                    {run.stderr === undefined ? null : <section><b>{t('stderr')}</b><pre>{run.stderr}</pre></section>}
                  </div>
                )}
              </div>
            </details>
          </li>
        ))}
      </ol>
    </details>
  )
}
