# Tools: Index

Implemented (Phase 3). Generates the artifacts specified in `ai/INDEX_PROTOCOL.md`, computes fingerprints, and detects stale derived context. CLI: `project-intel index`, `project-intel status`. Library: `index/generate.mjs` (`generateIndex`), `index/status.mjs` (`checkStatus`).

## What `index` does

1. **Scan** (`lib/scan.mjs`): walk the project once, honoring ignores and withholding secret-pattern files; fingerprint every file with one read; parse supported languages, reusing cached facts when the content hash and adapter version match.
2. **Graph** (`graph/`): build the dependency graph in memory.
3. **Write** into the output directory (default `.ai/`): only artifacts whose content changed are touched. An unchanged artifact keeps its bytes, including its timestamp, so a second run is a no-op.

## Profiles

Chosen by `--profile` or configuration; `auto` selects by source-file count (defaults 40 and 400, configurable). The machine files (`index.json`, graph, state) are always written because they are cheap; the profile controls the Markdown and summary artifacts.

| Profile | Writes |
|---|---|
| none | machine files only |
| lite | + `AI_INDEX.md` |
| standard | + `directories/**/DIRECTORY_INDEX.md` for meaningful directories and their subsystem graph views |
| full | + `FILE_INDEX.md` and `summaries/**` |

Artifacts of a higher profile are removed when the profile drops.

## Artifact formats

- **`AI_INDEX.md`**: front matter (`generatedAt`, `source`, `scope`, `schemaVersion`, `fingerprint`, `indexProfile`, `configDigest`, `generated: true`), then identity, architecture overview (counts, subsystem dependency table, analysis coverage), important directories, important files, entry points, generated and ignored areas, decisions/task-state/handoff pointers if such files exist, derived artifacts, index metadata. Short by design (tables are capped; the rest is in `graph.json`). Sections that need human knowledge, such as the design system in use, are intentionally absent: the tool cannot know them.
- **`DIRECTORY_INDEX.md`**: only subsystem roots, package directories and configured directories. Purpose (README or package description, else "not determined"), composition, important files, entry points, derived responsibilities (files used from outside the directory), dependencies, consumers, related docs, graph view pointer.
- **`FILE_INDEX.md`**: important files only (entry points, public surfaces, widely used modules, configured): role, exported names, dependency and consumer counts, tests, summary pointer, fingerprint prefix.
- **Summaries** (`summary.schema.v1.json`): `path`, `scope`, `generatedAt`, `source`, `fingerprint`, `purpose`, `architecturalRole`, `dependencies`, `consumers`, `constraints`, `risks`, `volatileFields`, `notice`. `purpose` is at most the first sentence of a leading comment or README (else `null`). Everything else is structural data from the graph; nothing copies implementation. Dependency, consumer, role, constraint and risk fields are listed as volatile.
- **`index.json`** (`index.schema.v1.json`): every non-ignored, non-secret file with path, extension, language, category, size, mtime, fingerprint; set fingerprints; configuration digest.

Categories: `source`, `test`, `config`, `documentation`, `asset`, `generated`, `unknown` (secret-pattern files are not categories: they are withheld).

## Fingerprint (schema v1)

| Field | Meaning |
|---|---|
| `algo` | `sha256`, recorded in every fingerprint |
| `hash` | hex digest of the normalized content; `null` when the file cannot be safely fingerprinted |
| `normalization` | `text-lf-nobom` (UTF-8 BOM removed, CRLF to LF) or `binary-raw` (NUL byte in the first 8000 bytes: raw bytes) |
| `size`, `mtime` | recorded; cheap pre-checks only |
| `reason` | `too-large`, `unreadable` or `member-unverifiable` when `hash` is `null` |

The hash is the identity: a line-ending or mtime change alone changes nothing; identical size and mtime cannot hide a content change. Set fingerprints (directories, structure) hash sorted `path\0hash` lines and are unverifiable if any member is.

## Staleness (`status`)

| State | Meaning |
|---|---|
| CURRENT | stored fingerprint equals the current one |
| STALE | content changed, file added, removed or moved, or the configuration changed |
| UNVERIFIABLE | a source cannot be safely fingerprinted (too large, unreadable) or no hash was stored |
| MISSING | an expected artifact does not exist (reported separately from the three states) |

`status` always re-hashes (it never trusts mtime), is read-only, and exits `1` on STALE or MISSING. UNVERIFIABLE is a warning. CURRENT means *the source has not changed*, not *the summary was ever correct*.

## Incremental behavior

- File level: a file whose content hash is unchanged reuses its parse facts from `state/parse-cache.json` (keyed by hash and adapter version); only changed files are re-parsed.
- Derived artifacts are rewritten only when their content changed, so unrelated summaries and indexes stay byte-identical.
- `trustMtime: true` (opt-in) skips re-hashing files whose size and mtime match the previous index; `--rehash` overrides it.
- Graph-level optimization (partial graph rebuilds) is not implemented: the graph is rebuilt from cached facts each run.

## Known limitations

- Index quality depends on dependency analysis, which exists for JavaScript and TypeScript only. For other languages the index lists files and metadata, and says so.
- "Important" is decided by structural evidence (entry points, public surface, fan-in) and project configuration, not by naming conventions.
- Summaries are mechanical; they do not explain what code does.
