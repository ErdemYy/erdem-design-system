import fs from 'node:fs';
import path from 'node:path';
import { ADAPTER_DIR, AGENTS_DEFAULT_MAX_BYTES, AGENTS_FILE, AGENTS_OVERRIDE_FILE, SELF_ROOT, SKILL_NAME, projectTargets, userTargets } from './paths.mjs';
import { DEFAULT_CONFIG, loadAdapterConfig } from './config.mjs';
import { atomicWrite, exists, fwd, jsonText, readJson, readText, sha256 } from './helpers.mjs';

/**
 * Safe install and uninstall of the Codex adapter. Everything is planned first (pure), then applied.
 * Ownership is proven by an owner file inside the skill folder, a marker pair in the instructions file,
 * and a ledger. Nothing foreign is overwritten or removed, and nothing outside the owned scope is touched.
 *
 * Integration points (documented by OpenAI; see README): the skill folder under .agents/skills, and a
 * marker-delimited block in AGENTS.md (or AGENTS.override.md when that file exists, because Codex loads at most
 * one instruction file per directory and the override wins). Hooks and config.toml are deliberately not touched.
 */

export const OWNER = 'ERDEM_DESIGN_SYSTEM_CODEX_ADAPTER';
const OWNER_FILE = '.erdem-owner.json';
const LINK_FILE = 'adapter-link.json';
const BEGIN = `<!-- BEGIN ${OWNER} -->`;
const END = `<!-- END ${OWNER} -->`;

export function loadManifest(adapterDir = ADAPTER_DIR) {
  return JSON.parse(fs.readFileSync(path.join(adapterDir, 'adapter-manifest.json'), 'utf8'));
}

function targetsFor(o) {
  if (o.scope === 'project') {
    if (!o.projectDir) throw new Error('--project <dir> is required with --scope project');
    return projectTargets(o.projectDir);
  }
  return userTargets({ codexHomeDir: o.codexHome, agentsHome: o.agentsHome, env: o.env, home: o.home });
}

/** The instructions file Codex would actually load in a directory: the override if present, else AGENTS.md. */
export function instructionsFile(dir) {
  return path.join(dir, exists(path.join(dir, AGENTS_OVERRIDE_FILE)) ? AGENTS_OVERRIDE_FILE : AGENTS_FILE);
}

/* ---------------------------------- skill ---------------------------------- */

function planSkill(o, target, manifest, plan) {
  const dir = path.join(target.skillsDir, manifest.skillName ?? SKILL_NAME);
  const adapterDir = o.adapterDir ?? ADAPTER_DIR;
  const desired = new Map();
  for (const f of manifest.files) desired.set(f.target, fs.readFileSync(path.join(adapterDir, f.source), 'utf8'));
  // User scope records where the adapter lives next to the skill; project scope keeps skill files path-free
  // (the location is kept only in the untracked ledger), so a committed skill never embeds this machine's paths.
  if (target.kind === 'user') desired.set(LINK_FILE, jsonText({ adapterDir: fwd(adapterDir), designSystemRoot: fwd(o.designSystemRoot ?? SELF_ROOT), adapterVersion: manifest.version }));

  const ownerPath = path.join(dir, OWNER_FILE);
  const ownerRead = readJson(ownerPath);
  const owner = ownerRead.data && ownerRead.data.owner === OWNER && ownerRead.data.files && typeof ownerRead.data.files === 'object' ? ownerRead.data : null;
  if (exists(dir) && !owner) {
    plan.conflicts.push({ code: 'foreign-skill', blocking: true, message: `${dir} exists and is not owned by this adapter (${ownerRead.error ? 'its owner file is not valid JSON' : 'no valid owner file'}); it was not touched. Rename or remove it, or install with --no-skill.` });
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
  const sorted = Object.fromEntries(Object.entries(finalHashes).sort(([a], [b]) => (a < b ? -1 : 1)));
  const ownerContent = jsonText({ owner: OWNER, adapterVersion: manifest.version, files: sorted });
  const cur = readText(ownerPath);
  plan.actions.push({ kind: 'file', op: cur === null ? 'create' : cur === ownerContent ? 'unchanged' : 'update', path: ownerPath, content: ownerContent });
  plan.skill = { dir, files: sorted };
}

/* ---------------------------------- config ---------------------------------- */

function planConfig(target, plan) {
  if (target.kind !== 'user') return;
  if (exists(target.configPath)) {
    plan.actions.push({ kind: 'file', op: 'unchanged', path: target.configPath });
    return;
  }
  plan.actions.push({ kind: 'file', op: 'create', path: target.configPath, content: jsonText({ ...DEFAULT_CONFIG }) });
  plan.configCreated = true;
}

/* -------------------------------- AGENTS block -------------------------------- */

export function planBlock(existing, source) {
  const eol = existing && existing.includes('\r\n') ? '\r\n' : '\n';
  const block = [BEGIN, ...source.trim().split(/\r?\n/), END].join(eol);
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
  const after = existing.slice(ei + END.length).replace(/^(\r?\n)/, '');
  before = before.replace(/(\r?\n){2,}$/, (m) => (m.includes('\r') ? '\r\n' : '\n'));
  const next = before + after;
  return { op: 'update', content: next.trim() === '' ? '' : next };
}

function planAgentsMd(o, target, manifest, plan) {
  const source = fs.readFileSync(path.join(o.adapterDir ?? ADAPTER_DIR, manifest.agentsMd.source), 'utf8');
  const file = instructionsFile(target.agentsDir);
  const existing = readText(file);
  const r = planBlock(existing, source);
  if (r.op === 'conflict') {
    plan.conflicts.push({ code: 'malformed-markers', blocking: true, message: `${file} contains unbalanced or duplicated ${OWNER} markers; it was not touched. Fix or remove the markers by hand.` });
    return;
  }
  plan.actions.push({ kind: 'file', op: r.op, path: file, content: r.content });
  plan.agentsMd = { path: file, created: existing === null || undefined };
  if (path.basename(file) === AGENTS_OVERRIDE_FILE) plan.notes.push(`${AGENTS_OVERRIDE_FILE} exists, and Codex loads it instead of ${AGENTS_FILE} in that directory, so the block goes there`);
  if (r.content && Buffer.byteLength(r.content) > AGENTS_DEFAULT_MAX_BYTES) plan.warnings.push(`${file} would exceed the default instruction limit of ${AGENTS_DEFAULT_MAX_BYTES} bytes (project_doc_max_bytes); Codex may cut off the end of the combined instructions`);
}

/* ---------------------------------- install ---------------------------------- */

export function planInstall(o = {}) {
  const manifest = o.manifest ?? loadManifest(o.adapterDir);
  const target = targetsFor(o);
  const plan = { mode: 'install', target, actions: [], conflicts: [], warnings: [], notes: [], skill: null, agentsMd: null };
  if (o.skill !== false) planSkill(o, target, manifest, plan);
  planConfig(target, plan);
  if (o.agentsMd) planAgentsMd(o, target, manifest, plan);
  if (target.kind === 'project') plan.notes.push('project scope: keep .agents/.erdem-codex-install.json out of version control (it records this machine\'s paths); the committed skill files contain none');
  const prior = readJson(target.ledgerPath).data;
  if (plan.agentsMd && (prior?.agentsMd ?? []).find((c) => path.resolve(c.path) === path.resolve(plan.agentsMd.path))?.created) plan.agentsMd.created = true;
  plan.ledger = {
    schemaVersion: 1,
    owner: OWNER,
    adapter: { name: manifest.name, version: manifest.version },
    scope: target.kind,
    designSystemRoot: fwd(o.designSystemRoot ?? SELF_ROOT),
    adapterDir: fwd(o.adapterDir ?? ADAPTER_DIR),
    skill: plan.skill ?? prior?.skill ?? null,
    agentsMd: plan.agentsMd ? [{ path: plan.agentsMd.path, created: plan.agentsMd.created }] : prior?.agentsMd ?? [],
    configCreated: plan.configCreated || prior?.configCreated || undefined,
  };
  return plan;
}

export function applyPlan(plan) {
  const result = { written: [], removed: [], unchanged: 0 };
  if (plan.conflicts.some((c) => c.blocking)) return { ...result, refused: true };
  for (const a of plan.actions) {
    if (a.op === 'unchanged') {
      result.unchanged++;
    } else if (a.op === 'remove') {
      fs.rmSync(a.path, { force: true });
      result.removed.push(a.path);
    } else {
      atomicWrite(a.path, a.content);
      result.written.push(a.path);
    }
  }
  if (plan.mode === 'install') {
    const content = jsonText(plan.ledger);
    if (readText(plan.target.ledgerPath) !== content) {
      atomicWrite(plan.target.ledgerPath, content);
      result.written.push(plan.target.ledgerPath);
    }
  }
  return result;
}

/* --------------------------------- uninstall --------------------------------- */

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
  if (ledgerRead.exists && !ledger) {
    plan.conflicts.push({ code: 'foreign-ledger', blocking: false, message: `${target.ledgerPath} exists but is not a valid adapter ledger; ledger-based removal was skipped and the file was left alone` });
    plan.keepLedger = true;
  }

  const dir = path.join(target.skillsDir, manifest.skillName ?? SKILL_NAME);
  const ownerPath = path.join(dir, OWNER_FILE);
  const owner = readJson(ownerPath).data;
  if (exists(dir)) {
    if (!owner || owner.owner !== OWNER || typeof owner.files !== 'object') plan.notes.push(`${dir} is not owned by this adapter; left alone`);
    else {
      for (const [rel, hash] of Object.entries(owner.files)) {
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

  const file = instructionsFile(target.agentsDir);
  const mdText = readText(file);
  if (mdText !== null && mdText.includes(`BEGIN ${OWNER}`)) {
    const entry = (ledger?.agentsMd ?? []).find((c) => path.resolve(c.path) === path.resolve(file));
    const r = removeBlock(mdText);
    if (!entry) {
      plan.conflicts.push({ code: 'ambiguous-block', blocking: false, message: `${file} contains an ${OWNER} block that the ledger does not record; left alone` });
      plan.keepLedger = true;
    } else if (r.op === 'conflict') {
      plan.conflicts.push({ code: 'malformed-markers', blocking: false, message: `${file} has unbalanced ${OWNER} markers; left alone` });
      plan.keepLedger = true;
    } else if (r.op === 'update') {
      plan.actions.push(r.content === '' && entry.created ? { kind: 'file', op: 'remove', path: file } : { kind: 'file', op: 'update', path: file, content: r.content });
    }
  }

  if (o.purgeConfig && target.kind === 'user' && exists(target.configPath)) plan.actions.push({ kind: 'file', op: 'remove', path: target.configPath });
  else if (exists(target.configPath)) plan.notes.push(`${target.configPath} is user configuration and was kept${target.kind === 'user' ? ' (use --purge-config to remove it)' : ''}`);
  if (ledger && !plan.keepLedger) plan.actions.push({ kind: 'file', op: 'remove', path: target.ledgerPath });
  if (plan.keepLedger && ledger) plan.notes.push('the ledger was kept because some items could not be removed safely');
  return plan;
}

export function applyUninstall(plan) {
  const result = { written: [], removed: [] };
  for (const a of plan.actions) {
    if (a.op === 'remove') {
      fs.rmSync(a.path, { force: true });
      result.removed.push(a.path);
    } else {
      atomicWrite(a.path, a.content);
      result.written.push(a.path);
    }
  }
  if (plan.pruneDir) {
    pruneEmptyDirs(path.join(plan.pruneDir.dir, 'scripts'), plan.pruneDir.stop);
    pruneEmptyDirs(path.join(plan.pruneDir.dir, 'references'), plan.pruneDir.stop);
    pruneEmptyDirs(plan.pruneDir.dir, plan.pruneDir.stop);
  }
  pruneEmptyDirs(path.dirname(plan.target.ledgerPath), plan.target.kind === 'user' ? plan.target.codexHome : plan.target.projectDir);
  return result;
}

export function describePlan(plan) {
  const lines = [`${plan.mode} (${plan.target.kind} scope)`];
  for (const a of plan.actions) lines.push(`  ${a.op.padEnd(9)} ${a.path}${a.forced ? '  (forced)' : ''}`);
  for (const w of plan.warnings) lines.push(`  warning: ${w}`);
  for (const c of plan.conflicts) lines.push(`  ${c.blocking ? 'BLOCKED' : 'conflict'}: ${c.message}`);
  for (const n of plan.notes) lines.push(`  note: ${n}`);
  return lines.join('\n');
}

export { loadAdapterConfig };
