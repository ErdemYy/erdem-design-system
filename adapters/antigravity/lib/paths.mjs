import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** adapters/antigravity, wherever this repository is checked out. */
export const ADAPTER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The design-system root this adapter belongs to. */
export const SELF_ROOT = path.resolve(ADAPTER_DIR, '..', '..');

export const SKILL_NAME = 'erdem';
export const AGENTS_FILE = 'AGENTS.md';
/** Owner marker of the sibling Codex adapter, which installs the same skill into the shared .agents/ folder. */
export const SIBLING_OWNER = 'ERDEM_DESIGN_SYSTEM_CODEX_ADAPTER';

/**
 * Antigravity's machine-local customization root, from its bundled customization guide: ~/.gemini/config/.
 * No environment variable for it is documented, so it can only be overridden explicitly (`--config-home`).
 */
export function configHome({ home = os.homedir() } = {}) {
  return path.join(home, '.gemini', 'config');
}

/**
 * User-level locations: skills in <config home>/skills (the guide names ~/.gemini/config as the global
 * customization root and `skills/<name>/SKILL.md` as the skill layout). No user-level instructions file is
 * documented, so the user scope has no AGENTS.md block (`agentsDir` is null). The adapter's own state lives in
 * <config home>/erdem-adapter/.
 */
export function userTargets({ configHomeDir, home = os.homedir() } = {}) {
  const ch = configHomeDir ? path.resolve(configHomeDir) : configHome({ home });
  return {
    kind: 'user',
    configHome: ch,
    skillsDir: path.join(ch, 'skills'),
    agentsDir: null,
    stateDir: path.join(ch, 'erdem-adapter'),
    ledgerPath: path.join(ch, 'erdem-adapter', 'install.json'),
    configPath: path.join(ch, 'erdem-adapter', 'config.json'),
  };
}

/**
 * Project-level locations: skills in <project>/.agents/skills (the workspace customization root) and the
 * instructions block in <project>/AGENTS.md (a documented directory rule file). Skill files contain no
 * machine-specific path; the only such data is the ledger, which should stay out of version control.
 */
export function projectTargets(projectDir) {
  const p = path.resolve(projectDir);
  return {
    kind: 'project',
    projectDir: p,
    skillsDir: path.join(p, '.agents', 'skills'),
    agentsDir: p,
    stateDir: path.join(p, '.agents'),
    ledgerPath: path.join(p, '.agents', '.erdem-antigravity-install.json'),
    configPath: path.join(p, '.agents', 'erdem-adapter.json'),
  };
}
