# AGENTS.md

This repository is the independently released `dsh-b2us-schedule` out-of-tree plugin for DeepSeek Harness. When checked out inside the integration workspace, the parent `../AGENTS.md` also applies. This file keeps the repository safe when it is opened alone.

## Product boundary

- The plugin owns schedule definitions, occurrence calculation, bounded history, reconciliation, DSH settings persistence, Shell/Agent/notification actions, tools, and its Web management surface.
- DeepSeek Harness owns Agent, Session, Workspace, preset/default-model resolution, Shell providers, approval, permission, sandbox, profile, and settings-service semantics. Reuse public services; do not duplicate or bypass them.
- The Electron shell may package and launch this plugin but must not implement scheduler behavior.
- Delivery is at-least-once. Never describe a normal Agent turn completion, Shell exit, or notification command as proof that an external business outcome succeeded.

## Package and development constraints

- Keep this an independent npm package and Git repository. Never require a sibling `deepseek-harness` source checkout at runtime or publish relative imports into it.
- Use only declared public DSH/Cordis exports at the exact compatible versions in `package.json`. Update the integration compatibility baseline when those versions change.
- Keep strict TypeScript and ESM. Scheduling domain logic, persistence/history, Shell/Agent actions, notification adapters, tools, Web client, and packaging must remain separately testable.
- Run commands and notifications only through the selected DSH Shell capability. Do not call `child_process` as a parallel execution policy.
- An unattended occurrence cannot request interactive elevation. Preserve DSH approval when creating/enabling privileged work and record later sandbox or permission rejection as a visible failure.
- All timers, listeners, in-flight Shell work, Agent turns, and Web contributions require lifecycle disposal. Reconcile state deterministically after load, update, restart, disable, delete, and unload.
- Validate cron/time-zone/absolute-time/interval inputs, durable data, action payloads, byte limits, timeouts, and renderer input at their actual trust boundaries.
- Deployment-varying values belong in the validated `Config` and complete `cordis.patch.yml` row. Do not hide operational tunables in constants.
- Update README, architecture, security, development, verification notes, schemas, and user-facing locale strings with the behavior they describe.

## Testing constraints

- Run focused tests while developing. Before handoff run `npm run check`.
- Keep `npm run check` covering type checking, unit/integration behavior, coverage, built Host/Web output, and packed-package tests.
- Every bug fix adds a regression test. Test occurrence boundaries, time zones, missed-run policy, concurrent due order, persistence recovery, bounded history, cancellation, timeout, cleanup, and invalid durable data where affected.
- Verify the packed tarball contains Host and invariant entries, Web client, type declarations, source maps, `cordis.patch.yml`, and docs. Source-tree success is insufficient.
- Keep timing tests deterministic; use controlled clocks for calculation tests. A controlled-clock test does not replace a real occurrence acceptance check.
- Never weaken assertions, coverage, sandbox/approval behavior, or persistence checks to obtain a passing gate.

## Acceptance constraints

1. Pack the plugin and install that `.tgz` into a fresh DSH Web profile at the exact supported Harness version.
2. Verify package discovery, Cordis/invariant rows, Web client/settings page, tool catalog, and clean Host shutdown from the installed package.
3. Install `dsh-auto-chrome-tool` into the same profile and verify ids, routes, settings, config, tools, and lifecycle coexist.
4. Exercise create, update, enable/disable, delete, next occurrence, actual trigger, bounded history, restart recovery, and cleanup.
5. Exercise Shell, Agent, and notification actions separately. Verify approval before unattended privileged work, denial, cancellation, timeout, sandbox rejection, and honest result reporting.
6. For Agent actions, verify fresh top-level Session creation, cwd/workspace matching, preset/default-model resolution, persisted Session linkage, and timeout cleanup.
7. Complete Windows PowerShell/notification acceptance on Windows; POSIX results are not substitutes. Record missing desktop-session notification support as a visible external limitation.
8. Record DSH/plugin versions, platform, commands, automated versus live/platform layer, and remaining limitations. Remove secrets, command-sensitive output, user data, and machine-specific absolute paths from retained reports.

## Repository hygiene

- Do not commit `node_modules/`, `lib/`, coverage, `output/`, `.playwright-cli/`, logs, archives, isolated DSH homes, or secrets.
- Inspect `git status` before edits and before commits. Preserve unrelated changes. Do not commit, tag, publish, push, force-push, or rewrite history unless explicitly requested.
