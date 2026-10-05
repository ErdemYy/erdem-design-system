# Claude Code adapter

Lets Claude Code use the Erdem Design System and the project intelligence engine without loading either into every session. It is a **consumer**: rules live in `core/`, `ai/`, `platforms/` and the generic contract `adapters/GENERIC.md`; this adapter only says how Claude Code reaches them. Nothing Claude-specific exists outside `adapters/`.

Adapter version `0.1.0` · verified with Claude Code `2.1.288`, Node `24.19`, Windows 11 · requires Node 20+ · no dependencies.

## What it is

| Part | File | Cost | When it runs |
|---|---|---|---|
| **Skill `/erdem`** | `skill/SKILL.md` (+ `references/`, `scripts/erdem.mjs`) | description in every session (about 100 tokens); body only when invoked; references only when a step names them | Claude invokes it for UI, design, 3D, responsive, portfolio and design-system work, or you type `/erdem` |
| **SessionStart hook** (opt-in) | `hooks/session-start.mjs` | one line, about 35 tokens | every session start |
| **CLAUDE.md block** (opt-in) | `CLAUDE.md` (a managed block, 7 lines) | about 180 tokens, every session | every session, if installed |
| Installer, uninstaller, doctor | `scripts/` | none at runtime | on demand |

Everything is explicit: nothing is installed by running tests, and the real Claude configuration is never touched unless you run the installer.

## Install

```
node adapters/claude/scripts/install.mjs --dry-run            # see what would change
node adapters/claude/scripts/install.mjs                      # skill only (user scope)
node adapters/claude/scripts/install.mjs --hook --claude-md   # also the session-start line and the CLAUDE.md block
```

Works the same in PowerShell, cmd and Git Bash (Node scripts, forward-slash command strings). Useful options: `--scope project --project <dir>` (skill and CLAUDE.md in the project; the hook goes to the untracked `.claude/settings.local.json`), `--manual-only` (the skill runs only when you type `/erdem`), `--force` (overwrite adapter files you edited), `--claude-dir <dir>` (use another directory, for testing), `--json`. Start a new Claude Code session afterwards.

The installer is idempotent, merges next to existing hooks, backs up `settings.json` before changing it (`settings.json.erdem-backup-<timestamp>`), and stops without changing anything if a conflict could lose data (a foreign skill folder named `erdem`, settings that are not valid JSON, unbalanced markers).

Where things go:

| What | User scope | Project scope |
|---|---|---|
| Skill | `~/.claude/skills/erdem/` | `<project>/.claude/skills/erdem/` |
| Hook | `<claude config dir>/settings.json` | `<project>/.claude/settings.local.json` |
| CLAUDE.md block | `<claude config dir>/CLAUDE.md` | `<project>/CLAUDE.md` |
| Adapter config (user-owned) | `<claude config dir>/erdem-adapter/config.json` | `<project>/.claude/erdem-adapter.json` (optional) |
| Ledger (what was installed) | `<claude config dir>/erdem-adapter/install.json` | `<project>/.claude/erdem-adapter-install.json` |

`<claude config dir>` is `CLAUDE_CONFIG_DIR` if set, otherwise `~/.claude`. Personal skills are always read from `~/.claude/skills` (per the Claude Code documentation). Project scope writes machine-specific paths: keep `.claude/settings.local.json` and `.claude/erdem-adapter-install.json` out of version control.

## Uninstall

```
node adapters/claude/scripts/uninstall.mjs --dry-run
node adapters/claude/scripts/uninstall.mjs [--purge-config]
```

Removes only what the adapter installed. Ownership is proven by an owner file inside the skill folder, the marker `ERDEM_DESIGN_SYSTEM_CLAUDE_ADAPTER` plus a ledger entry for the hook, and the marker pair plus a ledger entry for the CLAUDE.md block. Anything ambiguous (a marker with no ledger entry, edited files, other files in the skill folder, unbalanced markers) is reported and left alone. Files the installer created are removed again; files that existed are restored to their previous content. Your adapter config is kept unless `--purge-config`.

## Doctor

```
node adapters/claude/scripts/doctor.mjs [--json] [--scope project --project <dir>]
```

Read-only. Checks Node, Claude Code and its version, configuration validity, design-system discovery, `project-intel`, the installed skill (intact, owned, link target exists), the hook (registered, script exists, ledger entry, hooks not disabled), other SessionStart hooks (counted, never modified), and write permission. Prints no environment values or settings contents. Exit `1` only for failures.

## Configuration

No source edits are needed. Precedence, highest first: environment variables, project file `.claude/erdem-adapter.json`, user file `erdem-adapter/config.json`, defaults. The installer creates the user file once and never rewrites it.

| Key | Environment variable | Default | Meaning |
|---|---|---|---|
| `designSystemRoot` | `ERDEM_DESIGN_SYSTEM_ROOT` | `null` | checkout or installation of the design system; a relative path in a project file is a project-local copy |
| `autoStatus` | `ERDEM_AUTO_STATUS` | `light` | session-start check: `off`, `light` (no content reads), `verify` (time-boxed real `project-intel status`) |
| `autoSkill` | `ERDEM_AUTO_SKILL` | `true` | `false` installs the skill for explicit `/erdem` only |
| `autoSessionHandoff` | `ERDEM_AUTO_HANDOFF` | `false` | `true` adds `handoff-on-finish` to the session-start line |
| `projectIntelCommand` | `ERDEM_PROJECT_INTEL` | `null` | command (string or array); default is the engine in the design-system root, run with the current `node` |
| `preferredProfile` | `ERDEM_PREFERRED_PROFILE` | `auto` | index profile used when refreshing |
| `hookWhenUnavailable` | none | `line` | `silent` prints nothing when no `.ai/` index exists (state `missing`); the key keeps its original name |

Design-system discovery order: `ERDEM_DESIGN_SYSTEM_ROOT`, then `designSystemRoot` from the config (project, then user), then the root recorded at install time, then the checkout containing this adapter, then none (everything degrades gracefully). A candidate counts only if its `system-manifest.yaml` names `erdem-design-system`. No machine-specific path is stored in the repository.

Invalid configuration never breaks a session: the hook prints one fixed line and the doctor names the key.

## The skill

`/erdem [design|review|context|handoff] [request]`

- **design** (default for building or changing): locate the system, check status, classify the task (`ai/TASK_ROUTING.md`), load only the matching rows of `skill/references/design-routing.md`, expand context progressively, change within scope, validate, update task state.
- **review**: read-only critique against the design system with severity (CRITICAL, HIGH, MEDIUM, LOW), evidence, rule, rule status (verified, approved, proposed, standard, recommendation, preference) and a suggested fix; no edits unless you ask. Details in `references/claude-workflow.md`.
- **context**: runs the compact diagnostic and stops (intelligence, graph, task state, handoff, profile, design-system availability).
- **handoff**: writes `.ai/TASK_STATE.md` and a short `.ai/HANDOFF.md` for a meaningful transition only.

The description is deliberately narrow so the skill does not trigger for backend, database, shell, build or unrelated documentation tasks. References: `design-routing.md` (which design documents per task), `context-routing.md` (which `ai/` document when, the tooling commands), `claude-workflow.md` (Claude mechanics, review format, memory scopes), `troubleshooting.md`.

`scripts/erdem.mjs` (bundled launcher) finds the adapter without an absolute path in the skill text and runs `context`, `root` or `intel <project-intel arguments>`.

## The SessionStart hook

One line, for example:

```
ERDEM: system=found intelligence=present(standard, 2d old) graph=present task=in-progress handoff=present (unverified; /erdem context to check)
```

It never prints the index, task state, graph or tokens, never rebuilds anything, never blocks (exit 0 on every path), and never assumes `project-intel` exists. Default `light` mode reads only the first bytes of `.ai/AI_INDEX.md`, `TASK_STATE.md` and `HANDOFF.md`, checks that the graph file exists, and runs one time-boxed `git status` to see whether working-tree files are newer than the index ("likely-stale" is a hint, not verification). `verify` runs the engine's real `status` within a time budget (it re-hashes sources, so it costs more on large projects). Only fixed words, numbers, ISO dates and enumerated values reach the output; free text from repository files (for example a task state's owner field) is never echoed, so repository content cannot inject instructions into the session.

**Words in the line.** In the default light mode `present` and `likely-stale` are hints (an index exists; files are newer than it), always followed by `(unverified; ...)`; `missing` is the one canonical state light mode can establish (no index). With `autoStatus: verify` the line carries the canonical session state from `project-intel status`: `current`, `stale`, `unverifiable` (shown as `unverifiable(caution: provisional)`), `partial` or `missing`; a status that cannot run or times out is `unavailable` and the line falls back to the light hint. The states and how they are derived are defined once in `adapters/GENERIC.md` section 3.

Registered as a separate matcher group in `hooks.SessionStart`, with `timeout: 5` (seconds) and the ownership marker `--erdem-owner=ERDEM_DESIGN_SYSTEM_CLAUDE_ADAPTER` in the command.

### Manual hook integration

If you prefer not to let the installer edit `settings.json` (or it reported a conflict), add this group to the `SessionStart` array of the settings file yourself, next to your existing groups, using the checkout's absolute path with forward slashes:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "node \"C:/path/to/erdem-design-system/adapters/claude/hooks/session-start.mjs\" --erdem-owner=ERDEM_DESIGN_SYSTEM_CLAUDE_ADAPTER", "timeout": 5 } ] }
    ]
  }
}
```

Keep any existing `SessionStart` groups and any other event keys as they are. Without the ledger the uninstaller will refuse to remove a hand-added hook; delete it by hand.

## Auto memory, preferences, rules

Three scopes stay separate: Claude's own auto memory (personal learnings), project state (`.ai/` and the project's files), and Erdem rules (this repository). The adapter tells Claude not to copy repository facts into auto memory. Personal preferences belong in user-level Claude configuration, never in a project. Path-scoped `.claude/rules` are **not** generated: the skill plus selective references already avoids loading design context for unrelated work; the optional strategy is described in `skill/references/claude-workflow.md`.

## Compatibility

Verified against Claude Code 2.1.288 using the documented formats (SessionStart hook settings with `timeout` in seconds, plain-stdout context, skill front matter, `${CLAUDE_SKILL_DIR}`, `$ARGUMENTS`). Other versions are untested; the doctor reports a version difference. The adapter relies on: skills with `description`, `argument-hint`, `allowed-tools` and optional `disable-model-invocation`; `hooks.SessionStart`; CLAUDE.md loading. If a capability is missing the corresponding part simply does not engage and the protocol still works without it (`adapters/GENERIC.md` §9).

## Limitations

- The installed hook and skill link point to this checkout; moving or deleting it requires re-running the installer (the doctor detects it).
- The light status is a hint based on file times and `git status`; commits pulled after the index was generated are not detected until `verify` mode or `/erdem context`.
- A real Claude Code smoke test (`tests/smoke-claude.mjs`) makes one small model call and is run by hand, not by the test suite; behavior of the model, such as whether it invokes the skill automatically, is not guaranteed.
- Running the smoke test leaves one small Claude-owned entry per run under `~/.claude/projects/` for the throwaway directory; the script does not touch it.
- Dependency analysis in the engine covers JavaScript and TypeScript only.
- Rewriting `settings.json` re-serializes it with two-space indentation (a backup is kept).

## Tests

```
node adapters/claude/tests/run-tests.mjs      # 54 tests; also proves the real Claude configuration was not modified
node adapters/claude/tests/smoke-claude.mjs   # manual: real Claude Code, throwaway project, one small call
```

They use temporary directories only, run the real hook and scripts as subprocesses with an isolated home, and cover install, repeat install, uninstall, existing config and hooks, dry run, missing project-intel, current and stale intelligence, invalid config, missing design system, Windows quoting, secrets, and context cost.
