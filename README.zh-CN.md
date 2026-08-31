# dsh-b2us-schedule

[English](README.md) | **简体中文**

面向 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/DeepSeek-Harness)的持久化定时任务插件，支持定时启动 Agent、执行 Shell 命令和发送桌面通知，并同时提供会话工具与独立 Web 管理页面。

> [!IMPORTANT]
> 调度器提供的是 **at-least-once（至少一次）** 交付语义。Shell 正常退出或 Agent 回合正常完成，只能证明本地执行结果，不代表外部业务目标一定成功。

## 项目简介

`dsh-b2us-schedule` 在一个可安装包中同时提供 Host 插件和 Web 客户端。Agent 可以通过 5 个类型化工具创建和管理任务，用户也可以在 **设置 → 插件 → 定时任务** 中管理同一份持久化任务数据。

npm 包名和 Web 模块标识已统一为 `dsh-b2us-schedule`。为保持运行时兼容，Cordis 行 ID 与 Settings 命名空间仍为 `auto-schedule`，会话工具继续使用 `auto_schedule_` 前缀。

## 重命名与兼容性

`dsh-b2us-schedule` 是原 `dsh-auto-schedule` 的新包名和仓库名。持久化 Settings 命名空间、Cordis 行 ID、工具名和任务 schema 有意保持稳定，因此已有数据文档无需进行 schema 改写。

迁移已有 Profile 前应先备份，并把旧包引用替换为新包。不要在同一个 Profile 中同时加载两个包名：它们有意声明了相同的 `auto-schedule` Cordis 行和 Settings 命名空间。

## 核心能力

- **四种调度方式：** Cron、一次性延时、带显式 UTC 偏移的绝对时间、固定时间间隔。
- **三种动作类型：** 新建顶层 DSH Agent Session、Shell 命令或脚本、系统桌面通知。
- **两种管理入口：** 类型化会话工具和中英文 Web 设置页面。
- **持久化状态：** 任务定义、运行态和有界执行历史写入 DSH Settings，Host 重启后恢复。
- **受控补跑：** 一次性任务在重启后补跑一次；Cron 和固定间隔任务最多补跑一次，然后推进至未来的下一次 occurrence，避免积压风暴。
- **完整生命周期清理：** 卸载、停用、删除或修改执行定义时，通过 DSH 生命周期信号取消相关定时器或当前工作。
- **如实记录结果：** 每次执行保留 outcome、退出码、有界输出、错误、超时、沙箱拒绝和 Agent Session 链接。

## 调度模型

| 类型 | 输入 | 行为 |
|---|---|---|
| Cron | `cron_expression` 和可选 `time_zone` | 支持 Croner 的 5、6、7 段表达式与 IANA 时区 |
| 延时 | `after_seconds` | 从创建或执行定义更新时起，按正数秒延时执行一次 |
| 绝对时间 | `at` | 在未来的 ISO 时间执行一次；必须包含 `Z` 或数字 UTC 偏移，内部保存为 UTC |
| 固定间隔 | `every_seconds` | 以最近一次执行定义更新时间为锚点重复执行，并跳过错过的中间 occurrence |

Cron 和固定间隔必须满足 `minIntervalSeconds`。默认值为 1 秒；不适合高频执行的生产部署应主动调高。同一 Host 进程内，到期任务按计划时间顺序串行执行。

## 动作类型

### 新建 Agent Session

每个 Agent occurrence 都会创建一个新的顶层 DSH Agent 和 Session：

1. 任务提供工作目录时使用该目录；留空时保留 Host 默认目录。
2. 如果解析后的 Session 路径与已有 DSH 工作区完全匹配，则把 Session 挂载到该工作区。插件不按显示名称猜测，也不自动创建工作区。
3. 使用任务指定的 Agent 预设；留空时在执行时解析当前生效的 DSH 默认预设。
4. 安装执行时生效的默认模型和 reasoning effort，并把任务说明作为普通用户回合送入 Agent。
5. 等待回合完成、取消或超时，随后刷新 Session 持久化并释放 live Agent。
6. 在执行记录中保存 Session id 和实际预设，用户可从 Web 页面打开完整的冷 Session。

因此，循环任务不会在同一个 Agent 中持续累积上下文。当前调度器为全局串行：当前 Shell 或 Agent occurrence 结束后，下一项到期任务才会启动。

Agent 记录为 `succeeded` 只表示回合以 `completed` 结束。如果真正目标是网站签到、文件生成等外部结果，任务说明应明确要求核验最终状态并保存证据路径。

### Shell 命令或脚本

插件不会直接调用 Node.js `child_process`，也不会复制 `tool-bash`。所有命令均通过 `ctx.shell` 解析和执行，因此工作目录、环境清理、输出上限、超时上限和沙箱策略仍由当前 DSH ShellExecutor 负责。

- POSIX 宿主通常使用 DSH Bash 执行器。
- Windows 宿主通常使用 DSH PowerShell 执行器。
- 沙箱拒绝会记录为失败；定时 occurrence 不会自动申请提权。

### 桌面通知

系统通知同样通过当前 DSH ShellExecutor 执行：

| 平台 | 适配方式 |
|---|---|
| macOS | `/usr/bin/osascript` |
| Linux | `notify-send`（需要安装并可从桌面会话访问） |
| Windows | PowerShell + `System.Windows.Forms.NotifyIcon` |

缺少桌面会话、权限、可执行程序或沙箱准入时会形成可见失败，不会伪装为成功。

## 会话工具

| 工具 | 用途 |
|---|---|
| `auto_schedule_create` | 创建持久化调度规则与动作 |
| `auto_schedule_update` | 通过精确任务 id 修改、启用或停用任务 |
| `auto_schedule_list` | 紧凑列出任务、下次执行时间和最近结果 |
| `auto_schedule_history` | 读取指定任务的有界执行历史与输出 |
| `auto_schedule_delete` | 删除任务及其关联运行历史 |

示例：

- “10 分钟后在 `/srv/app` 目录执行 `./scripts/backup.sh`。”
- “每天 `Asia/Shanghai` 时区上午 9 点发桌面通知，提醒我查看日报。”
- “每天 8 点在 `/Users/me/tests` 新建一个主 Agent，使用默认预设，15 分钟超时。”
- “把刚才创建的任务停用。”
- “列出全部定时任务及其下次执行时间。”

修改或删除任务时，必须使用工具返回的精确任务 id。

## Web 管理

Web profile 安装插件并重启后，打开 **设置 → 插件 → 定时任务**。中英文页面支持：

- 新建和编辑调度规则与动作；
- 启用、停用和删除任务；
- 查看下次 occurrence 和最近状态；
- 展开有界执行历史；
- 打开 Agent occurrence 对应的持久化 Session；
- 检测 revision 冲突并刷新，而不是静默覆盖。

从 Web 页面保存一个已启用的 Shell 或 Agent 任务时，需要明确确认无人值守执行风险。

## 快速开始

### 环境要求

- Node.js `^22.19.0 || >=24.0.0`
- DeepSeek Harness `0.1.2-alpha.2`
- Cordis `4.0.2`

精确的 DSH/Cordis peer 版本声明在 `package.json` 中。

### 构建与验证

```bash
npm install
npm run check
```

`npm run check` 会依次执行严格类型检查、行为测试、覆盖率门禁、生产构建以及构建后包结构/打包测试。

### 打包与安装

```bash
npm run build
npm pack
dsh plugin --profile web add ./dsh-b2us-schedule-0.3.2.tgz
dsh --profile web --dump-config
```

tarball 内置 `croner` 运行时依赖，可在不访问 npm registry 的情况下安装到全新 Profile。DSH 与 Cordis 仍使用宿主提供的 peer dependency，不会被重复打入插件包。

包同时声明 `dsh.bundle.patch` 与 `dsh.client`。安装后，Host 行和 Web 客户端都从同一个包中发现；无需修改或重新构建 DeepSeek Harness 源码。

## 持久化与恢复

`auto-schedule` Settings 命名空间区分用户数据与 Host 运行态：

- `tasks[]` 保存由 Web 页面和会话工具管理的任务定义。
- `runtime[]` 保存由 Host 调度器管理的下次执行状态、最近结果和最新优先的有界历史。
- `revision` 在任何编辑时递增；`executionRevision` 只在启停、时间规则或动作变化时递增。

每个任务最多保留 `maxHistoryEntriesPerTask` 条结果，默认 50，允许范围为 1–1000。`auto_schedule_list` 只投影最近结果和历史数量；详细记录通过 `auto_schedule_history` 按需读取，避免普通列表无限扩大模型上下文。

交付语义是 at-least-once。如果 Host 在动作已经结束、运行态尚未持久化时崩溃，重启后该 occurrence 可能再次执行。具有外部副作用的命令必须自行实现幂等键、锁或事务保护。

## 配置

包内 `cordis.patch.yml` 提供完整默认配置：

| 字段 | 默认值 | 用途 |
|---|---:|---|
| `allowShellActions` | `true` | 是否允许 Shell 调度 |
| `allowAgentActions` | `true` | 是否允许新建 Agent 调度 |
| `defaultTimeZone` | `UTC` | Cron 未指定时区时使用的默认值 |
| `minIntervalSeconds` | `1` | Cron 周期和固定间隔的最小秒数 |
| `maxHistoryEntriesPerTask` | `50` | 每任务最新优先保留的结果数，最大 1000 |
| `maxShellTimeoutMs` | `600000` | 单次 Shell 动作的 Host 策略上限 |
| `defaultAgentTimeoutMs` | `900000` | Agent occurrence 默认超时 |
| `maxAgentTimeoutMs` | `3600000` | Agent occurrence 最大超时 |
| `maxAgentPromptBytes` | `65536` | Agent prompt 最大 UTF-8 字节数 |
| `shellOutputMaxBytes` | `16384` | 持久化 stdout/stderr 字节预算 |
| `maxCommandBytes` | `32768` | Shell 命令最大 UTF-8 字节数 |
| `maxNotificationBytes` | `8192` | 通知负载最大 UTF-8 字节数 |
| `notificationTimeoutMs` | `15000` | 通知适配器超时 |
| `schedulerRetryMs` | `5000` | 调度 drive 失败后的重试间隔 |

DSH patch 覆盖会替换整份 config，而不是深合并。把 `defaultTimeZone` 改为 `Asia/Shanghai` 等本地时区时，应保留部署仍需使用的其他全部字段。

## 审批与安全模型

定时 Shell 和 Agent 动作属于持久化无人值守授权，因此插件严格区分创建时审批与执行时策略：

1. Agent 通过会话工具创建、启用或实质性修改一个生效的 Shell/Agent 任务时，存储前返回标准 DSH `ask` 决策。
2. occurrence 到点后，Shell 仍受当前 ShellExecutor 限制；定时器不能开启交互式提权流程。
3. 定时 Agent 继承其预设、模型、工具、权限规则和普通工具审批；插件不会代替 Agent 自动批准工具。
4. Web 编辑使用直接用户确认，Host 仍会校验完整 Settings 文档和策略上限。

不要把不可信网页、邮件或工具输出中的命令与 prompt 未经审查就转成持久无人值守任务。避免输出凭据，因为受限的 stdout/stderr 会保存在运行历史中，直至任务被删除。

完整威胁模型与部署建议见 [docs/SECURITY.md](docs/SECURITY.md)。

## 开发命令

```bash
npm run typecheck
npm test
npm run test:coverage
npm run build
npm run test:built
npm pack --dry-run
```

构建产物：

- `lib/index.js`：Host 插件
- `lib/invariant.js`：包自有 invariant companion
- `lib/client.js`：供 `window.__ModuleLoader__` 加载的 lazy-CJS Web 客户端
- `lib/types/`：Host 与 Client 类型声明

延伸阅读：

- [架构说明](docs/ARCHITECTURE.md)
- [安全模型](docs/SECURITY.md)
- [开发与测试流程](docs/DEVELOPMENT.md)
- [已记录的验证证据](docs/VERIFICATION.md)

## 已知限制

- 同一份 Settings 文档只能由一个 Host 进程调度；当前没有分布式租约或 leader election。
- 交付语义为 at-least-once，不是 exactly-once。
- 到期动作串行执行，不并发执行。
- 每个 Agent occurrence 都可能产生模型及外部工具费用。
- 需要交互审批的工具可能一直等待到无人值守 Agent occurrence 超时。
- 只有 Session 规范化路径与已有 DSH 工作区完全匹配时才会自动归组。
- 原生通知是否可用仍取决于操作系统、桌面会话、权限和沙箱。
- 仓库测试和受控时钟不能替代真实 occurrence、真实通知、Windows 原生、付费/在线 API 或主观 Web UI 验收。

## License

[MIT](LICENSE)
