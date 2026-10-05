import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadAdapterConfig } from './config.mjs';
import { findProjectRoot, readLedger, resolveDesignSystemRoot, resolveIntelCommand } from './discover.mjs';
import { loadManifest } from './installer.mjs';
import { ADAPTER_DIR, SKILL_NAME, projectTargets, userTargets } from './paths.mjs';
import { OWNER, SettingsError, foreignHooks, isOwnedCommand, ownedHooks, readSettings } from './settings.mjs';
import { exists, readJson, readText, sha256 } from './util.mjs';

/**
 * Environment and installation diagnostics. Read-only. It reports names, versions and paths; it never prints
 * environment values, settings contents, or anything that could be a secret.
 */
export function runDoctor({ env = process.env, home, claudeDir, scope = 'user', projectDir, cwd = process.cwd(), claudeBin = 'claude', adapterDir = ADAPTER_DIR } = {}) {
  const checks = [];
  const add = (id, level, message) => checks.push({ id, level, message });
  const manifest = loadManifest(adapterDir);
  const target = scope === 'project' ? projectTargets(projectDir ?? cwd) : userTargets({ claudeDir, env, home });

  // Node
  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 20 ? 'ok' : 'fail', `Node ${process.versions.node} (needs 20 or newer)`);

  // Claude Code
  if (claudeBin === false) add('claude', 'info', 'Claude Code check skipped');
  else {
    const r = spawnSync(claudeBin, ['--version'], { encoding: 'utf8', timeout: 8000, shell: process.platform === 'win32', windowsHide: true });
    const version = /(\d+\.\d+\.\d+)/.exec(r.stdout ?? '')?.[1];
    if (!version) add('claude', 'warn', 'Claude Code was not found on the command path (the adapter files can still be installed)');
    else {
      const [a, b] = version.split('.');
      const [va, vb] = manifest.verifiedWith.claudeCode.split('.');
      add('claude', 'ok', `Claude Code ${version}${a === va && b === vb ? '' : ` (adapter verified with ${manifest.verifiedWith.claudeCode}; behavior on other versions is untested)`}`);
    }
  }

  // configuration
  const projectRoot = findProjectRoot(projectDir ?? cwd);
  const loaded = loadAdapterConfig({ env, userConfigPath: target.kind === 'user' ? target.configPath : userTargets({ claudeDir, env, home }).configPath, projectConfigPath: path.join(projectRoot, '.claude', 'erdem-adapter.json') });
  for (const e of loaded.errors) add('config', 'fail', e);
  for (const w of loaded.warnings) add('config', 'warn', w);
  if (!loaded.errors.length) add('config', 'ok', `configuration valid (autoStatus=${loaded.config.autoStatus}, autoSkill=${loaded.config.autoSkill})`);

  // design system and tooling
  const ledgerPath = target.ledgerPath;
  const ledger = readLedger(ledgerPath);
  const found = resolveDesignSystemRoot({ env, config: loaded.config, sources: loaded.sources, ledger });
  add('design-system', found.root ? 'ok' : 'fail', found.root ? `design system found (${found.source}): ${found.root}` : 'design system not found: set ERDEM_DESIGN_SYSTEM_ROOT or designSystemRoot in the adapter config');
  if (found.root && manifest.requiresSystemVersion) {
    const version = readText(path.join(found.root, 'VERSION'))?.trim();
    const need = manifest.requiresSystemVersion;
    const cmp = (x, y) => x.split('.').map(Number).reduce((r, n, i) => r || n - Number(y.split('.')[i] ?? 0), 0);
    if (version && /^d+.d+.d+$/.test(version)) add('system-version', cmp(version, need) >= 0 ? 'ok' : 'fail', `design system ${version} (adapter requires ${need} or newer)`);
  }
  const cmd = resolveIntelCommand({ root: found.root, config: loaded.config });
  if (!cmd) add('project-intel', 'warn', 'project-intel command not available (the adapter falls back to direct inspection)');
  else {
    const r = spawnSync(cmd.argv[0], [...cmd.argv.slice(1), 'version'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    add('project-intel', r.status === 0 ? 'ok' : 'fail', r.status === 0 ? `${(r.stdout ?? '').trim()} (${cmd.source})` : 'project-intel failed to run: check projectIntelCommand');
  }

  // skill
  const skillDir = path.join(target.skillsDir, manifest.skillName ?? SKILL_NAME);
  const owner = readJson(path.join(skillDir, '.erdem-owner.json')).data;
  if (!exists(skillDir)) add('skill', 'warn', `skill not installed (${skillDir}); run the installer`);
  else if (!owner || owner.owner !== OWNER) add('skill', 'fail', `${skillDir} exists but is not owned by this adapter`);
  else {
    const bad = Object.entries(owner.files ?? {}).filter(([rel, h]) => {
      const t = readText(path.join(skillDir, rel));
      return t === null || sha256(t) !== h;
    });
    add('skill', bad.length ? 'warn' : 'ok', bad.length ? `skill files missing or modified: ${bad.map(([r]) => r).join(', ')}` : `skill installed, ${Object.keys(owner.files).length} files intact (adapter ${owner.adapterVersion})`);
    const link = readJson(path.join(skillDir, 'adapter-link.json')).data;
    if (link && !exists(path.join(link.adapterDir, 'hooks', 'session-start.mjs'))) add('skill-link', 'fail', `the installed skill points to ${link.adapterDir}, which no longer exists; re-run the installer`);
  }

  // hook
  let settings = null;
  try {
    settings = readSettings(target.settingsPath);
  } catch (e) {
    if (!(e instanceof SettingsError)) throw e;
    add('settings', 'fail', e.message);
  }
  if (settings) {
    if (!settings.exists) add('hook', 'info', `no settings file at ${target.settingsPath}; hook not installed (optional)`);
    else {
      const owned = ownedHooks(settings.data);
      if (owned.length === 0) add('hook', 'info', 'SessionStart hook not installed (optional)');
      else if (owned.length > 1) add('hook', 'fail', 'more than one adapter hook is registered');
      else {
        const m = /"([^"]+session-start\.mjs)"/.exec(owned[0].command);
        add('hook', m && exists(m[1]) ? 'ok' : 'fail', m && exists(m[1]) ? 'SessionStart hook registered and its script exists' : 'SessionStart hook is registered but its script is missing');
        const recorded = (ledger?.hooks ?? []).some((h) => h.command === owned[0].command);
        if (!recorded) add('hook-ledger', 'warn', 'the hook carries the adapter marker but is not in the install ledger (uninstall will refuse to remove it)');
      }
      const foreign = foreignHooks(settings.data);
      if (foreign.length) add('foreign-hooks', 'info', `${foreign.length} other SessionStart hook(s) present; they are never modified`);
      if (settings.data.disableAllHooks === true) add('hooks-disabled', 'warn', 'disableAllHooks is true: no hook will run');
    }
  }

  // other
  if (env.CLAUDE_CONFIG_DIR && target.kind === 'user' && !target.overridden) add('skills-location', 'info', 'CLAUDE_CONFIG_DIR is set; settings.json and CLAUDE.md follow it, personal skills are read from ~/.claude/skills (per Claude Code documentation)');
  const writable = (() => {
    let d = target.skillsDir;
    while (!exists(d) && path.dirname(d) !== d) d = path.dirname(d);
    try {
      fs.accessSync(d, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  })();
  add('permissions', writable ? 'ok' : 'fail', writable ? 'install location is writable' : 'install location is not writable');
  add('project', exists(path.join(projectRoot, '.ai')) ? 'ok' : 'info', exists(path.join(projectRoot, '.ai')) ? `project intelligence directory present (${projectRoot})` : `no .ai/ in ${projectRoot} (run project-intel index when wanted)`);

  return { ok: !checks.some((c) => c.level === 'fail'), checks };
}

export { isOwnedCommand };
