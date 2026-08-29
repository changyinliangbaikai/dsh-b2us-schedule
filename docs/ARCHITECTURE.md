# 架构

## 双插件面

同一个 npm 包发布三个入口：

```text
dsh-auto-schedule
├─ .            Host：Settings、Scheduler、ctx.agents、ctx.shell、Tools、approval gate
├─ ./client     Web：settings.plugins.tab + settingsScope
└─ ./invariant  包自有 invariant companion
```

Host 与 Web 不通过自定义私有 RPC 通信。Host 注册 `auto-schedule` Settings 命名空间，Web 使用 DSH 标准 `ctx.settingsScope.bind({ namespace: 'auto-schedule' })` 订阅并写入 `tasks` 字段。Host 只写 `runtime` 字段。两类写由 SettingsProvider 的串行持久化与 revision fence 协调，减少 task/runtime 互相覆盖。

## 数据所有权

- `tasks[]`：用户拥有的定义，Web 与创建、修改、删除工具可以替换。
- `runtime[]`：Host 调度器拥有的投影，包括 `nextRunAt`、状态、兼容字段 `lastRun` 与最新优先的有界 `history[]`。
- `revision`：任何任务编辑都会递增。
- `executionRevision`：只在启停、规则或动作变化时递增；单纯改名不会重置下一次执行时间。

SettingsProvider 在每个持久化边界执行 Schemastery 解析和 owner validator。任务 id、UTC 时间、时区、Cron、动作结构与运行态均会重新验证。过时 runtime 行允许短暂存在，以便 task 删除与 runtime 清理分别通过原子字段写完成；调度器下一次 reconcile 会删除它。

`history[]` 默认每任务保留 50 条，由 `maxHistoryEntriesPerTask` 控制并限制在 1–1000。每次完成 occurrence 时与 `lastRun`、下一次时间在同一 runtime 字段写中提交；reconcile 会迁移只有 `lastRun` 的 v0.1.x 文档并裁剪超限记录。普通任务列表只投影 `historyCount`，完整历史由 `auto_schedule_history` 按需读取。

## 调度循环

`AutoScheduleRuntime` 只有一条串行 drive queue：

1. 读取当前 Settings 快照并 reconcile runtime。
2. 恢复进程崩溃遗留的 `running` occurrence 为 `scheduled`。
3. 串行执行所有已到期 occurrence。
4. 对周期任务计算当前时刻之后的下一次执行；一次性任务终止。
5. 只为最早 occurrence 设置一个分段 timer，超过 Node 最大 timer 延迟时分段等待。

Settings 变更只请求一次新的 drive，不直接在 watcher 中执行任务。任务在执行期间被删除、停用或改变 execution revision 时，watcher 会中止传给 Shell 或 Agent 执行器的 `AbortSignal`。插件 unload 同样先取消 timer 和 active run，再等待队列静止。

## Agent 生命周期复用

Agent 动作直接复用 DSH 公共生命周期服务，不通过 Shell 回调 DSH，也不伪造 Web RPC：

```text
scheduled Agent action
  → ctx.agents.withoutInitiator(...)
  → resolve current default model + requested/default Agent preset
  → ctx.agents.create({ sessionId, meta: { cwd, agentPreset }, setup })
  → ctx.workspaceRegistry.resolveByPath(session.header.cwd)
  → matchingWorkspace?.attachSession(sessionId)
  → agent.followup(user message)
  → agent.whenIdle() / timeout / AbortSignal
  → ctx.sessions.flush(session)
  → AgentHandle.dispose()
  → runtime.history[] records session id + effective preset
```

`withoutInitiator` 明确把定时执行建模为顶层主 Agent，而不是把首次初始化调度器的会话误记为父 Agent。预设在未发布的 `setup` 阶段挂载，失败会回滚创建；模型选择同样安装在 Agent scope 中并保留 reasoning effort。Session header 记录 cwd 与创建时预设。创建后以 header 中的实际 cwd 调用 Workspace 公共 API：仅当规范化路径命中已有工作区时执行 `attachSession`，不按标题关联、不调用 `create`。挂载在 prompt 投递前完成；校验失败时该 occurrence 失败并释放 live Agent，避免模型在错误归组下继续执行。执行完成后先 flush 再 dispose，因此 live Agent 被释放，但冷 Session 仍可在侧栏打开。

每个 occurrence 使用新的 Session，循环任务不会继承上一次运行的上下文。Agent 与 Shell 共用调度器的单条全局串行队列，所以不会并发启动重叠 occurrence。

## Shell 复用

动作执行只依赖 `@deepseek-ai/dsh-shell` 抽象：

```text
scheduled action
  → ctx.shell.resolve(request)
  → active ShellExecutor defaults/caps/sandbox
  → ctx.shell.run(spec)
  → bounded ShellRunResult
  → runtime.lastRun + bounded runtime.history[]
```

没有调用 `tool-bash`：它是模型工具适配器，不是可复用服务。直接复用 `ctx.shell` 才符合 DSH 的 capability seam；也避免从定时器伪造 ToolExecution 或会话回合。

## Web 扩展

Client manifest 声明 `dsh.client.platform = web` 与所需包图。`lib/client.js` 是 lazy-CJS closure factory；运行时通过 `window.__ModuleLoader__` 接收 React 等共享模块，不复制 Cordis/React 单例。Client 只使用：

- `ctx.slots.inject('settings.plugins.tab', ...)` 注册独立页面；
- `ctx.settingsScope` 读写标准 Settings Remote；
- `ctx.sessions` 打开历史记录对应的持久化 Agent Session；
- `ctx.locale` 注册中英文字典；
- 插件生命周期 effect 安装和移除样式。

React 组件不持有 `ctx`。Settings 快照通过 Slot inject 的 `hooks` compartment 转换为 `useScheduleSettings` selector hook，写操作通过显式 `saveTasks` face 注入。
