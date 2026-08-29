# 安全模型

## 授权边界

定时 Shell 与 Agent 都是持久化的无人值守执行授权，风险高于普通一次性操作。本插件采用两阶段边界：

1. Agent 通过会话创建、启用或改变一个有效 Shell/Agent 任务时，`tools/pre-execute` 返回 `ask`，由 DSH `ctx.approval` 完成可审计的一次性确认。没有 Agent、没有审批通道、拒绝或取消都会 fail closed。
2. 到点执行发生在原会话回合之外。Shell 只使用当前 `ctx.shell` 的默认沙箱策略；Agent 创建新的顶层 Session 并继承当前预设的模型、工具、权限与审批规则。插件不请求扩大权限、不调用 approval 代替工具自己的审批，也不回退到裸 `child_process`。

Web 页面是用户直接操作通道。保存一个已启用、且执行定义发生变化的 Shell 或 Agent 任务前使用浏览器确认；Host 仍执行全部结构与策略校验。

## 威胁与控制

| 威胁 | 控制 |
|---|---|
| Prompt injection 创建持久命令 | Shell create/enable/change 触发标准 DSH approval；工具描述要求直接用户意图 |
| Prompt injection 创建持久 Agent | Agent create/enable/change 同样触发 approval；任务 prompt 以 JSON 转义字段封装，调度元数据不能被换行伪造 |
| 定时 Agent 绕过工具审批 | 不支持；新 Agent 沿用预设工具策略，需要交互审批的调用会等待并可能超时 |
| 周期 Agent 成本失控 | 每次 occurrence 都是新会话；默认 15 分钟、最大 1 小时，prompt 最大 64 KiB；部署仍应按预算设置频率 |
| cwd 名称碰撞导致错误归组 | 仅用真实路径匹配已有 Workspace，并由 `attachSession` 复核 Session header；不按显示名称匹配、不自动创建 Workspace |
| 到点自动提权 | 不支持；只沿用当前 ShellExecutor 沙箱，拒绝即失败 |
| 参数注入到通知命令 | POSIX、AppleScript、PowerShell 分别做字面量转义；标题/正文不拼成未引用参数 |
| 高频误配置 | 固定间隔和 Cron cadence 受可配置的 `minIntervalSeconds` 限制；默认允许 1 秒，生产部署可主动调高 |
| 历史输出撑爆设置文件 | 单次调用设置 `stdoutMaxBytes`，每任务历史由 `maxHistoryEntriesPerTask` 有界保留（默认 50，最大 1000） |
| 插件卸载后继续执行 | timer 清除，active AbortSignal 终止，并等待队列静止 |
| 重启积压风暴 | 过期周期任务只执行一次，下一 occurrence 跳到当前时刻之后 |
| Web 并发覆盖 | Settings revision fence 拒绝陈旧写并刷新 Host 快照 |

## 不提供的保证

- 不提供 exactly-once。崩溃窗口可能造成重复执行，脚本必须自行幂等。
- 不提供跨进程 leader election。同一文档只能由一个 Host 调度。
- 不把 Web 页面视为额外认证系统；它沿用 DSH Web 现有连接、Host 信任和 Settings Remote 边界。
- 不判断命令业务安全性。沙箱限制文件效果，但不会理解一条允许范围内命令的业务后果。
- 不把 Agent 回合 `completed` 当作外部业务成功。插件无法替代任务内的页面、文件或 API 结果核验。
- 不替 Agent 自动批准工具调用。需要人工审批的步骤可能一直等待到任务超时。
- stdout/stderr 可能含敏感信息，并会随执行历史持久化；不要让任务打印凭据，删除任务会一并清理其 runtime 历史。

## 部署建议

- 默认使用 `workspace-write`，不要因为定时任务而全局切到 `danger-full-access`。
- 定时脚本放在受版本控制的工作区，用绝对或明确 cwd 的路径调用。
- 脚本实现锁、幂等键、超时和业务日志；高风险动作先做 dry-run。
- 对来自网页、邮件、MCP 返回值的命令文本保持不信任，不直接转成持久任务。
- Agent 任务说明应写明最终成功条件、证据路径和失败退出条件，避免 Agent 在目标未完成时仍给出笼统成功答复。
- 高频 Agent 任务会产生模型调用成本；优先使用合理周期和明确超时。
- Linux 桌面通知应确认 `notify-send` 来源与 PATH；DSH ShellExecutor 会继续执行环境清理。
