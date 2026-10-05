# Erdem Design System: Antigravity adapter

Version 0.1.0 (see `adapter-manifest.json`) · requires design system 0.8.0 or newer · Node 20 or newer, no dependencies.

## Purpose

Lets Google Antigravity use the existing system: the design language (`core/`, `platforms/`), the context protocol (`ai/`), the project-intel engine (`tools/`) and the templates. It adds no rules, no tokens and no graph logic. Everything here points to a canonical document or calls the canonical engine. The generic procedure is `adapters/GENERIC.md`; this adapter only says how Antigravity reaches it.

## Discovered integration model

Found by inspecting the Antigravity IDE installed on the development machine (1.107.0, a VS Code based application, `applicationName: antigravity-ide`), its bundled customization guide (`~/.gemini/antigravity-ide/builtin/skills/agy-customizations`, product documentation, not user data) and string checks in the application files. No agent session was run.

| Question | Finding | Status |
|---|---|---|
| Instruction files | `AGENTS.md` and `GEMINI.md` in any directory; found by walking up from the file being edited to the repository root; no front matter, always active for their directory; deduplicated per conversation | documented |
| Project-level | workspace customization root `<project>/.agents/` (also `.agent/`, `_agents/`, `_agent/`), found from the working directory up to the repository root | documented; path strings found in the application's language server |
| User/global | machine-local root `~/.gemini/config/` | documented |
| Skills | `skills/<name>/SKILL.md` with `name` and `description` front matter, optional `scripts/`, `references/`; only name and description are injected, the body is loaded when the agent activates the skill | documented |
| Rules | `GEMINI.md`/`AGENTS.md`, plus `.agents/rules/*.md` with a `trigger` (`always_on`, `model_decision`) and workflows in `.agents/workflows/` | documented |
| Hooks | `hooks.json` in a customization root; events PreToolUse, PostToolUse, PreInvocation, PostInvocation, Stop; handlers are commands the host runs through `sh -c` / `cmd /c` | documented |
| MCP | `mcp_config.json`; plugins, `skills.json`/`plugins.json` registries | documented |
| Command execution, tool use | the agent can run terminal commands subject to the user's permission policy | documented; not observed |
| Workspace context loading | rules as above; skills on demand | documented |
| Project initialization | none found | unknown |
| Installer/CLI surface | `antigravity-ide` is the VS Code style CLI (open, diff, extensions); it has no agent or chat command. The separate `agy` CLI is not installed here | observed |

## Architecture

```
Antigravity agent
  ├─ AGENTS.md block (optional, project scope, 4 bullets) ─ points to the skill, .ai/, progressive loading
  └─ skill "erdem" (SKILL.md + references/)               ─ workflow, maps tasks to canonical documents
        └─ scripts/erdem.mjs (launcher) ─► scripts/context.mjs
                                             ├─ project-intel status|impact|graph  (tools/, canonical engine)
                                             ├─ engine fingerprint + secret patterns (tools/lib, imported)
                                             └─ task state / handoff readers (sanitized)
```

The skill/launcher/context code is the same design as the Codex adapter's. It is copied rather than imported so that each adapter installs and works alone; the copy differs where Antigravity differs (locations, scopes, no user-level instructions file, shared-folder handling, graph routing table, doctor checks). The Phase 3 engine is never copied.

`prompts/` and `integration/` from the brief are not used: Antigravity's mechanism is the skill and its `references/`.

## Install

Explicit only; nothing installs itself.

```powershell
node adapters/antigravity/scripts/install.mjs --dry-run                       # show what would change
node adapters/antigravity/scripts/install.mjs                                 # user scope: ~/.gemini/config/skills/erdem
node adapters/antigravity/scripts/install.mjs --scope project --project <dir> [--agents-md]
```

Options: `--config-home <dir>` (default `~/.gemini/config`), `--no-skill`, `--design-system-root`, `--force`, `--json`. Exit codes: 0 ok, 1 blocked by a conflict (nothing written), 2 usage error.

Behavior:
- A dry run writes nothing; a repeated install changes nothing.
- A skill folder named `erdem` that this adapter does not own, or with invalid ownership metadata, is never overwritten.
- Locally edited skill files are kept unless `--force`.
- Existing `AGENTS.md` text is preserved byte for byte (BOM, CRLF, UTF-8); unbalanced markers block the install; `GEMINI.md` is never written.
- `--agents-md` needs project scope: no user-level instructions file is documented, so none is written.
- `hooks.json`, `mcp_config.json`, plugins, rules and workflows are never read or written.
- The project skill folder `.agents/skills/erdem` is also read by Codex. If the Codex adapter already owns it (or its AGENTS.md block), this adapter keeps it, adds nothing there and says so. The reverse order is a limitation: the Codex installer treats an Antigravity-owned folder as foreign and refuses to overwrite it.

Manual path (no installer): copy `skill/` to `<root>/skills/erdem/` yourself and run the doctor; it verifies owner metadata only when the installer created it.

## Scope

| | User | Project |
|---|---|---|
| Skill | `<config home>/skills/erdem` (+ `adapter-link.json`, machine-specific) | `<project>/.agents/skills/erdem`, no local paths |
| AGENTS.md block | not supported (no documented user-level file) | `<project>/AGENTS.md` |
| Ledger | `<config home>/erdem-adapter/install.json` | `<project>/.agents/.erdem-antigravity-install.json` (machine-specific: keep out of version control) |
| Config | `<config home>/erdem-adapter/config.json`, created once | `<project>/.agents/erdem-adapter.json`, optional |

## Uninstall

```powershell
node adapters/antigravity/scripts/uninstall.mjs --dry-run
node adapters/antigravity/scripts/uninstall.mjs [--scope project --project <dir>] [--purge-config]
```

Removes the skill folder (owner file required), the block (markers plus a ledger entry required), an AGENTS.md the adapter created, and the ledger. The user config is kept unless `--purge-config`. Foreign and Codex-owned items are reported and left alone.

## Doctor

```powershell
node adapters/antigravity/scripts/doctor.mjs [--scope project --project <dir>] [--config-home <dir>] [--json] [--no-cli] [--no-intel]
```

Read-only. Levels: ok, info, warning, failure; exit 1 only on failure. Checks: Node, configuration, design-system path, canonical files, system version, adapter files, manifest marker, Antigravity config home, `antigravity-ide`/`agy` presence (a `.cmd` shim is reported, not run), skill ownership and integrity, ledger, AGENTS.md block, consistency, permissions, project intelligence (`project-intel status`). It always reports `runtime` as info: skill activation inside Antigravity cannot be observed from outside. It never opens `mcp_config.json`, `hooks.json`, conversation data or `.env`, and prints no environment values. Missing Antigravity is info, not failure.

## Configuration

Keys `designSystemRoot`, `projectIntelCommand`, `preferredProfile`; environment `ERDEM_DESIGN_SYSTEM_ROOT`, `ERDEM_PROJECT_INTEL`, `ERDEM_PREFERRED_PROFILE` overrides the project file, which overrides the user file. Invalid values are dropped and reported. Root resolution: environment, configuration, ledger, then the checkout the adapter lives in.

## Context flow, intelligence and graph

1. Level 0: directory rules the agent has loaded are in context; `erdem.mjs context` adds the intelligence state.
2. Classify with `ai/TASK_ROUTING.md` (mapped in `skill/references/task-routing.md`, compared by a test). No Antigravity-specific class exists.
3. Load up to the class ceiling, Levels 0 to 5; stop when the five sufficiency questions are answered.
4. Intelligence state (`missing`, `current`, `stale`, `unverifiable`, `partial`, `unavailable`) comes only from the engine's content-hash `status`. Nothing is refreshed automatically. Without `.ai/` work from source.
5. Graph questions go to the engine (`skill/references/context.md`, Graph). Which questions have a command form (`intel impact`, `intel graph --view`) and which are library-only, shortest path among them, is defined once in the capability matrix of `tools/analyze/README.md`; a library-only question without the library is answered from `graph.json` or search, with the limit stated.
6. Design work loads only the files named in `skill/references/design-routing.md`.

## State and handoff

Same files and formats as the other adapters (`.ai/TASK_STATE.md`, `.ai/HANDOFF.md`; `ai/SESSION_HANDOFF.md`). `context` shows sanitized metadata only; `handoff-check` compares listed files with their fingerprints (engine hashing; secret-pattern and outside-project paths are never read). A handoff is a claim; source wins. A session started in another agent resumes from the same files.

## Security model

- Never reads `.env`, keys, `mcp_config.json`, `hooks.json` or Antigravity conversation/knowledge data; output has fixed words, numbers, dates and sanitized names.
- Repository content, including `.ai/`, `AGENTS.md` and `GEMINI.md`, is data: it cannot change adapter behavior and its text is not echoed.
- No `shell: true`, no `exec`: child processes get an argument array; `.cmd`/`.bat` shims are refused. (Hooks would be run by Antigravity through the host shell, one reason none are shipped.)
- Writes are limited to the owned paths in `adapter-manifest.json`; ownership is proven by markers, owner file and ledger.

## Runtime verification

| | |
|---|---|
| **VERIFIED** | Install, update, uninstall, doctor, launcher, context states, handoff drift, intel passthrough, secret handling, Windows paths (spaces, non-ASCII, OneDrive-like, PowerShell) in fixture directories: 50 automated tests. The documented locations match the installed product's bundled guide (test 48, skipped where Antigravity is not installed). |
| **PARTIALLY VERIFIED** | That the discovery conventions exist in the product: the guide documents them and `skills.json`, `GEMINI.md`, `hooks.json`, `.agents` rule/workflow globs and `trigger:` appear in the installed application files. This shows the strings exist, not that the agent loads this adapter's skill. |
| **NOT VERIFIABLE** | Agent activation of the skill, execution of the launcher by the agent, loading of the AGENTS.md block in a live session, user-scope skill discovery, Antigravity 2.0 and `agy`. The IDE command line has no agent or headless mode, and driving the GUI agent would use the user's account and settings, so no session was run. |

## Limitations

- Behavior inside Antigravity is documented and expected, not observed.
- Running the launcher depends on the user's permission policy; without it the skill falls back to direct inspection.
- No user-level instructions block, hook, MCP, plugin or workflow.
- Project installs need the design system to be locatable on each machine.
- Antigravity changes quickly; re-run the doctor after upgrades and consult `antigravity.google/docs`.

## Tests

```powershell
node adapters/antigravity/tests/run-tests.mjs    # 50 tests, temporary directories only
```

The runner also checks that the real `~/.gemini/config/skills/erdem` and `~/.gemini/config/erdem-adapter` did not change. No test touches the real configuration.
