# dsh-b2us-schedule

**English** | [简体中文](README.zh-CN.md)

Durable scheduled Agent, shell, and desktop-notification tasks for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/DeepSeek-Harness), with both conversational tools and a dedicated Web management page.

> [!IMPORTANT]
> The scheduler provides **at-least-once** delivery. A successful shell exit or completed Agent turn confirms only the local execution result; it does not prove that an external business outcome succeeded.

## Overview

`dsh-b2us-schedule` combines a Host plugin and a Web client in one installable package. An Agent can create and manage schedules through five typed tools, while users can manage the same durable tasks from **Settings → Plugins → Scheduled Tasks**.

The npm package and Web module are named `dsh-b2us-schedule`. Stable runtime identifiers remain unchanged for compatibility: the Cordis row and Settings namespace are `auto-schedule`, and the conversation tools keep the `auto_schedule_` prefix.

## Rename and compatibility

`dsh-b2us-schedule` is the new package and repository name for the former `dsh-auto-schedule`. The durable Settings namespace, Cordis row id, tool names, and task schema deliberately remain stable so an existing data document does not need a schema rewrite.

When migrating an existing Profile, back it up and replace the old package reference with the new package. Do not load both package names in the same Profile: they intentionally declare the same `auto-schedule` Cordis row and Settings namespace.

### Harness 0.1.2-rc.1 compatibility

Version `0.3.3` raises every DSH peer from `0.1.2-alpha.2` to `0.1.2-rc.1` and follows the public Session snapshot API after the live event array became private. The durable task schema, Cordis row, Settings namespace, tool names, and Web route are unchanged.

This upgrade intentionally removes the package's former `./invariant` export. It was an empty companion and Harness `0.1.2-rc.1` no longer permits invariant packages without an independently observable runtime relationship. Consumers that imported `dsh-b2us-schedule/invariant` must remove that row or import; ordinary plugin installation through `cordis.patch.yml` is unchanged.

## Highlights

- **Four schedule types:** Cron, one-shot delay, absolute time with an explicit UTC offset, and fixed interval.
- **Three action types:** a fresh top-level DSH Agent Session, a shell command or script, and a native desktop notification.
- **Two management surfaces:** typed conversation tools and a localized Web settings page.
- **Durable state:** task definitions, runtime state, and bounded run history are stored in the DSH Settings service and restored after restart.
- **Controlled recovery:** a missed one-shot task runs once after restart; a missed Cron or interval schedule catches up at most once before advancing to its next future occurrence.
- **Lifecycle cleanup:** unload, disable, delete, and execution-definition changes cancel affected timers or active work through DSH lifecycle signals.
- **Honest execution records:** outcomes, exit codes, bounded output, errors, timeouts, sandbox denial, and Agent Session links are retained per occurrence.

## Scheduling model

| Type | Input | Behavior |
|---|---|---|
| Cron | `cron_expression` and optional `time_zone` | Croner-compatible 5-, 6-, or 7-field expression with an IANA time zone |
| Delay | `after_seconds` | Runs once after a positive delay measured from creation or an execution-definition update |
| Absolute time | `at` | Runs once at a future ISO date-time containing `Z` or a numeric UTC offset; stored as UTC |
| Fixed interval | `every_seconds` | Repeats from the latest execution-definition update and skips intermediate missed occurrences |

Cron and fixed-interval schedules must respect `minIntervalSeconds`. The default is 1 second; production deployments should raise it when high-frequency work is not appropriate. Due tasks are executed serially in scheduled-time order within one Host process.

## Actions

### Fresh Agent Session

Every Agent occurrence creates a new top-level DSH Agent and Session:

1. The task working directory is used when supplied; otherwise the Host default is preserved.
2. If the resolved Session path exactly matches an existing DSH workspace, the Session is attached to that workspace. The plugin never guesses by display name or creates a workspace automatically.
3. The requested Agent preset is used, or the effective DSH default is resolved at execution time.
4. The effective default model and reasoning effort are installed, and the task prompt is delivered as a normal user turn.
5. The plugin waits for completion, cancellation, or timeout, flushes the Session, and releases the live Agent.
6. The run record retains the Session id and effective preset so the full cold Session can be opened from the Web page.

Recurring tasks therefore do not accumulate context in one Agent. The scheduler is currently global and serial: another due shell or Agent action starts only after the active occurrence finishes.

An Agent outcome of `succeeded` means the turn ended with `completed`. Task prompts should explicitly require final-state verification and an evidence path when the real goal is an external result such as a website check-in or generated file.

### Shell command or script

The plugin never calls Node.js `child_process` directly and does not copy `tool-bash`. It resolves and runs every command through `ctx.shell`, so the selected DSH ShellExecutor continues to own the working directory, environment cleanup, output limits, timeout caps, and sandbox policy.

- POSIX hosts normally use the DSH Bash executor.
- Windows hosts normally use the DSH PowerShell executor.
- A sandbox rejection is recorded as a failure; a scheduled occurrence never requests automatic elevation.

### Desktop notification

Notifications also run through the active DSH ShellExecutor:

| Platform | Adapter |
|---|---|
| macOS | `/usr/bin/osascript` |
| Linux | `notify-send` (must be installed and available to the desktop session) |
| Windows | PowerShell with `System.Windows.Forms.NotifyIcon` |

Missing desktop sessions, permissions, executables, or sandbox access produce visible failures rather than synthetic success.

## Conversation tools

| Tool | Purpose |
|---|---|
| `auto_schedule_create` | Create a durable schedule and action |
| `auto_schedule_update` | Change, enable, or disable a task by its exact id |
| `auto_schedule_list` | List tasks with compact next-run and latest-result projections |
| `auto_schedule_history` | Read bounded execution history and output for one task |
| `auto_schedule_delete` | Delete a task and its associated runtime history |

Example requests:

- “Run `./scripts/backup.sh` in `/srv/app` ten minutes from now.”
- “At 9:00 every day in `Asia/Shanghai`, send a desktop notification reminding me to review the daily report.”
- “At 8:00 every day, start a fresh main Agent in `/Users/me/tests`, use the default preset, and time out after 15 minutes.”
- “Disable the task I just created.”
- “List every scheduled task and its next occurrence.”

Always use the exact task id returned by the tool when updating or deleting a task.

## Web management

After the Web profile restarts with the plugin installed, open **Settings → Plugins → Scheduled Tasks**. The localized page supports:

- creating and editing schedules and actions;
- enabling, disabling, and deleting tasks;
- inspecting the next occurrence and latest state;
- expanding bounded execution history;
- opening the persisted Agent Session associated with an Agent occurrence;
- revision-conflict detection and refresh instead of silent overwrite.

Saving an enabled shell or Agent task from the Web page requires an explicit unattended-execution confirmation.

## Quick start

### Requirements

- Node.js `^22.19.0 || >=24.0.0`
- DeepSeek Harness `0.1.2-rc.1`
- Cordis `4.0.2`

The exact DSH and Cordis peer versions are declared in `package.json`.

### Build and verify

```bash
npm install
npm run check
```

`npm run check` runs strict type checking, behavior tests, coverage gates, the production build, and built-package/packaging tests.

### Pack and install

```bash
npm run build
npm pack
dsh plugin --profile web add ./dsh-b2us-schedule-0.3.3.tgz
dsh --profile web --dump-config
```

The tarball bundles the `croner` runtime dependency, so it can be installed into a fresh Profile without accessing the npm registry. DSH and Cordis remain Host-provided peer dependencies and are not duplicated inside the package.

The package declares both `dsh.bundle.patch` and `dsh.client`. Installing it adds the Host row and lets the Web profile discover the client from the same package; no DeepSeek Harness source change or rebuild is required.

## Persistence and recovery

The `auto-schedule` Settings namespace separates user-owned and Host-owned data:

- `tasks[]` contains schedule definitions managed by the Web page and conversation tools.
- `runtime[]` contains next-run state, the latest result, and newest-first bounded history managed by the Host scheduler.
- `revision` changes for every edit; `executionRevision` changes only when enablement, timing, or the action changes.

Each task retains up to `maxHistoryEntriesPerTask` results (default 50, allowed range 1–1000). `auto_schedule_list` exposes only the latest result and history count; use `auto_schedule_history` to fetch detailed records without expanding ordinary model context indefinitely.

Delivery is at-least-once. If the Host crashes after an action finishes but before runtime state is persisted, that occurrence may run again after restart. Commands with external effects must provide their own idempotency key, lock, or transaction protection.

## Configuration

The package-owned `cordis.patch.yml` supplies a complete default row:

| Field | Default | Purpose |
|---|---:|---|
| `allowShellActions` | `true` | Allow shell schedules |
| `allowAgentActions` | `true` | Allow fresh-Agent schedules |
| `defaultTimeZone` | `UTC` | Time zone used when a Cron task omits one |
| `minIntervalSeconds` | `1` | Minimum Cron cadence and fixed interval |
| `maxHistoryEntriesPerTask` | `50` | Newest-first retained results per task; maximum 1000 |
| `maxShellTimeoutMs` | `600000` | Host policy cap for one shell action |
| `defaultAgentTimeoutMs` | `900000` | Default Agent occurrence timeout |
| `maxAgentTimeoutMs` | `3600000` | Maximum Agent occurrence timeout |
| `maxAgentPromptBytes` | `65536` | Maximum UTF-8 Agent prompt size |
| `shellOutputMaxBytes` | `16384` | Persisted stdout/stderr budget |
| `maxCommandBytes` | `32768` | Maximum UTF-8 shell command size |
| `maxNotificationBytes` | `8192` | Maximum UTF-8 notification payload size |
| `notificationTimeoutMs` | `15000` | Notification adapter timeout |
| `schedulerRetryMs` | `5000` | Delay before retrying a failed scheduler drive |

DSH patch overrides replace the complete config object rather than deep-merging it. When changing `defaultTimeZone` to a local zone such as `Asia/Shanghai`, preserve every other field your deployment still needs.

## Approval and security model

Scheduled shell and Agent actions are durable unattended authority, so the plugin keeps creation-time approval separate from execution-time policy:

1. Creating, enabling, or materially changing an active shell or Agent task through conversation tools returns the standard DSH `ask` decision before storage.
2. At occurrence time, shell work remains confined by the active ShellExecutor. A timer cannot open an interactive privilege-elevation flow.
3. A scheduled Agent inherits its preset, model, tools, permission rules, and ordinary tool approvals. The plugin does not approve those tools on the Agent's behalf.
4. Web edits use direct-user confirmation, while the Host still validates the complete Settings document and policy limits.

Do not turn commands or Agent prompts copied from untrusted web pages, email, or tool output into persistent unattended tasks without reviewing them. Avoid printing credentials because bounded stdout and stderr are stored in run history until the task is deleted.

See [docs/SECURITY.md](docs/SECURITY.md) for the threat model and deployment guidance.

## Development commands

```bash
npm run typecheck
npm test
npm run test:coverage
npm run build
npm run test:built
npm pack --dry-run
```

Build outputs:

- `lib/index.js` — Host plugin
- `lib/client.js` — lazy-CJS Web client for `window.__ModuleLoader__`
- `lib/types/` — Host and client type declarations

Further reading:

- [Architecture](docs/ARCHITECTURE.md)
- [Security model](docs/SECURITY.md)
- [Development and test workflow](docs/DEVELOPMENT.md)
- [Recorded verification evidence](docs/VERIFICATION.md)

## Known limitations

- One Settings document must be scheduled by only one Host process; there is no distributed lease or leader election.
- Delivery is at-least-once, not exactly-once.
- The scheduler runs due actions serially rather than concurrently.
- Agent actions may incur model and external-tool costs on every occurrence.
- Tools requiring interactive approval can wait until an unattended Agent occurrence times out.
- Workspace association occurs only when the normalized Session path exactly matches an existing DSH workspace.
- Native notification availability still depends on the operating system, desktop session, permissions, and sandbox.
- Repository tests and controlled clocks do not replace real-occurrence, real-notification, Windows-native, paid/live API, or subjective Web UI acceptance.

## License

[MIT](LICENSE)
