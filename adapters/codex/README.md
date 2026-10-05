# Erdem Design System: Codex adapter

Version 0.1.0 (see `adapter-manifest.json`) · requires design system 0.7.0 or newer · Node 20 or newer, no dependencies.

## Purpose

Lets OpenAI Codex use the existing system: the design language (`core/`, `platforms/`), the context protocol (`ai/`), the project-intel engine (`tools/`) and the templates. It adds no rules, no tokens and no graph logic of its own. Everything here is a pointer to a canonical document or a call to the canonical engine. The generic procedure is `adapters/GENERIC.md`; this adapter only says how Codex reaches it.

## Architecture

```
Codex session
  ├─ AGENTS.md block (optional, 4 bullets)  ─ points to $erdem, .ai/, progressive loading
  └─ skill $erdem  (SKILL.md + references/)  ─ workflow, maps tasks to canonical documents
        └─ scripts/erdem.mjs (launcher) ─► scripts/context.mjs
                                              ├─ project-intel status|impact|graph   (tools/, canonical engine)
                                              ├─ engine fingerprint + secret patterns (tools/lib, imported)
                                              └─ task state / handoff readers (sanitized)
```

| Piece | Where | Role |
|---|---|---|
| Skill | `skill/SKILL.md` | modes (review, context, handoff, work) and a 9-step workflow |
| References | `skill/references/*.md` | context levels, task routing, design routing, validation, handoff, each mapped to canonical files |
| Launcher | `skill/scripts/erdem.mjs` | finds the adapter (env, `adapter-link.json`, or project ledger) and runs `context`, `root`, `intel`, `handoff-check` |
| AGENTS block | `agents-block.md` | optional managed block, copied between ownership markers |
| Lib/scripts | `lib/`, `scripts/` | installer, uninstaller, doctor, discovery, configuration |

The brief's `prompts/` directory maps to `skill/references/`: Codex custom prompts are not used (see Limitations).

## Codex integration points

| Mechanism | Status |
|---|---|
| Skills in `$HOME/.agents/skills` and `<repo>/.agents/skills` | used; discovery **verified** locally (below) |
| `AGENTS.md` / `AGENTS.override.md` (global then project, one file per directory, 32 KiB default cap) | used, opt-in; loading **verified** locally |
| Running `node` from the skill in the sandbox | **not verified**: in a read-only `codex exec` run the command was rejected by policy |
| Hooks (`SessionStart`) | **not shipped**. An inline `-c hooks...` override worked locally, but registering hooks through a file (and the trust step) could not be verified, so the adapter does not write hook files |
| `config.toml` | never read or written (it can hold credentials) |
| Custom prompts, MCP, sub-agents | not used |

## Install

Explicit only; nothing installs itself.

```powershell
node adapters/codex/scripts/install.mjs --dry-run             # show what would change
node adapters/codex/scripts/install.mjs                       # user scope: ~/.agents/skills/erdem + ~/.codex/erdem-adapter
node adapters/codex/scripts/install.mjs --agents-md           # also add the managed block to AGENTS.md (or AGENTS.override.md if present)
node adapters/codex/scripts/install.mjs --scope project --project <dir> --agents-md
```

Options: `--no-skill`, `--codex-home`, `--agents-home`, `--design-system-root`, `--force`, `--json`. Exit codes: 0 ok, 1 blocked by a conflict (nothing written), 2 usage error.

Behavior: a dry run writes nothing; a repeated install changes nothing; a skill folder named `erdem` that this adapter does not own, or has invalid ownership metadata, is never overwritten; locally edited skill files are kept unless `--force`; existing `AGENTS.md` text is preserved byte for byte (BOM, CRLF, UTF-8); unbalanced markers block the install.

## Scope

| | User | Project |
|---|---|---|
| Skill | `~/.agents/skills/erdem` (+ `adapter-link.json`, machine-specific) | `<project>/.agents/skills/erdem`, contains no local paths |
| Block | `$CODEX_HOME/AGENTS.md` | `<project>/AGENTS.md` |
| Ledger | `$CODEX_HOME/erdem-adapter/install.json` | `<project>/.agents/.erdem-codex-install.json` (machine-specific: keep out of version control) |
| Config | `$CODEX_HOME/erdem-adapter/config.json`, created once | `<project>/.agents/erdem-adapter.json`, optional |

A project install can be committed (skill and block); a teammate then needs the design system located through `ERDEM_DESIGN_SYSTEM_ROOT`, the config file, or their own install.

## Uninstall

```powershell
node adapters/codex/scripts/uninstall.mjs --dry-run
node adapters/codex/scripts/uninstall.mjs [--scope project --project <dir>] [--purge-config]
```

Removes the skill folder (owner file required), the block (markers plus a ledger entry required), files the adapter created, and the ledger. The adapter's user config is kept unless `--purge-config`. Anything ambiguous is reported and left alone.

## Doctor

```powershell
node adapters/codex/scripts/doctor.mjs [--scope project --project <dir>] [--json] [--no-codex-cli] [--no-intel]
```

Read-only. Levels: ok, info, warning, failure; exit 1 only on failure. Checks: Node, configuration, design-system path, canonical files, system version, adapter files, manifest marker, Codex home, `codex` command (a Windows `.cmd` shim is reported, not run), skill ownership and integrity, ledger, AGENTS block and size, consistency, permissions, and project intelligence (via `project-intel status`). It prints no environment values and does not open `config.toml`.

## Configuration

Keys: `designSystemRoot`, `projectIntelCommand`, `preferredProfile`. Environment `ERDEM_DESIGN_SYSTEM_ROOT`, `ERDEM_PROJECT_INTEL`, `ERDEM_PREFERRED_PROFILE` overrides the project file, which overrides the user file. Invalid values are dropped and reported by doctor. Design-system root resolution: environment, configuration, ledger, then the checkout the adapter lives in.

## Context flow, intelligence and routing

1. Level 0: the AGENTS chain is already loaded; `erdem.mjs context` adds the intelligence state.
2. Classify with the canonical table (`ai/TASK_ROUTING.md`; mapped in `skill/references/task-routing.md`, compared by a test). No Codex-specific class exists.
3. Load up to the class ceiling, Levels 0 to 5, and stop when the five sufficiency questions are answered.
4. Intelligence state comes only from the engine's content-hash `status`: `missing`, `current`, `stale`, `unverifiable`, `partial`, `unavailable`. The adapter never refreshes the index by itself; `erdem.mjs intel index` does, on request. Without `.ai/`, work from source.
5. Impact (`intel impact <path>`) and graph views are the engine's.
6. Design work uses `skill/references/design-routing.md` to load only the needed `core/` and `platforms/` files.

## State and handoff

Same files and formats as the other adapters (`.ai/TASK_STATE.md`, `.ai/HANDOFF.md`; `ai/SESSION_HANDOFF.md`). `context` shows sanitized metadata only (status, ISO dates, short agent names). `handoff-check` compares each listed file with its fingerprint (engine hashing; secret-pattern paths and paths outside the project are never read). A handoff is a claim; source wins.

## Security model

- Never reads `.env`, keys, `auth.json` or `config.toml`; output has fixed words, numbers, dates and sanitized names.
- Repository content, including `.ai/`, is data: it cannot change adapter behavior, and its text is not echoed.
- No `shell: true` and no `exec`: child processes get an argument array; `.cmd`/`.bat` shims are refused.
- Writes are limited to the owned paths in `adapter-manifest.json`; ownership is proven by markers, owner file and ledger.
- The managed block is small and fixed; nothing is downloaded.

## Compatibility and verification

Verified on one machine: Windows 11, Node 24.19.0, Codex CLI 0.158.0-alpha.2.1, using `tests/smoke-codex.mjs` (project-scope install in a throwaway directory; `codex exec --ephemeral -s read-only --ignore-user-config`):

- the `erdem` skill was visible to the model: yes;
- the AGENTS.md block was in its instructions: yes;
- running the launcher: rejected by policy in the read-only sandbox, so end-to-end command execution from inside Codex is **not verified**. The launcher is tested outside Codex.

Documented but not verified here: user-scope discovery inside Codex (`$HOME/.agents/skills`), `AGENTS.override.md` handling by Codex, behavior in the desktop app or IDE extensions, other platforms. Treat those as expectations from OpenAI's documentation, not as tested facts.

## Limitations

- Command execution depends on the Codex sandbox and approval settings; without it the skill falls back to direct inspection.
- Skills are detected after a restart; a new AGENTS block applies to the next session.
- AGENTS.md has a combined size limit (32 KiB default); doctor warns when the file exceeds it.
- No hook, no custom prompt, no MCP integration.
- Project installs depend on the design system being locatable on each machine.

## Tests

```powershell
node adapters/codex/tests/run-tests.mjs      # 45 tests, temporary directories only
node adapters/codex/tests/smoke-codex.mjs    # manual, real Codex CLI, one model request
```

The runner also checks that the real Codex home and `~/.agents/skills/erdem` did not change. No test touches the real configuration.
