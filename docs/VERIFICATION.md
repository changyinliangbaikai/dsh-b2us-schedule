# 验证报告

验证日期：2026-08-25（Asia/Shanghai）  
插件版本：`dsh-auto-schedule 0.3.1`  
目标宿主：DeepSeek Harness `0.1.1-rc.2`，源码提交 `b150a551b8`

## 自动化门禁

| 门禁 | 结果 | 覆盖范围 |
|---|---|---|
| `npm run typecheck` | PASS | 严格 TypeScript Host、Client 与测试代码 |
| `npm test` | PASS，8 个文件、50 个测试 | 领域模型、Scheduler、Agent lifecycle、工作区归组、历史迁移与留存、真实 Cordis/ToolRuntime、Web 组件与表单 |
| `npm run test:coverage` | PASS | statements 88.04%，branches 79.97%，functions 88.34%，lines 90.96% |
| `npm run test:built` | PASS，8 个发布结构测试 | 三个入口、lazy-CJS Client、exports、patch、普通 Node 导入 |
| `npm pack --dry-run --ignore-scripts` | PASS | 生成约 139 kB、56 个条目的 tarball；`croner` 作为 bundled dependency 随包交付，只发布运行产物、文档、manifest 与 license |
| `npm audit --omit=dev --audit-level=high` | UNAVAILABLE | npmmirror 不实现 audit API；改用 npm 官方 registry 时 TLS 建连失败，未把网络失败记作安全通过 |
| 离线安装包共存 | PASS | 在全空 DSH Home、npm cache 与 pnpm store 中，通过桌面内置安装器的真实上传路由依次安装 `dsh-auto-chrome-tool 0.4.0` 与 `0.3.1`；Host 重启后两项 Host/Web contribution 均被发现 |

覆盖率门槛为 statements/functions/lines 85%、branches 75%。Shell 执行测试使用实现 DSH `ShellExecutor` 接口的受控 fake；集成测试使用真实 Cordis `Context`、Settings provider、SystemPrompt 和 ToolRuntime，不使用真实系统命令冒充断言。

### 0.3.1 工作区归组修复

1. 根因复现：仅把 `cwd` 写进新 Session header 不会触发 DSH 工作区归组；工作区成员关系还要求显式调用已有 Workspace 的 `attachSession`。
2. 修复后从新 Session header 读取实际 cwd，使用 `workspaceRegistry.resolveByPath` 做真实路径匹配；命中后在 prompt 投递前执行 `attachSession`。
3. 回归测试验证命中已有工作区时“先挂载、后投递”；未命中时不调用 `workspaceRegistry.create`，继续保持未分组；挂载校验失败时不投递 prompt、不 flush 空 Session，并释放 live Agent。
4. 当前交付只修复后续 occurrence；此前已经生成的未分组 Session 不做隐式迁移。
5. `0.3.1` tarball 已更新到保留原数据的隔离 Web profile；3 条任务及历史仍在，`/Users/jhx/Downloads/dsh-test` 对应的已有工作区仍可解析，Host 返回 HTTP 200。
6. Chrome bridge 重启后为 `listening`，1 个扩展会话为 `connected`，待处理请求为 0；未擅自触发新的真实模型任务，留给用户复验归组结果。

### 0.3.0 主 Agent 动作复验

1. 单元测试验证每次 occurrence 调用 Agent executor 时传递任务、计划时间、cwd、预设和超时，并把 Session id/有效预设写入有界历史。
2. 受控 DSH lifecycle 测试验证 `withoutInitiator` 顶层创建、执行时默认模型、预设挂载、JSON 转义 prompt framing、Session flush、live handle dispose 和超时 cancel。
3. ToolRuntime 集成测试验证 Agent action 的创建 schema、字段归一化和 enabled create/update approval 分类；禁用任务不会触发审批或执行。
4. Web 组件测试验证 Agent 表单、无人值守确认、历史 Session 入口和中英文文案。
5. `dsh-auto-schedule-0.3.1.tgz` 已安装到既有隔离 Web profile；2 条原有 Shell 任务及其历史保留，Chrome bridge 为 `listening`，1 个扩展会话为 `connected`。
6. 真实深色页面中已出现“主 Agent 任务”、任务说明、工作目录、预设 ID 和超时字段；按钮/文本对比正常，浏览器控制台 0 errors、0 warnings。
7. 本轮没有实际触发模型或外部网站，以避免未经用户确认产生模型调用和网站操作；真实 Chrome 签到任务保留为用户验收边界。

深色页面证据位于 `output/playwright/agent-action-dark.png` 与 `output/playwright/agent-action-fields-dark.png`。

## 真实 DSH Web 验收

本次从插件 tarball 安装到隔离的 DSH profile，使用已构建的 DSH Web Host 启动并通过真实浏览器验收：

1. “设置 → 插件”出现独立“定时任务”页签。
2. 在页面创建通知任务，能查看数量、启用状态和下次执行时间。
3. 将任务从延时 600 秒改为固定间隔 900 秒。
4. 停用任务后，状态和待执行数量同步更新。
5. 删除任务后恢复空状态。
6. 再创建一条停用的固定间隔任务，确认写入 `auto-schedule` Settings 命名空间。
7. 完整停止并重启同一 DSH profile，任务、动作字段与停用状态均恢复。
8. 创建启用的 1 秒延时 Shell 任务，页面先显示无人值守执行确认；接受后由该 profile 的真实 ShellExecutor 执行 `printf dsh-auto-schedule-e2e`，任务状态变为“成功”，标准输出正确回写。
9. 浏览器控制台结果：0 errors、0 warnings。
10. 本轮修复复验再次创建启用的 3 秒延时 Shell 任务；接受无人值守确认后，真实 ShellExecutor 在指定工作区写出内容为 `schedule-fixed-ok` 的 marker，页面状态为“成功”。
11. 完整停止并重启同时装有两个插件的 Host，任务总数、启用状态、最近执行时间和“成功”结果完整恢复；Chrome bridge 同时自动重连。

### 0.2.0 历史记录升级复验

1. 将 `dsh-auto-schedule-0.2.0.tgz` 安装到保留既有数据的同一隔离 profile 后重启 Host，3 个既有任务与 3 份 runtime 均保留。
2. `auto-schedule` Settings 命名空间已应用 `maxHistoryEntriesPerTask: 50`；3 份旧版 `lastRun` 均自动迁移为各 1 条持久化 `history`，没有重复记录。
3. 发布 Host 包含 `auto_schedule_history`，Client 包含执行历史界面；Client bundle 没有错误引入仅服务端使用的 `croner` 依赖。
4. 同一 Host 的 Chrome bridge 状态为 `listening`，已有 1 个认证扩展会话保持 `connected`，待处理请求为 0。

旧版本已经覆盖掉的更早执行结果没有数据来源，无法在升级时恢复；从 0.2.0 开始的新执行会按任务、按最新优先顺序累计，并受配置上限约束。

验收截图位于 `output/playwright/`。本轮直接证据为 `full-chain-20260824/03-schedule-executed-fixed.png` 与 `full-chain-20260824/04-schedule-after-restart-fixed.png`。

## 验证边界

- PASS：五个会话工具在真实 ToolRuntime 中注册；创建、查看、修改、删除、读取历史，以及 Shell/Agent approval gate 均由集成测试覆盖。
- PASS：连续执行、重启持久化、旧 `lastRun` 迁移、去重、按上限裁剪，以及执行期间任务修订所产生的 aborted 记录均由自动化测试覆盖。
- NOT RUN：本轮没有额外创建真实高频任务来累积多条现场历史，避免改动用户正在验证的 3 个任务；现场已验证旧数据迁移和重启后的持久化结构，多次执行展示由自动化组件测试覆盖。
- NOT RUN：本轮未调用真实模型 API，因此没有把受控 Agent lifecycle 覆盖描述成一次真实 LLM/Chrome 执行。
- NOT RUN：未实际弹出 macOS 桌面通知，避免制造用户侧通知；通知命令生成、转义、Shell 路由和失败记录由自动化测试覆盖。
- NOT RUN：Linux `notify-send` 与 Windows NotifyIcon 没有在对应操作系统宿主上做端到端验证。
- NOT RUN：多进程部署不在支持范围；插件明确只支持单 Host 调度。
