import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** adapters/claude, wherever this repository is checked out. */
export const ADAPTER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The design-system root this adapter belongs to (two levels above adapters/claude). */
export const SELF_ROOT = path.resolve(ADAPTER_DIR, '..', '..');

export const SKILL_NAME = 'erdem';

/**
 * User-level locations.
 * - settings.json and CLAUDE.md follow CLAUDE_CONFIG_DIR when set, otherwise ~/.claude.
 * - Personal skills are always read from ~/.claude/skills (Claude Code documentation: CLAUDE_CONFIG_DIR does not move them).
 * - `claudeDir` overrides everything with one directory (used by tests and portable installs).
 */
export function userTargets({ claudeDir, env = process.env, home = os.homedir() } = {}) {
  const base = (configDir, skillsDir, overridden) => ({
    kind: 'user',
    overridden,
    configDir,
    skillsDir,
    settingsPath: path.join(configDir, 'settings.json'),
    claudeMdPath: path.join(configDir, 'CLAUDE.md'),
    stateDir: path.join(configDir, 'erdem-adapter'),
    ledgerPath: path.join(configDir, 'erdem-adapter', 'install.json'),
    configPath: path.join(configDir, 'erdem-adapter', 'config.json'),
  });
  if (claudeDir) {
    const d = path.resolve(claudeDir);
    return base(d, path.join(d, 'skills'), true);
  }
  const configDir = env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(home, '.claude');
  return base(configDir, path.join(home, '.claude', 'skills'), false);
}

/**
 * Project-level locations. The hook goes into settings.local.json, which Claude Code treats as personal and
 * untracked by convention, so a machine-specific hook path is never committed with the project.
 */
export function projectTargets(projectDir) {
  const p = path.resolve(projectDir);
  const d = path.join(p, '.claude');
  return {
    kind: 'project',
    overridden: false,
    projectDir: p,
    configDir: d,
    skillsDir: path.join(d, 'skills'),
    settingsPath: path.join(d, 'settings.local.json'),
    claudeMdPath: path.join(p, 'CLAUDE.md'),
    stateDir: d,
    ledgerPath: path.join(d, 'erdem-adapter-install.json'),
    configPath: path.join(d, 'erdem-adapter.json'),
  };
}
