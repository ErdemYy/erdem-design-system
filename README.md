# Erdem Design System

A reusable, tool-agnostic personal design and AI development system.

Version: see `VERSION` · Status: release 1.0.0 (Phase 6 real-world validation complete; Phase 5F session continuity and cross-agent handoff included) · Machine-readable summary: `system-manifest.yaml`

## What it is

Two systems in one repository that work together but never mix:

| System | Name | Folder | Answers |
|---|---|---|---|
| Design | Erdem Design System | `core/` | What should the product look and feel like? |
| AI | Erdem AI Development Protocol | `ai/` | How should an AI agent understand and change a software project? |

Two supporting layers connect them to the real world:

| Layer | Folder | Answers |
|---|---|---|
| Platforms | `platforms/` | How does the core design language adapt to a platform's constraints? |
| Adapters | `adapters/` | How does a specific AI coding tool consume this system? |

And two auxiliary folders: `templates/` (blank per-project documents) and `tools/` (future generators and validators), plus `examples/`.

## Why it exists

- A personal design language should survive across products, platforms and years.
- AI agents waste tokens re-reading projects and drift stylistically between sessions. A protocol for progressive context and explicit handoff fixes both.
- Tools change quickly. The knowledge should not be locked to one of them.

## Tool-agnostic philosophy

This is not a "Claude design system", "Codex design system" or "Antigravity design system". Knowledge lives once, in plain Markdown and YAML. Adapters (`adapters/`) only explain how a given agent locates and consumes it. **Core rules are never copied into adapters.** Any agent that can read files can use the system; no adapter is required (`adapters/GENERIC.md`).

## Source of truth

When sources conflict, the higher one wins:

1. Explicit project requirements
2. Project-local instructions
3. Erdem Design System core rules (`core/`)
4. Platform-specific rules (`platforms/`)
5. Agent-specific adapter rules (`adapters/`)
6. Examples (`examples/`)
7. Generic assumptions

Example: core prefers a dark theme, a project requires a light theme → the project requirement wins. Overrides must be recorded in the project's `DECISIONS.md` (see `templates/DECISIONS.md`). This hierarchy is defined only here; other files link to it.

This order answers what the product should do or look like. A separate order answers what is *true about a codebase* (source code over tests over documentation over indexes and summaries) and is defined in `ai/CONTEXT_PROTOCOL.md`. Design rules vs implementation rules are separated below.

## Design system (`core/`)

Defines the visual and interaction language: principles, tokens, typography, color, spacing, layout, motion, components, content, accessibility, quality. Chain: **reference → decision → token**.

- `core/EVIDENCE.md` – real references and measurements behind every value.
- `core/DESIGN_DECISIONS.md` – decision records and open questions.
- `core/DESIGN_TOKENS.md` – token contract: layers, naming, status policy, themes.
- `core/TOKEN_REGISTER.md` – **the only place token values live.**
- Guidelines (`TYPOGRAPHY`, `COLOR_SYSTEM`, …) explain usage and refer to tokens by name.

A value is official only if `verified` (observed in a real reference) or `approved` (decided by Erdem). Otherwise it is `proposed`, `unresolved` or `needs_reference` and is never invented. Start at `core/DESIGN_PRINCIPLES.md`.

**Design rule vs implementation rule.** A design rule states *what should feel true* ("motion is subtle and intentional"). An implementation rule states *how a platform achieves it* (CSS and GSAP on web, animation controllers on Flutter, Reanimated on React Native). Design rules live in `core/`; implementation rules live in `platforms/`. A platform file never redefines a design rule, only adapts it.

## AI development protocol (`ai/`)

Principles: read the smallest sufficient context; expand it progressively; source code is authoritative and indexes and summaries are navigation aids; do not re-read unchanged, unrelated information. The protocols are specifications; the reference implementation is `tools/` (project-intel: scan, index, graph, status, impact; Phase 3), and agent adapters consume them (`adapters/`). Automation of agent behavior is specified (`ai/AUTOMATION_PROTOCOL.md`); of it, automatic intelligence refresh, automatic context routing, automatic change impact and automatic validation orchestration are implemented (`tools/automation/`).

- **Context model** – six expansion levels (root orientation to architecture), a stopping rule, task classes and context scopes (`ai/CONTEXT_PROTOCOL.md`, `ai/TASK_ROUTING.md`).
- **Project indexing** – `AI_INDEX.md`, directory and file indexes, summaries, fingerprints and staleness states (`ai/INDEX_PROTOCOL.md`). Indexes guide navigation; code remains the truth.
- **Token efficiency** – search first, read regions, default skip rules, secrets and binaries policy (`ai/TOKEN_EFFICIENCY.md`). Reduces expected discovery work; savings are not guaranteed.
- **Change impact and graph** – impact dimensions, risk levels, public surfaces, and how a future graph is consumed (`ai/CHANGE_IMPACT.md`, `ai/GRAPH_PROTOCOL.md`).
- **Session state and handoff** – state lives in repository artifacts so any agent can continue another's work (`ai/SESSION_HANDOFF.md`).
- **Automation contract** – what an agent may do on its own, what needs a yes, what is never automatic; events, intelligence refresh rules, impact and validation triggers, state and handoff triggers (`ai/AUTOMATION_PROTOCOL.md`). Specification only: nothing runs automatically yet.
- **Safe modification and validation** – reuse before create, no unrelated refactors, size-proportional checks (`ai/SAFE_MODIFICATION.md`, `ai/VALIDATION_PROTOCOL.md`).

## Platform adaptations (`platforms/`)

Web, Mobile, Flutter, React Native, Desktop, WebGL/3D. Each file lists only what *changes* on that platform relative to `core/`. Phase 0 provides contracts only.

## Agent adapters (`adapters/`)

Claude Code, OpenAI Codex, Antigravity, and a generic fallback. Each adapter answers: how to locate the system, what to read first, how to apply design rules, use indexes and graphs, update task state, and produce handoffs. Adapters contain no core knowledge. The generic adapter, the Claude Code adapter (`adapters/claude/`), the Codex adapter (`adapters/codex/`) and the Antigravity adapter (`adapters/antigravity/`: skill, optional AGENTS.md block, installer) are implemented. A future agent adds one adapter.

## Templates, examples, tools

- `templates/` – blank per-project documents (`AI_INDEX`, `ARCHITECTURE`, `DECISIONS`, `TASK_STATE`, `HANDOFF`), each with purpose, structure and update rules.
- `examples/` – `web/`, `mobile/`, `flutter/`, `3d/`; placeholders in Phase 0.
- `tools/` – `project-intel`: working, dependency-free Node tooling for indexing, fingerprinting, stale detection, dependency graphs and impact queries (`tools/README.md`). `validation/` is still a contract (Phase 5).

## Future automation

**Implemented (Phase 3), `tools/`:** repository scan with ignore and secret handling, SHA-256 fingerprints, `AI_INDEX.md` / directory / file index and summary generation, stale detection (CURRENT, STALE, UNVERIFIABLE), a JavaScript/TypeScript dependency graph with a metadata-only fallback for other languages, public-surface and risk metadata, Mermaid, Graphviz DOT and JSON output with filtered views, and a query layer for change impact. Standard library only; run `node tools/bin/project-intel.mjs help`.

**Planned, not implemented:** task-scope and architecture analysis, design/context/repository validation, language adapters for Python, Dart, Java and C#, automation of agent behavior (Phase 5; contract in `ai/AUTOMATION_PROTOCOL.md`). Responsibilities are in each `tools/*/README.md`.

## Versioning

Semantic versioning, stored in `VERSION`, mirrored in `system-manifest.yaml`.

- **MAJOR** – breaking changes to design or protocol contracts (renamed tokens, changed precedence, changed file formats).
- **MINOR** – new capability, platform, agent adapter, or tool.
- **PATCH** – documentation fixes and small corrections.

Versions before `1.0.0` may change contracts in MINOR releases.

## Repository structure

```
README.md  LICENSE  VERSION  system-manifest.yaml  .gitignore
core/        design language, evidence, decisions, token register (tool- and platform-agnostic)
platforms/   WEB MOBILE FLUTTER REACT_NATIVE DESKTOP WEBGL_3D
ai/          AI development protocol
adapters/    GENERIC, claude/, codex/, antigravity/ (all implemented)
templates/   per-project document templates
examples/    web mobile flutter 3d
tools/       project-intel: bin lib index graph analyze test (validation reserved)
```

## Documentation conventions

- Each fact is defined once; other files link to it (e.g. "inherited from `core/DESIGN_PRINCIPLES.md`").
- Docs are implementation-independent unless they sit in `platforms/` or `adapters/`.
- Terminology: *task class* = TRIVIAL…ARCHITECTURAL (`ai/TASK_ROUTING.md`); *context level* = 0 to 5 and *context scope* = MINIMAL…ARCHITECTURAL (`ai/CONTEXT_PROTOCOL.md`); *risk level* = LOW…CRITICAL (`ai/CHANGE_IMPACT.md`).

## Roadmap

| Phase | Name | Status |
|---|---|---|
| 0 | Foundation | Complete |
| 1 | Design language (evidence-based tokens; open items tracked in `core/DESIGN_DECISIONS.md`) | Complete |
| 2 | AI context system (specification) | Complete |
| 3 | Graph/index tooling | Complete |
| 4 | Agent adapters | Complete: 4A generic, 4B Claude Code, 4C Codex and 4D Antigravity adapters |
| 5 | Automation | Complete: 5A contract (`ai/AUTOMATION_PROTOCOL.md`) and 5B automatic intelligence refresh, 5C automatic context routing, 5D automatic change impact and 5E automatic validation orchestration and 5F session continuity (`ai/CONTINUITY.md`, `tools/automation/`) complete |
| 6 | Real-world validation | Complete: a real-world scenario matrix on Windows, remediation of its findings, a reproducible release harness (`tools/scripts/release-validation.mjs`) and a final release audit |

## Platform support and verification (1.0.0)

What was actually run, and what was not. "Not verified" is never a pass.

| Area | Status |
|---|---|
| Windows 11, Node 24.19 | Verified: the full test suites, the real-world matrix and the release harness (real npm, process-tree termination, junctions, concurrent writers) |
| POSIX (Linux, macOS) | **Not verified.** The code is plain Node file and process handling and requires Node 20+, but no POSIX run exists; do not rely on POSIX behavior (process-group termination in particular) until it is run |
| File-level symlinks | **Not verified** (needs a privilege the test machine lacks); directory junctions were exercised and links are never followed |
| Claude Code | A real headless session ran in the release harness (2.1.289); the adapter was verified with 2.1.288 |
| Codex | Adapter verified in Phase 4C on one machine (Codex CLI 0.158.0-alpha.2.1); **no Codex agent session was run for this release** |
| Antigravity | **Runtime not verifiable** (a GUI agent); the launcher, the adapter tests and the shared protocol were exercised |

Known limitations: dependency analysis exists for JavaScript and TypeScript only (a change to a Python, Go, Rust, Java, CSS or shell file is reported `PARTIAL` with unknown dependents and tests); a handoff carries up to 400 changed files; secret and command detection in handoff text is heuristic and free text remains a prompt-injection surface (a handoff carries no authority); single-writer is a protocol, locked only against concurrent `project-intel` writers, not against manual edits; a validation PASS covers the change set that was declared. Reproduce the evidence with `node tools/scripts/release-validation.mjs` (`tools/automation/README.md`).

## License

Not yet chosen. See `LICENSE`.
