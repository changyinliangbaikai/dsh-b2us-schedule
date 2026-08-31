# dsh-auto-schedule

`dsh-auto-schedule` 是 DeepSeek Harness（DSH）的持久化定时任务插件。它同时提供 Host 与 Web 两个插件面：Agent 可以在会话中通过工具创建、修改、查看和删除任务，用户也可以在 Web 的“设置 → 插件 → 定时任务”独立页面直接管理。

## 能力

- 调度方式：Cron 表达式、延时执行、带时区偏移的绝对时间、固定时间间隔。
- 动作类型：新建顶层主 Agent 会话、命令行命令或 Shell 脚本调用、系统通知。
- 会话工具：`auto_schedule_create`、`auto_schedule_update`、`auto_schedule_list`、`auto_schedule_history`、`auto_schedule_delete`。
- Web 管理：新建、编辑、启停、删除，查看下次执行时间、最近状态、可展开的执行历史和 Agent 会话入口。
- 持久化：任务定义、运行态和有界执行历史写入 DSH 的 `auto-schedule` Settings 命名空间，重启后恢复。
- 错过处理：一次性任务在重启后补跑一次；Cron 与固定间隔任务最多补跑一次，然后跳到当前时刻之后的下一个 occurrence，避免积压风暴。
- 生命周期：插件卸载会清理定时器，并终止本插件当前正在等待的 Shell 调用或 Agent 回合。

## 主 Agent 动作

选择“主 Agent 任务”后，每个 occurrence 都会创建一个新的顶层 DSH Agent/Session：

1. 使用任务设置的工作目录；留空时不覆盖 Host 的默认目录。
2. 如果 Session 的实际工作目录与一个已有 DSH 工作区的规范化路径匹配，先将 Session 挂载到该工作区；只按路径复用，不按名称猜测，也不自动创建工作区。
3. 使用任务指定的 Agent 预设；留空时解析执行时生效的 DSH 默认预设。
4. 使用执行时生效的默认模型及 reasoning effort，把任务说明作为一个普通用户回合送入 Agent。
5. 等待 Agent 回合结束或达到超时，然后强制刷新 Session 持久化并释放 live Agent。
6. 在执行历史中保留 Session id、有效预设和结果；Web 页面可直接打开对应冷会话查看完整过程。

因此循环任务不会在一个 Agent 上不断累积上下文，每次触发都是隔离的新会话。当前调度器仍全局串行：上一次 Shell/Agent 动作结束后才会开始下一项到期任务；期间错过的固定间隔或 Cron occurrence 最多补跑一次，再跳到未来时间。

历史中的“成功”只表示 Agent 回合以 `completed` 正常结束，不等价于网站签到、文件生成等外部业务结果已经成功。任务说明应要求 Agent 明确核验最终状态并保存证据；实际过程和最终答复以历史链接中的 Session 为准。

## Shell 能力复用结论

插件不直接使用 Node `child_process`，也不复制 `tool-bash`。所有命令与系统通知都通过 DSH 公共执行缝 `ctx.shell.resolve()` + `ctx.shell.run()` 执行，因此会继承当前 profile 选择的 ShellExecutor：

- POSIX 默认进入 DSH Bash 执行器；Windows 默认进入 PowerShell 执行器。
- 工作目录、超时上限、输出截断和环境清理由当前执行器继续负责。
- 装载沙箱执行器时，定时命令沿用其 `read-only` / `workspace-write` / `danger-full-access` 策略。
- 定时触发发生在会话回合之外，不能合法弹出 DSH 审批。因此插件绝不会在到点时自动申请沙箱提权；沙箱拒绝会记录为失败。

通过会话创建、启用或修改一个会实际运行的 Shell 或 Agent 任务时，插件在 `tools/pre-execute` 返回标准 `ask` 决策，先走 DSH 一次性审批。Web 页面中的同类操作属于用户直接操作，页面会再次显示无人值守执行确认。Agent 到点后不会绕过工具审批或自动扩大权限；若任务所需工具要求交互审批，回合会等待用户处理并可能最终超时。

## 调度语义

| 类型 | 输入 | 行为 |
|---|---|---|
| Cron | `cron_expression` + 可选 `time_zone` | 支持 Croner 的 5/6/7 段表达式与 IANA 时区 |
| 延时 | `after_seconds` | 从创建或改动执行定义的时间起，延时后执行一次 |
| 绝对时间 | `at` | 要求带 `Z` 或数字偏移的 ISO 时间，内部规范化为 UTC |
| 固定间隔 | `every_seconds` | 按最近一次执行定义更新时间锚定；跳过错过的中间 occurrence |

`minIntervalSeconds` 默认 1 秒，只约束 Cron 的实际周期与固定间隔；一次性延时同样只要求正整数。该字段是部署策略而非 Croner 的技术限制，生产环境如需限制高频任务可以主动调高。单进程内同一时刻到期的任务按计划时间串行执行。当前交付语义为 at-least-once：进程在命令完成后、运行态落盘前崩溃时，重启可能再次执行该 occurrence；不要把非幂等命令误认为 exactly-once。

每个任务按最新优先持久化最近 `maxHistoryEntriesPerTask` 次执行结果，默认 50、配置范围 1–1000。记录包含计划/开始/结束时间、结果、退出码、失败原因、Agent Session/预设，以及受 `shellOutputMaxBytes` 限制的 stdout/stderr。`auto_schedule_list` 只返回最近结果与历史数量；需要完整记录时使用 `auto_schedule_history` 按任务和条数读取，避免普通列表无限扩大模型上下文。删除任务后，其 Host runtime 与历史也会在调度器 reconcile 时清理。

## 系统通知

- macOS：通过 DSH Shell 执行 `/usr/bin/osascript`。
- Linux：通过 DSH Shell 调用 `notify-send`，宿主需安装对应桌面通知工具。
- Windows：通过 DSH PowerShell 执行器创建 `System.Windows.Forms.NotifyIcon` 气泡通知。

通知同样受 Shell 沙箱约束。桌面会话、通知权限或依赖缺失会形成可见失败，不会被伪装为成功。

## 构建与测试

要求 Node.js `^22.19.0 || >=24.0.0`，并与 DSH `0.1.2-alpha.2` 配套。

```bash
npm install
npm run check
```

常用命令：

```bash
npm run typecheck
npm test
npm run test:coverage
npm run build
npm run test:built
npm pack --dry-run
```

构建会生成：

- `lib/index.js`：Host 插件。
- `lib/invariant.js`：包自有 invariant companion。
- `lib/client.js`：符合 `window.__ModuleLoader__.load({ id, factory })` 契约的 lazy-CJS Web 插件。
- `lib/types/`：Host 与 Client 类型声明。

测试分层与本地 Web 验收见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)，架构见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，安全边界见 [docs/SECURITY.md](docs/SECURITY.md)。

## 安装

```bash
npm run build
npm pack
dsh plugin --profile web add ./dsh-auto-schedule-0.3.2.tgz
dsh --profile web --dump-config
```

发布 tarball 会内置 `croner` 运行时依赖，因此可以由桌面壳的离线安装页在全新 Profile 中安装；安装过程不需要访问 npm registry。DSH/Cordis 单例仍通过 peer dependency 使用宿主版本，不会被复制进插件包。

包同时声明 `dsh.bundle.patch` 与 `dsh.client`。安装并重启 Web profile 后，bundle patch 插入 Host 行；Web 插件表从同一个已加载包发现 `./client`，因此不需要修改或重新构建 DeepSeek Harness 仓库。

默认时区为 `UTC`。中国本地部署可在 profile/home patch 中完整覆盖该行的 `config`，将 `defaultTimeZone` 改为 `Asia/Shanghai`。DSH patch 替换整份 config 而非深合并，覆盖时应保留仍需使用的字段。

## 会话示例

- “10 分钟后执行 `./scripts/backup.sh`，工作目录是 `/srv/app`。”
- “每天 Asia/Shanghai 时区上午 9 点发系统通知，提醒我查看日报。”
- “每天 8 点创建一个主 Agent，在 `/Users/me/tests` 目录执行 Chrome 签到验收；使用默认预设，15 分钟超时。”
- “把刚才的任务停用。”
- “列出所有定时任务和下次执行时间。”

Chrome 控制验收示例的 Agent 任务说明可直接写为：

```text
使用 dsh-auto-chrome-tool 控制我当前连接的 Chrome，执行以下验收：
1. 新建标签页并打开 https://ikuuu.club/。
2. 使用第一个域名并点击“访问网站”，进入新登录标签页。
3. 如果账号密码未自动填充，从当前工作目录的 iku-act.txt 读取第一行账号、第二行密码并填写；不得在回复或日志中输出凭据。
4. 点击“点我开始验证”，验证通过后点击登录。
5. 登录成功后点击“每日签到”，核验签到成功状态。
6. 将最终成功页面截图保存到当前工作目录，并在最终答复中写明截图的绝对路径和页面上的成功证据；若未成功，明确报告失败步骤，不得把仅完成 Agent 回合当作业务成功。
```

将任务工作目录设置为包含 `iku-act.txt` 的测试目录。模型应使用工具返回的精确任务 id 进行修改和删除。命令、任务说明或脚本内容来自不可信网页、邮件或工具结果时，不应直接创建持久无人值守任务。

## 已知边界

- 当前为单 Host 进程调度器，没有跨多实例的分布式租约；同一 Settings 文档不得同时由多个 DSH Host 执行。
- 保证 at-least-once，不保证 exactly-once；涉及转账、删除、发布等动作时，脚本自身必须提供幂等键或事务保护。
- 每个任务只保留配置上限内的最近执行历史；单次大输出仍由 DSH ShellExecutor 的截断/溢出策略决定。
- 每次 Agent occurrence 都会使用当前默认模型，可能产生模型和外部工具费用；周期设置应与成本预算匹配。
- Agent 任务没有审批旁路。无人值守执行碰到必须交互确认的工具调用时，可能停留到任务超时。
- Agent 工作目录只有在规范化路径与已有 DSH 工作区完全匹配时才会自动归组；未注册路径继续显示为未分组，插件不会代替用户创建工作区。
- Web 页面使用 DSH Settings 的字段级修订冲突处理；冲突写会失败并刷新最新 Host 状态，不静默覆盖。

## License

MIT
