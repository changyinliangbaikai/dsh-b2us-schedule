# 开发与测试

## 质量门禁

- `npm run typecheck`：严格 TypeScript，启用 `noUncheckedIndexedAccess` 与 `exactOptionalPropertyTypes`。
- `npm test`：纯领域、定时器、工具、真实 Cordis 生命周期、Client 组件与 Slot 组合测试。
- `npm run test:coverage`：V8 覆盖率门禁；当前最低 85% statements/functions/lines、75% branches。
- `npm run build`：先由 `tsc` 生成类型与可追踪中间文件，再由 tsdown 分别构建 Host、invariant 和 lazy-CJS Client。
- `npm run test:built`：普通 Node 加载发布入口，并检查 client factory、exports、bundle patch 与发布文件。
- `npm run check`：串行执行全部本地门禁。
- `npm pack --dry-run`：人工审阅发布清单，不把源码、测试、coverage 或开发依赖带入包，并确认 `croner` 作为 bundled dependency 进入离线 tarball。

## 测试分层

1. 纯逻辑：绝对时间规范化、Cron/时区、固定间隔跳过、命令转义、表单投影。
2. Scheduler：假时钟 + 假 ShellExecutor/Agent executor，覆盖一次性、周期、过期恢复、Session 历史、沙箱失败、取消与 unload。
3. Host composition：真实 Cordis `Context`、SettingsProvider、ToolRuntime、插件 fiber，验证五个工具、Settings 持久化和 disposer。
4. Client composition：JSDOM + 真实 SlotRegistry/LocaleRuntime，验证独立 tab 注册、响应式 Settings snapshot、CRUD 与卸载。
5. 发布产物：按包名自引用，确认无错误 default export；`lib/client.js` 必须注册准确 module id，CSS 必须内联。
6. Web E2E：临时 DSH home 安装 tarball，启动官方 Web profile，用浏览器打开设置页并记录桌面/窄屏快照。
7. Agent lifecycle：受控假 `ctx.agents`/`ctx.sessions`/`ctx.workspaceRegistry` 验证顶层创建、默认模型、预设挂载、按 cwd 复用已有工作区、prompt framing、flush、timeout 和 dispose；真实模型/浏览器调用单独列为人工验收，不能用 fake 冒充。

## 开发约束

- 所有注册必须由当前 Cordis fiber/effect 拥有，并提供 disposer。
- Client 不允许把 `ctx` 传进 React；数据只能走 Slot inject、selector hook 和 SettingsScope action。
- 不引入私有 DSH 源码路径。依赖精确锁定到已验证的公共 `0.1.2-alpha.2` 接口。
- 不用 `tool-bash` 或 ToolRuntime 伪造定时调用；命令执行只走 `ctx.shell`，Agent 只走 `ctx.agents.create` 和 `ctx.sessions.flush`。
- Settings 的 `tasks` 与 `runtime` 顶层字段必须分别写入，避免不同 owner 的整段替换。
- 每个修复都添加回归用例；不通过削弱断言或忽略失败让门禁变绿。

## 手工验收

1. 新建通知任务，确认下次时间与刷新后持久化。
2. 新建禁用 Shell 任务，启用时确认警告出现。
3. 会话中要求创建 Shell 任务，确认 DSH approval 出现，拒绝后没有任务落盘。
4. 在 `workspace-write` 下尝试访问工作区外，确认失败中带 sandbox denied，不出现二次审批。
5. 修改任务名称，确认 `executionRevision` 不变、下一时间不重置。
6. 修改规则或动作，确认 `executionRevision` 递增并重新计算。
7. 命令执行中删除任务，确认 AbortSignal 生效。
8. 重启 Host，确认未完成一次性任务补跑、周期任务不回放全部积压。
9. 连续触发同一任务至少三次，确认页面历史最新优先、输出可展开，刷新和重启后仍存在。
10. 将历史上限设为 2，连续触发三次，确认只保留最近两条；任务列表只返回 `historyCount`，历史工具可按 `limit` 读取。
11. 新建禁用的 Agent 任务，填写工作目录、预设与 prompt；启用时确认无人值守警告出现。
12. 触发 Agent 任务，确认生成新的顶层 Session；当工作目录已注册为 DSH 工作区时，会话进入该工作区而不是“未分组”；任务历史显示有效预设并能通过“打开会话”进入完整记录。
13. 对循环 Agent 任务连续触发两次，确认 Session id 不同、第二次不继承第一次上下文，且同一时刻的任务仍串行。
14. 触发 Chrome 验收示例，确认 Agent 能调用 `dsh-auto-chrome-tool`、从工作目录读取测试资料，并把截图写回该目录；将页面业务证据与 Agent 回合状态分开验收。
