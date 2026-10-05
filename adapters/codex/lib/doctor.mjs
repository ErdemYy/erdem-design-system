import fs from 'node:fs';
import path from 'node:path';
import { loadAdapterConfig } from './config.mjs';
import { findProjectRoot, readLedger, resolveDesignSystemRoot, resolveIntelCommand } from './discover.mjs';
import { exists, readJson, readText, resolveExecutable, runSafe, sha256 } from './helpers.mjs';
import { checkIntelligence } from './intelligence.mjs';
import { OWNER, instructionsFile, loadManifest, removeBlock } from './installer.mjs';
import { ADAPTER_DIR, AGENTS_DEFAULT_MAX_BYTES, SKILL_NAME, projectTargets, userTargets } from './paths.mjs';

/**
 * Read-only diagnostics. Levels: ok, info, warning, failure. It reads no secrets: it never opens config.toml,
 * auth files or .env files, and it prints names, versions and paths only (never environment values).
 * The one command it runs on the project is `project-intel status`, which is read-only by contract.
 */
export function runDoctor({ env = process.env, home, scope = 'user', codexHome, agentsHome, projectDir, cwd = process.cwd(), adapterDir = ADAPTER_DIR, checkCodexCli = true, checkIntel = true } = {}) {
  const checks = [];
  const add = (id, level, message) => checks.push({ id, level, message });
  const manifest = loadManifest(adapterDir);
  const target = scope === 'project' ? projectTargets(projectDir ?? cwd) : userTargets({ codexHomeDir: codexHome, agentsHome, env, home });
  const userT = userTargets({ codexHomeDir: codexHome, agentsHome, env, home });
  const projectRoot = findProjectRoot(projectDir ?? cwd);

  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 20 ? 'ok' : 'failure', `Node ${process.versions.node} (needs 20 or newer)`);

  // configuration
  const loaded = loadAdapterConfig({ env, userConfigPath: userT.configPath, projectConfigPath: path.join(projectRoot, '.agents', 'erdem-adapter.json') });
  for (const e of loaded.errors) add('config', 'failure', e);
  for (const w of loaded.warnings) add('config', 'warning', w);
  if (!loaded.errors.length) add('config', 'ok', `configuration valid (preferredProfile=${loaded.config.preferredProfile})`);

  // design system and canonical files
  const ledger = readLedger(target.ledgerPath);
  const found = resolveDesignSystemRoot({ env, config: loaded.config, sources: loaded.sources, ledger });
  add('design-system', found.root ? 'ok' : 'failure', found.root ? `design system found (${found.source}): ${found.root}` : 'design system not found: set ERDEM_DESIGN_SYSTEM_ROOT or designSystemRoot in the adapter config');
  for (const t of found.tried.filter((x) => !x.ok && ['env', 'user-config', 'project-config'].includes(x.source))) add('design-system-config', 'warning', `the design-system root from ${t.source} is not a valid Erdem root (no matching system-manifest.yaml)${found.root ? `; ${found.source} is being used instead` : ''}`);
  if (found.root) {
    const missing =manifest.canonicalFiles.filter((f) => !exists(path.join(found.root, f)));
    add('canonical-files', missing.length ? 'failure' : 'ok', missing.length ? `canonical files missing: ${missing.join(', ')}` : `${manifest.canonicalFiles.length} canonical files present`);
    const version = readText(path.join(found.root, 'VERSION'))?.trim();
    const need = manifest.requiresSystemVersion;
    const cmp = (a, b) => a.split('.').map(Number).reduce((r, n, i) => r || n - Number(b.split('.')[i] ?? 0), 0);
    if (version && /^\d+\.\d+\.\d+$/.test(version)) add('system-version', cmp(version, need) >= 0 ? 'ok' : 'failure', `design system ${version} (adapter requires ${need} or newer)`);
  }

  // adapter files and manifest
  const missingFiles = manifest.files.filter((f) => !exists(path.join(adapterDir, f.source)));
  add('adapter-files', missingFiles.length ? 'failure' : 'ok', missingFiles.length ? `adapter files missing: ${missingFiles.map((f) => f.source).join(', ')}` : `${manifest.files.length} adapter files present`);
  add('manifest', manifest.owner === OWNER ? 'ok' : 'failure', manifest.owner === OWNER ? 'manifest ownership marker matches the code' : 'manifest ownership marker does not match the code');

  // Codex integration presence (nothing is opened: config.toml may hold credentials)
  add('codex-home', exists(userT.codexHome) ? 'ok' : 'info', exists(userT.codexHome) ? `Codex home found: ${userT.codexHome}` : `Codex home not found: ${userT.codexHome} (set CODEX_HOME if Codex uses another directory)`);
  if (exists(path.join(userT.codexHome, 'config.toml'))) add('codex-config', 'info', 'config.toml present; not read (it can contain credentials) and never modified by this adapter');
  if (checkCodexCli) {
    const exe = resolveExecutable('codex', { env });
    if (!exe) add('codex-cli', 'info', 'no codex command on PATH (the desktop app or an IDE extension may bundle its own)');
    else if (exe.shim) add('codex-cli', 'info', `codex found at ${exe.path} (a Windows .cmd shim; not executed because that would require a shell)`);
    else {
      const r = runSafe([exe.path, '--version'], { timeoutMs: 8000, env });
      const v = /(\d+\.\d+\.\d+[\w.+-]*)/.exec(r.stdout)?.[1];
      add('codex-cli', v ? 'ok' : 'warning', v ? `codex ${v}` : 'codex was found but did not report a version');
    }
  }

  // skill ownership and integrity
  const skillDir = path.join(target.skillsDir, manifest.skillName ?? SKILL_NAME);
  const ownerRead = readJson(path.join(skillDir, '.erdem-owner.json'));
  if (!exists(skillDir)) add('skill', 'warning', `skill not installed (${skillDir}); run the installer`);
  else if (!ownerRead.data || ownerRead.data.owner !== OWNER || typeof ownerRead.data.files !== 'object') add('skill', 'failure', `${skillDir} exists but its ownership metadata is ${ownerRead.error ? 'not valid JSON' : 'missing or invalid'}; it will not be modified by the adapter`);
  else {
    const bad = Object.entries(ownerRead.data.files).filter(([rel, h]) => {
      const t = readText(path.join(skillDir, rel));
      return t === null || sha256(t) !== h;
    });
    add('skill', bad.length ? 'warning' : 'ok', bad.length ? `skill files missing or modified: ${bad.map(([r]) => r).join(', ')}` : `skill installed, ${Object.keys(ownerRead.data.files).length} files intact (adapter ${ownerRead.data.adapterVersion})`);
    const link = readJson(path.join(skillDir, 'adapter-link.json')).data;
    if (link && !exists(path.join(link.adapterDir ?? '', 'scripts', 'context.mjs'))) add('skill-link', 'failure', `the installed skill points to ${link.adapterDir}, which no longer exists; re-run the installer`);
  }

  // ledger and AGENTS.md block
  const ledgerRead = readJson(target.ledgerPath);
  if (ledgerRead.exists && (ledgerRead.error || ledgerRead.data?.owner !== OWNER)) add('ledger', 'failure', `${target.ledgerPath} is not a valid adapter ledger`);
  const file = instructionsFile(target.agentsDir);
  const md = readText(file);
  if (md !== null && md.includes(`BEGIN ${OWNER}`)) {
    const r = removeBlock(md);
    const recorded = (ledgerRead.data?.agentsMd ?? []).some((c) => path.resolve(c.path) === path.resolve(file));
    add('agents-md', r.op === 'conflict' ? 'failure' : 'ok', r.op === 'conflict' ? `${file} has unbalanced ${OWNER} markers` : `managed block present in ${path.basename(file)}`);
    if (!recorded) add('agents-ledger', 'warning', 'the block is not in the install ledger (uninstall will refuse to remove it)');
    if (Buffer.byteLength(md) > AGENTS_DEFAULT_MAX_BYTES) add('agents-size', 'warning', `${path.basename(file)} exceeds the default ${AGENTS_DEFAULT_MAX_BYTES}-byte instruction limit; Codex may cut off its end`);
    if (path.basename(file) === 'AGENTS.override.md') add('agents-override', 'info', 'AGENTS.override.md exists and takes precedence over AGENTS.md in this directory');
  } else add('agents-md', 'info', 'no AGENTS.md block installed (optional)');

  // configuration consistency
  if (ledger?.designSystemRoot && found.root && path.resolve(ledger.designSystemRoot) !== path.resolve(found.root)) add('consistency', 'warning', `the install ledger records ${ledger.designSystemRoot} but ${found.root} is in use (source: ${found.source})`);
  if (ledger?.adapterDir && !exists(ledger.adapterDir)) add('consistency', 'failure', `the install ledger points to an adapter directory that no longer exists: ${ledger.adapterDir}`);

  // permissions
  let d = target.skillsDir;
  while (!exists(d) && path.dirname(d) !== d) d = path.dirname(d);
  let writable = true;
  try {
    fs.accessSync(d, fs.constants.W_OK);
  } catch {
    writable = false;
  }
  add('permissions', writable ? 'ok' : 'failure', writable ? 'install location is writable' : 'install location is not writable');

  // project intelligence
  if (!checkIntel) add('intelligence', 'info', 'intelligence check skipped');
  else if (!exists(path.join(projectRoot, '.ai'))) add('intelligence', 'info', `missing: no .ai/ in ${projectRoot} (run project-intel index when wanted)`);
  else {
    const cmd = resolveIntelCommand({ root: found.root, config: loaded.config });
    const s = checkIntelligence(projectRoot, cmd?.argv, { timeoutMs: 60000, env });
    const level = { current: 'ok', missing: 'info', unavailable: 'info' }[s.state] ?? 'warning';
    add('intelligence', level, `${s.state}${s.reason ? ` (${s.reason})` : ''}${s.graph ? `; graph ${s.graph}` : ''}`);
  }

  return { ok: !checks.some((c) => c.level === 'failure'), checks };
}
