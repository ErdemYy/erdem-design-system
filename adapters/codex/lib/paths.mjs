import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** adapters/codex, wherever this repository is checked out. */
export const ADAPTER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The design-system root this adapter belongs to. */
export const SELF_ROOT = path.resolve(ADAPTER_DIR, '..', '..');

export const SKILL_NAME = 'erdem';
export const AGENTS_FILE = 'AGENTS.md';
export const AGENTS_OVERRIDE_FILE = 'AGENTS.override.md';
/** Default combined limit for instruction files, from the Codex documentation (project_doc_max_bytes). */
export const AGENTS_DEFAULT_MAX_BYTES = 32 * 1024;

/** CODEX_HOME if set, otherwise ~/.codex (per the Codex documentation). */
export function codexHome({ env = process.env, home = os.homedir() } = {}) {
  return env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home, '.codex');
}

/**
 * User-level locations:
 * - skills: $HOME/.agents/skills (documented user skill location)
 * - AGENTS.md: $CODEX_HOME/AGENTS.md (documented global instructions)
 * - the adapter's own state: $CODEX_HOME/erdem-adapter/
 * `codexHomeDir` and `agentsHome` override the defaults (tests, portable installs).
 */
export function userTargets({ codexHomeDir, agentsHome, env = process.env, home = os.homedir() } = {}) {
  const ch = codexHomeDir ? path.resolve(codexHomeDir) : codexHome({ env, home });
  const ah = agentsHome ? path.resolve(agentsHome) : path.join(home, '.agents');
  return {
    kind: 'user',
    codexHome: ch,
    skillsDir: path.join(ah, 'skills'),
    agentsDir: ch,
    stateDir: path.join(ch, 'erdem-adapter'),
    ledgerPath: path.join(ch, 'erdem-adapter', 'install.json'),
    configPath: path.join(ch, 'erdem-adapter', 'config.json'),
  };
}

/**
 * Project-level locations: skills in <project>/.agents/skills (documented repository location) and the
 * instructions block in <project>/AGENTS.md. Skill files contain no machine-specific path; the only such
 * data is the ledger, which lives in .agents/ and should stay out of version control.
 */
export function projectTargets(projectDir) {
  const p = path.resolve(projectDir);
  return {
    kind: 'project',
    projectDir: p,
    skillsDir: path.join(p, '.agents', 'skills'),
    agentsDir: p,
    stateDir: path.join(p, '.agents'),
    ledgerPath: path.join(p, '.agents', '.erdem-codex-install.json'),
    configPath: path.join(p, '.agents', 'erdem-adapter.json'),
  };
}
