import fs from 'node:fs';
import path from 'node:path';
import { ADAPTER_DIR, SELF_ROOT, SKILL_NAME, projectTargets, userTargets } from './paths.mjs';
import { CONFIG_SCHEMA_VERSION, DEFAULT_CONFIG, loadAdapterConfig } from './config.mjs';
import { OWNER, SettingsError, backupName, foreignHooks, hookCommand, isOwnedCommand, planHookInstall, planHookRemove, readSettings, writeSettings } from './settings.mjs';
import { atomicWrite, exists, fwd, readJson, readText, sha256 } from './util.mjs';

/**
 * Safe install and uninstall. Everything is planned first (pure, no writes), then applied. Ownership is
 * proven three ways: an owner file inside the skill folder, a marker on the hook command, and a ledger.
 * Nothing foreign is ever overwritten or removed.
 */

export function loadManifest(adapterDir = ADAPTER_DIR) {
  return JSON.parse(fs.readFileSync(path.join(adapterDir, 'package', 'adapter-manifest.json'), 'utf8'));
}

const OWNER_FILE = '.erdem-owner.json';
const LINK_FILE = 'adapter-link.json';

const jsonText = (v) => JSON.stringify(v, null, 2) + '\n';

function renderSkill(text, manualOnly) {
  if (!manualOnly) return text;
  if (/^disable-model-invocation:/m.test(text)) return text;
  return text.replace(/^(name:[^\n]*\n)/m, '$1disable-model-invocation: true\n');
}

function targetsFor(o) {
  if (o.scope === 'project') {
    if (!o.projectDir) throw new Error('--project <dir> is required with --scope project');
    return projectTargets(o.projectDir);
  }
  return userTargets({ claudeDir: o.claudeDir, env: o.env, home: o.home });
}

/* ------------------------------ skill ------------------------------ */

function planSkill(o, target, manifest, plan) {
  const dir = path.join(target.skillsDir, manifest.skillName ?? SKILL_NAME);
  const adapterDir = o.adapterDir ?? ADAPTER_DIR;
  const desired = new Map();
  for (const f of manifest.files) {
    const text = fs.readFileSync(path.join(adapterDir, f.source), 'utf8');
    desired.set(f.target, f.render === 'skill' ? renderSkill(text, o.manualOnly) : text);
  }
  desired.set(LINK_FILE, jsonText({ adapterDir: fwd(adapterDir), designSystemRoot: fwd(o.designSystemRoot ?? SELF_ROOT), adapterVersion: manifest.version }));

  const ownerPath = path.join(dir, OWNER_FILE);
  const ownerRead = readJson(ownerPath);
  const owner = ownerRead.data && ownerRead.data.owner === OWNER ? ownerRead.data : null;
  if (exists(dir) && !owner) {
    plan.conflicts.push({ code: 'foreign-skill', blocking: true, message: `${dir} exists and is not owned by this adapter (no ${OWNER_FILE}); it was not touched. Rename or remove it, or install with --no-skill.` });
    return;
  }
  const recorded = owner?.files ?? {};
  const finalHashes = {};
  for (const [rel, content] of desired) {
    const file = path.join(dir, rel);
    const current = readText(file);
    const want = sha256(content);
    if (current === null) {
      plan.actions.push({ kind: 'file', op: 'create', path: file, content });
      finalHashes[rel] = want;
    } else if (sha256(current) === want) {
      plan.actions.push({ kind: 'file', op: 'unchanged', path: file });
      finalHashes[rel] = want;
    } else if (recorded[rel] && sha256(current) === recorded[rel]) {
      plan.actions.push({ kind: 'file', op: 'update', path: file, content });
      finalHashes[rel] = want;
    } else if (o.force) {
      plan.actions.push({ kind: 'file', op: 'update', path: file, content, forced: true });
      finalHashes[rel] = want;
      plan.warnings.push(`${file} had local changes; overwritten because of --force`);
    } else {
      plan.warnings.push(`${file} has local changes and was left as is (use --force to overwrite)`);
      if (recorded[rel]) finalHashes[rel] = recorded[rel];
    }
  }
  for (const [rel, hash] of Object.entries(recorded)) {
    if (desired.has(rel)) continue;
    const file = path.join(dir, rel);
    const current = readText(file);
    if (current !== null && sha256(current) === hash) plan.actions.push({ kind: 'file', op: 'remove', path: file });
    else if (current !== null) {
      plan.warnings.push(`${file} is no longer part of the adapter but has local changes; kept`);
      finalHashes[rel] = hash;
    }
  }
  const ownerRecord = { owner: OWNER, adapterVersion: manifest.version, files: Object.fromEntries(Object.entries(finalHashes).sort(([a], [b]) => (a < b ? -1 : 1))) };
  const ownerContent = jsonText(ownerRecord);
  const current = readText(ownerPath);
  plan.actions.push({ kind: 'file', op: current === null ? 'create' : current === ownerContent ? 'unchanged' : 'update', path: ownerPath, content: ownerContent });
  plan.skill = { dir, files: ownerRecord.files };
}

/* ------------------------------ config ------------------------------ */

function planConfig(o, target, plan) {
  if (target.kind !== 'user') return;
  if (exists(target.configPath)) {
    plan.actions.push({ kind: 'file', op: 'unchanged', path: target.configPath, note: 'user-owned; never modified' });
    return;
  }
  const defaults = { ...DEFAULT_CONFIG, autoSkill: !o.manualOnly };
  plan.actions.push({ kind: 'file', op: 'create', path: target.configPath, content: jsonText(defaults) });
  plan.configCreated = true;
}

/* ------------------------------ hook ------------------------------ */

function planHook(o, target, plan) {
  const adapterDir = o.adapterDir ?? ADAPTER_DIR;
  const command = hookCommand(path.join(adapterDir, 'hooks', 'session-start.mjs'), o.nodeCommand ?? 'node');
  let settings;
  try {
    settings = readSettings(target.settingsPath);
  } catch (e) {
    if (!(e instanceof SettingsError)) throw e;
    plan.conflicts.push({ code: 'invalid-settings', blocking: true, message: `${e.message}. Add the hook by hand: see "Manual hook integration" in adapters/claude/README.md.` });
    return;
  }
  let result;
  try {
    result = planHookInstall(settings.data, command);
  } catch (e) {
    if (!(e instanceof SettingsError)) throw e;
    plan.conflicts.push({ code: 'unsafe-settings', blocking: true, message: `${e.message}. Settings were not modified; see "Manual hook integration" in adapters/claude/README.md.` });
    return;
  }
  const foreign = foreignHooks(settings.data);
  if (foreign.length) plan.notes.push(`${foreign.length} existing SessionStart hook(s) preserved untouched`);
  plan.actions.push({ kind: 'settings', op: result.changed ? (settings.exists ? result.action : 'create') : 'unchanged', path: target.settingsPath, next: result.next, existed: settings.exists, action: result.action });
  plan.hook = { settingsPath: target.settingsPath, event: 'SessionStart', command, settingsCreated: !settings.exists || undefined };
}

/* ------------------------------ CLAUDE.md block ------------------------------ */

const BEGIN = `<!-- BEGIN ${OWNER} -->`;
const END = `<!-- END ${OWNER} -->`;

function blockText(source, eol) {
  return [BEGIN, ...source.trim().split(/\r?\n/), END].join(eol);
}

export function planBlock(existing, source) {
  const eol = existing && existing.includes('\r\n') ? '\r\n' : '\n';
  const block = blockText(source, eol);
  if (existing === null) return { op: 'create', content: block + eol };
  const begins = existing.split(BEGIN).length - 1;
  const ends = existing.split(END).length - 1;
  if (begins === 0 && ends === 0) {
    const sep = existing.length === 0 ? '' : existing.endsWith(eol) ? eol : eol + eol;
    return { op: 'update', content: existing + sep + block + eol };
  }
  const bi = existing.indexOf(BEGIN);
  const ei = existing.indexOf(END);
  if (begins !== 1 || ends !== 1 || ei < bi) return { op: 'conflict' };
  const next = existing.slice(0, bi) + block + existing.slice(ei + END.length);
  return next === existing ? { op: 'unchanged' } : { op: 'update', content: next };
}

export function removeBlock(existing) {
  const begins = existing.split(BEGIN).length - 1;
  const ends = existing.split(END).length - 1;
  if (begins === 0 && ends === 0) return { op: 'absent' };
  const bi = existing.indexOf(BEGIN);
  const ei = existing.indexOf(END);
  if (begins !== 1 || ends !== 1 || ei < bi) return { op: 'conflict' };
  let before = existing.slice(0, bi);
  let after = existing.slice(ei + END.length);
  after = after.replace(/^(\r?\n)/, '');
  before = before.replace(/(\r?\n){2,}$/, (m) => (m.includes('\r') ? '\r\n' : '\n'));
  const next = before + after;
  return { op: 'update', content: next.trim() === '' ? '' : next };
}

function planClaudeMd(o, target, manifest, plan) {
  const adapterDir = o.adapterDir ?? ADAPTER_DIR;
  const source = fs.readFileSync(path.join(adapterDir, manifest.claudeMd.source), 'utf8');
  const existing = readText(target.claudeMdPath);
  const r = planBlock(existing, source);
  if (r.op === 'conflict') {
    plan.conflicts.push({ code: 'malformed-markers', blocking: true, message: `${target.claudeMdPath} contains unbalanced or duplicated ${OWNER} markers; it was not touched. Fix or remove the markers by hand.` });
    return;
  }
  plan.actions.push({ kind: 'file', op: r.op, path: target.claudeMdPath, content: r.content });
  plan.claudeMd = { path: target.claudeMdPath, created: existing === null || undefined };
}

/* ------------------------------ install ------------------------------ */

export function planInstall(o = {}) {
  const manifest = o.manifest ?? loadManifest(o.adapterDir);
  const target = targetsFor(o);
  const plan = { mode: 'install', target, actions: [], conflicts: [], warnings: [], notes: [], skill: null, hook: null, claudeMd: null };
  const existingConfig = target.kind === 'user' ? loadAdapterConfig({ env: {}, userConfigPath: target.configPath }) : null;
  const opts = { ...o, manualOnly: o.manualOnly ?? existingConfig?.config.autoSkill === false };
  if (o.skill !== false) planSkill(opts, target, manifest, plan);
  planConfig(opts, target, plan);
  if (o.hook) planHook(opts, target, plan);
  if (o.claudeMd) planClaudeMd(opts, target, manifest, plan);
  if (target.kind === 'project') plan.notes.push('project scope writes machine-specific paths; keep .claude/settings.local.json and .claude/erdem-adapter-install.json out of version control');
  const prior = readJson(target.ledgerPath).data;
  // ownership facts recorded by an earlier install (for example "this installer created the file") must survive re-installs
  if (plan.hook) {
    const before = (prior?.hooks ?? []).find((h) => path.resolve(h.settingsPath) === path.resolve(plan.hook.settingsPath));
    if (before?.settingsCreated) plan.hook.settingsCreated = true;
  }
  if (plan.claudeMd) {
    const before = (prior?.claudeMd ?? []).find((c) => path.resolve(c.path) === path.resolve(plan.claudeMd.path));
    if (before?.created) plan.claudeMd.created = true;
  }
  plan.ledger = {
    schemaVersion: 1,
    owner: OWNER,
    adapter: { name: manifest.name, version: manifest.version },
    scope: target.kind,
    designSystemRoot: fwd(o.designSystemRoot ?? SELF_ROOT),
    adapterDir: fwd(o.adapterDir ?? ADAPTER_DIR),
    skill: plan.skill ?? prior?.skill ?? null,
    hooks: plan.hook ? [plan.hook] : prior?.hooks ?? [],
    claudeMd: plan.claudeMd ? [{ path: plan.claudeMd.path, created: plan.claudeMd.created }] : prior?.claudeMd ?? [],
    configCreated: plan.configCreated || prior?.configCreated || undefined,
    backups: prior?.backups ?? [],
  };
  return plan;
}

const changing = (a) => a.op !== 'unchanged';

export function applyPlan(plan, { now = new Date() } = {}) {
  const result = { written: [], removed: [], backups: [], unchanged: 0 };
  if (plan.conflicts.some((c) => c.blocking)) return { ...result, refused: true };
  for (const a of plan.actions) {
    if (!changing(a)) {
      result.unchanged++;
      continue;
    }
    if (a.kind === 'file' && a.op === 'remove') {
      fs.rmSync(a.path, { force: true });
      result.removed.push(a.path);
    } else if (a.kind === 'file') {
      atomicWrite(a.path, a.content);
      result.written.push(a.path);
    } else if (a.kind === 'settings') {
      const backup = writeSettings(a.path, a.next, { existed: a.existed, now });
      result.written.push(a.path);
      if (backup) result.backups.push(backup);
    }
  }
  const ledger = plan.mode === 'install' ? plan.ledger : null;
  if (ledger) {
    ledger.backups = [...new Set([...(ledger.backups ?? []), ...result.backups])];
    const prior = readText(plan.target.ledgerPath);
    const content = jsonText(ledger);
    if (prior !== content) {
      atomicWrite(plan.target.ledgerPath, content);
      result.written.push(plan.target.ledgerPath);
    }
  }
  return result;
}

/* ------------------------------ uninstall ------------------------------ */

function pruneEmptyDirs(dir, stop) {
  let d = dir;
  while (d.startsWith(stop) && d !== stop) {
    try {
      if (fs.readdirSync(d).length) break;
      fs.rmdirSync(d);
    } catch {
      break;
    }
    d = path.dirname(d);
  }
}

export function planUninstall(o = {}) {
  const manifest = o.manifest ?? loadManifest(o.adapterDir);
  const target = targetsFor(o);
  const plan = { mode: 'uninstall', target, actions: [], conflicts: [], warnings: [], notes: [], keepLedger: false };
  const ledgerRead = readJson(target.ledgerPath);
  const ledger = ledgerRead.data && ledgerRead.data.owner === OWNER ? ledgerRead.data : null;
  if (ledgerRead.exists && !ledger) plan.conflicts.push({ code: 'foreign-ledger', blocking: false, message: `${target.ledgerPath} exists but is not an adapter ledger; ledger-based removal skipped` });

  // skill: proven by the owner file inside the folder
  const dir = path.join(target.skillsDir, manifest.skillName ?? SKILL_NAME);
  const ownerPath = path.join(dir, OWNER_FILE);
  const owner = readJson(ownerPath).data;
  if (exists(dir)) {
    if (!owner || owner.owner !== OWNER) plan.notes.push(`${dir} is not owned by this adapter; left alone`);
    else {
      for (const [rel, hash] of Object.entries(owner.files ?? {})) {
        const file = path.join(dir, rel);
        const current = readText(file);
        if (current === null) continue;
        if (sha256(current) === hash) plan.actions.push({ kind: 'file', op: 'remove', path: file });
        else {
          plan.warnings.push(`${file} has local changes; kept`);
          plan.keepLedger = true;
        }
      }
      plan.actions.push({ kind: 'file', op: 'remove', path: ownerPath });
      plan.pruneDir = { dir, stop: target.skillsDir };
    }
  }

  // hook: marker AND ledger entry required
  if (exists(target.settingsPath)) {
    let settings;
    try {
      settings = readSettings(target.settingsPath);
    } catch (e) {
      if (!(e instanceof SettingsError)) throw e;
      plan.conflicts.push({ code: 'invalid-settings', blocking: false, message: e.message });
      plan.keepLedger = true;
    }
    if (settings) {
      const ledgerCommands = (ledger?.hooks ?? []).filter((h) => path.resolve(h.settingsPath) === path.resolve(target.settingsPath)).map((h) => h.command);
      const r = planHookRemove(settings.data, ledgerCommands);
      if (r.action === 'ambiguous') {
        plan.conflicts.push({ code: 'ambiguous-hook', blocking: false, message: `${target.settingsPath} has a hook with the ${OWNER} marker that the ledger does not record; refusing to remove it. Remove it by hand if you are sure.` });
        plan.keepLedger = true;
      } else if (r.changed) {
        const entry = (ledger?.hooks ?? []).find((h) => path.resolve(h.settingsPath) === path.resolve(target.settingsPath));
        const empty = Object.keys(r.next).length === 0 && entry?.settingsCreated;
        plan.actions.push(empty ? { kind: 'file', op: 'remove', path: target.settingsPath, backupFirst: true } : { kind: 'settings', op: 'update', path: target.settingsPath, next: r.next, existed: true });
      }
    }
  }

  // CLAUDE.md block: marker pair AND ledger entry required
  const mdText = readText(target.claudeMdPath);
  if (mdText !== null && mdText.includes(`BEGIN ${OWNER}`)) {
    const recorded = (ledger?.claudeMd ?? []).some((c) => path.resolve(c.path) === path.resolve(target.claudeMdPath));
    const r = removeBlock(mdText);
    if (!recorded) {
      plan.conflicts.push({ code: 'ambiguous-block', blocking: false, message: `${target.claudeMdPath} contains an ${OWNER} block that the ledger does not record; left alone` });
      plan.keepLedger = true;
    } else if (r.op === 'conflict') {
      plan.conflicts.push({ code: 'malformed-markers', blocking: false, message: `${target.claudeMdPath} has unbalanced ${OWNER} markers; left alone` });
      plan.keepLedger = true;
    } else if (r.op === 'update') {
      const created = (ledger?.claudeMd ?? []).find((c) => path.resolve(c.path) === path.resolve(target.claudeMdPath))?.created;
      plan.actions.push(r.content === '' && created ? { kind: 'file', op: 'remove', path: target.claudeMdPath } : { kind: 'file', op: 'update', path: target.claudeMdPath, content: r.content });
    }
  }

  if (o.purgeConfig && target.kind === 'user' && exists(target.configPath)) plan.actions.push({ kind: 'file', op: 'remove', path: target.configPath });
  else if (exists(target.configPath)) plan.notes.push(`${target.configPath} is user configuration and was kept (use --purge-config to remove it)`);
  if (ledgerRead.exists && ledger && !plan.keepLedger) plan.actions.push({ kind: 'file', op: 'remove', path: target.ledgerPath });
  if (plan.keepLedger) plan.notes.push('the ledger was kept because some items could not be removed safely');
  return plan;
}

export function applyUninstall(plan, { now = new Date() } = {}) {
  const result = { written: [], removed: [], backups: [] };
  for (const a of plan.actions) {
    if (a.kind === 'file' && a.op === 'remove') {
      if (a.backupFirst && exists(a.path)) {
        const b = backupName(a.path, now);
        fs.copyFileSync(a.path, b);
        result.backups.push(path.resolve(b));
      }
      fs.rmSync(a.path, { force: true });
      result.removed.push(a.path);
    } else if (a.kind === 'file') {
      atomicWrite(a.path, a.content);
      result.written.push(a.path);
    } else if (a.kind === 'settings') {
      const backup = writeSettings(a.path, a.next, { existed: a.existed, now });
      result.written.push(a.path);
      if (backup) result.backups.push(backup);
    }
  }
  if (plan.pruneDir) {
    const sub = path.join(plan.pruneDir.dir, 'references');
    pruneEmptyDirs(path.join(plan.pruneDir.dir, 'scripts'), plan.pruneDir.stop);
    pruneEmptyDirs(sub, plan.pruneDir.stop);
    pruneEmptyDirs(plan.pruneDir.dir, plan.pruneDir.stop);
  }
  pruneEmptyDirs(path.dirname(plan.target.ledgerPath), plan.target.configDir);
  return result;
}

export function describePlan(plan) {
  const lines = [];
  lines.push(`${plan.mode} (${plan.target.kind} scope)`);
  for (const a of plan.actions) lines.push(`  ${a.op.padEnd(9)} ${a.path}${a.forced ? '  (forced)' : ''}`);
  for (const w of plan.warnings) lines.push(`  warning: ${w}`);
  for (const c of plan.conflicts) lines.push(`  ${c.blocking ? 'BLOCKED' : 'conflict'}: ${c.message}`);
  for (const n of plan.notes) lines.push(`  note: ${n}`);
  return lines.join('\n');
}

export { CONFIG_SCHEMA_VERSION, isOwnedCommand };
