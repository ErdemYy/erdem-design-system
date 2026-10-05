# Troubleshooting

Diagnostics come from `doctor.mjs` in the adapter (`node <root>/adapters/claude/scripts/doctor.mjs`). It is read-only and prints no secrets.

| Symptom | Likely cause | What to do |
|---|---|---|
| `erdem.mjs root` says not found | no design system reachable | set `ERDEM_DESIGN_SYSTEM_ROOT`, or `designSystemRoot` in the adapter config, or re-run the installer from the checkout. Meanwhile work without design documents and say so |
| Launcher says the adapter checkout is not reachable | the repository was moved or deleted after install | set `ERDEM_ADAPTER_DIR` or re-run the installer from the new location |
| No `ERDEM:` line at session start | hook not installed, `autoStatus` is `off`, hooks disabled, or the project has no `.ai/` and `hookWhenUnavailable` is `silent` | run doctor; install with `--hook` if wanted |
| `ERDEM: ... configuration invalid` | the adapter config or an environment variable has a bad value | doctor names the key; fix it. The adapter ignores invalid values and keeps working |
| Line says `likely-stale` | working-tree files are newer than the index (a hint, from file times) | run `erdem.mjs context` for the verified state, refresh only if the task needs it |
| `status` reports MISSING after a fresh clone | machine artifacts such as `.ai/index.json` are not tracked | expected; run `erdem.mjs intel index` if the task benefits, otherwise continue |
| `/erdem` is not offered | skill not installed, or Claude Code was started before install | install, then start a new session; doctor reports the skill folder and its files |
| The skill never triggers by itself | installed with `--manual-only`, or `autoSkill` is false | invoke `/erdem`, or reinstall without `--manual-only` |
| Permission prompt when running the helper | the `allowed-tools` pattern did not match the resolved path | approve once, or add an allow rule for `erdem.mjs` in your permissions |
| Hook runs but prints nothing | `autoStatus` is `off`, or `hookWhenUnavailable` is `silent` | change the setting |
| Windows: command not found for project-intel | a `.cmd` shim cannot be spawned directly | configure `projectIntelCommand` as `["node", "<path>/project-intel.mjs"]` |
| Doctor says the skill is not owned by the adapter | a skill folder named `erdem` already exists | it is never overwritten; rename or remove it yourself, or use `--no-skill` |

Limits worth knowing: the light status in the hook line is a hint, not verification; the engine analyzes dependencies for JavaScript and TypeScript only; personal skills are read from `~/.claude/skills` even when `CLAUDE_CONFIG_DIR` is set (per Claude Code documentation).
