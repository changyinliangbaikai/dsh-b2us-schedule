// @vitest-environment jsdom
import { useState, type ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { DEFAULT_SETTINGS } from '../../src/config.js'
import type { AutoScheduleSettings, AutoScheduleTask } from '../../src/domain.js'
import {
  AutoScheduleSettingsPage,
  type AutoScheduleSettingsPageProps,
} from '../../src/client/AutoScheduleSettingsPage.js'
import { zh, type AutoScheduleLocaleKey } from '../../src/client/locales.js'

afterEach(cleanup)

function translate(key: AutoScheduleLocaleKey, params: Record<string, unknown> = {}): string {
  let text: string = zh[key]
  for (const [name, value] of Object.entries(params)) {
    text = text.replaceAll(`{${name}}`, String(value))
  }
  return text
}

function snapshot(value: AutoScheduleSettings): SettingsScopeSnapshot<AutoScheduleSettings> {
  return {
    status: 'ready',
    value,
    base: {},
    user: {},
    revision: 1,
    writable: true,
    mode: 'host',
  }
}

function Harness(props: {
  readonly initial: AutoScheduleSettings
  readonly save: (tasks: readonly AutoScheduleTask[]) => void
  readonly openSession?: (sessionId: string) => void
}): ReactNode {
  const [state, setState] = useState(() => snapshot(props.initial))
  const pageProps = {
    t: translate,
    useScheduleSettings: <S,>(selector: (value: SettingsScopeSnapshot<AutoScheduleSettings>) => S): S => selector(state),
    saveTasks: async (tasks: readonly AutoScheduleTask[]): Promise<void> => {
      props.save(tasks)
      setState(current => ({ ...current, value: { ...(current.value as AutoScheduleSettings), tasks } }))
    },
    openSession: props.openSession ?? (() => {}),
  } as AutoScheduleSettingsPageProps
  return <AutoScheduleSettingsPage {...pageProps} />
}

const seededTask: AutoScheduleTask = {
  id: 'task-seeded',
  name: '日报提醒',
  enabled: true,
  schedule: { kind: 'cron', expression: '0 9 * * *', timeZone: 'Asia/Shanghai' },
  action: { kind: 'notification', title: '日报', body: '查看日报' },
  revision: 1,
  executionRevision: 1,
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
}

describe('AutoScheduleSettingsPage', () => {
  it('creates, toggles, and deletes a notification task through the injected Settings action', async () => {
    const saves = vi.fn<(tasks: readonly AutoScheduleTask[]) => void>()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<Harness initial={{ ...DEFAULT_SETTINGS, tasks: [], runtime: [] }} save={saves} />)

    fireEvent.click(screen.getByRole('button', { name: '新建任务' }))
    fireEvent.change(screen.getByLabelText('任务名称'), { target: { value: '喝水提醒' } })
    fireEvent.change(screen.getByLabelText('执行方式'), { target: { value: 'after' } })
    fireEvent.change(screen.getByLabelText('延时秒数'), { target: { value: '5' } })
    fireEvent.change(screen.getByLabelText('任务动作'), { target: { value: 'notification' } })
    fireEvent.change(screen.getByLabelText('通知标题'), { target: { value: '休息' } })
    fireEvent.change(screen.getByLabelText('通知内容'), { target: { value: '起来活动一下' } })
    fireEvent.click(screen.getByRole('button', { name: '保存任务' }))

    await screen.findByText('喝水提醒')
    expect(saves).toHaveBeenCalledOnce()
    expect(saves.mock.calls[0]?.[0][0]).toMatchObject({
      name: '喝水提醒', schedule: { kind: 'after', afterSeconds: 5 }, action: { kind: 'notification' },
    })

    fireEvent.click(screen.getByRole('checkbox', { name: '立即启用' }))
    await waitFor(() => { expect(saves).toHaveBeenCalledTimes(2) })
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    await waitFor(() => { expect(saves).toHaveBeenCalledTimes(3) })
    expect(screen.queryByText('喝水提醒')).toBeNull()
  })

  it('creates an enabled main-Agent task only after unattended-run confirmation', async () => {
    const saves = vi.fn<(tasks: readonly AutoScheduleTask[]) => void>()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<Harness initial={{ ...DEFAULT_SETTINGS, tasks: [], runtime: [] }} save={saves} />)

    fireEvent.click(screen.getByRole('button', { name: '新建任务' }))
    fireEvent.change(screen.getByLabelText('任务名称'), { target: { value: 'Chrome 验收' } })
    fireEvent.change(screen.getByLabelText('执行方式'), { target: { value: 'after' } })
    fireEvent.change(screen.getByLabelText('延时秒数'), { target: { value: '5' } })
    fireEvent.change(screen.getByLabelText('任务动作'), { target: { value: 'agent' } })
    fireEvent.change(screen.getByLabelText('Agent 任务说明'), { target: { value: '打开 Chrome 并执行验收用例' } })
    fireEvent.change(screen.getByLabelText('工作目录（可选）'), { target: { value: '/Users/test/case' } })
    fireEvent.change(screen.getByLabelText('Agent 预设 ID（可选）'), { target: { value: 'browser' } })
    fireEvent.click(screen.getByRole('button', { name: '保存任务' }))

    await screen.findByText('Chrome 验收')
    expect(confirm).toHaveBeenCalledWith(zh.agentConfirm)
    expect(saves.mock.calls[0]?.[0][0]).toMatchObject({
      action: {
        kind: 'agent', prompt: '打开 Chrome 并执行验收用例', cwd: '/Users/test/case', agentPreset: 'browser',
      },
    })
  })

  it('renders the reviewed task-card structure and runtime projection', () => {
    const { container } = render(<Harness
      initial={{
        ...DEFAULT_SETTINGS,
        tasks: [seededTask],
        runtime: [{
          taskId: seededTask.id,
          taskRevision: 1,
          state: 'scheduled',
          nextRunAt: '2026-08-25T01:00:00.000Z',
        }],
      }}
      save={() => {}}
    />)
    expect(screen.getByText('日报提醒')).toBeTruthy()
    expect(screen.getByText('Cron 0 9 * * * · Asia/Shanghai')).toBeTruthy()
    expect(container.firstChild).toMatchSnapshot()
  })

  it('renders newest-first persisted execution history with result details and output', () => {
    const openSession = vi.fn()
    const newest = {
      scheduledAt: '2026-08-25T01:00:00.000Z',
      startedAt: '2026-08-25T01:00:00.000Z',
      finishedAt: '2026-08-25T01:00:01.250Z',
      outcome: 'succeeded' as const,
      exitCode: 0,
      stdout: 'newest-output',
      agentSessionId: 'session-agent-history',
      agentPreset: 'browser',
    }
    const older = {
      scheduledAt: '2026-08-24T01:00:00.000Z',
      startedAt: '2026-08-24T01:00:00.000Z',
      finishedAt: '2026-08-24T01:00:02.000Z',
      outcome: 'failed' as const,
      exitCode: 7,
      stderr: 'older-error',
    }
    render(<Harness
      initial={{
        ...DEFAULT_SETTINGS,
        tasks: [seededTask],
        runtime: [{
          taskId: seededTask.id,
          taskRevision: 1,
          state: 'succeeded',
          nextRunAt: '2026-08-26T01:00:00.000Z',
          lastRun: newest,
          history: [newest, older],
        }],
      }}
      save={() => {}}
      openSession={openSession}
    />)

    expect(screen.getByText('执行历史（最近 2 次）')).toBeTruthy()
    expect(screen.getByText('newest-output')).toBeTruthy()
    expect(screen.getByText('older-error')).toBeTruthy()
    expect(screen.getByText('1250 毫秒')).toBeTruthy()
    expect(screen.getByText('2000 毫秒')).toBeTruthy()
    expect(screen.getByText('session-agent-history')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '打开会话' }))
    expect(openSession).toHaveBeenCalledWith('session-agent-history')
  })

  it('shows unavailable and read-only host states', () => {
    const unavailable = {
      t: translate,
      useScheduleSettings: <S,>(selector: (value: SettingsScopeSnapshot<AutoScheduleSettings>) => S): S => selector({
        status: 'unavailable', value: undefined, base: undefined, user: undefined,
        revision: undefined, writable: false, mode: 'memory',
      }),
      saveTasks: async () => {},
      openSession: () => {},
    } as AutoScheduleSettingsPageProps
    const { rerender } = render(<AutoScheduleSettingsPage {...unavailable} />)
    expect(screen.getByRole('alert').textContent).toContain('Host 未提供')
    rerender(<Harness initial={{ ...DEFAULT_SETTINGS, tasks: [], runtime: [] }} save={() => {}} />)
  })
})
