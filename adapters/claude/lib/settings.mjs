import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite, fwd, readJson } from './util.mjs';

/** Identifier carried by every hook this adapter installs (also the CLAUDE.md block marker). */
export const OWNER = 'ERDEM_DESIGN_SYSTEM_CLAUDE_ADAPTER';
export const OWNER_FLAG = `--erdem-owner=${OWNER}`;
export const HOOK_EVENT = 'SessionStart';
export const HOOK_TIMEOUT_SECONDS = 5;

export class SettingsError extends Error {}

export function hookCommand(scriptPath, nodeCommand = 'node') {
  return `${nodeCommand} "${fwd(scriptPath)}" ${OWNER_FLAG}`;
}

export const isOwnedCommand = (command) => typeof command === 'string' && command.includes(OWNER_FLAG);

/** Parse a settings file. Invalid JSON is never "repaired": the caller must stop and explain. */
export function readSettings(file) {
  const r = readJson(file);
  if (!r.exists) return { exists: false, data: {}, raw: null };
  if (r.error) throw new SettingsError(`${file} is not valid JSON (${r.error}); it was left untouched`);
  if (r.data === null || typeof r.data !== 'object' || Array.isArray(r.data)) throw new SettingsError(`${file} must contain a JSON object; it was left untouched`);
  return { exists: true, data: r.data, raw: r.raw };
}

/** Hooks of the event that are not ours: reported, never modified. Only the program name is returned. */
export function foreignHooks(data, event = HOOK_EVENT) {
  const groups = Array.isArray(data?.hooks?.[event]) ? data.hooks[event] : [];
  const out = [];
  for (const g of groups) {
    for (const h of Array.isArray(g?.hooks) ? g.hooks : []) {
      if (!isOwnedCommand(h?.command)) out.push({ matcher: g.matcher ?? null, type: h?.type ?? null, program: String(h?.command ?? h?.url ?? '').trim().split(/\s+/)[0]?.slice(0, 40) ?? '' });
    }
  }
  return out;
}

export function ownedHooks(data, event = HOOK_EVENT) {
  const groups = Array.isArray(data?.hooks?.[event]) ? data.hooks[event] : [];
  const out = [];
  groups.forEach((g, gi) => (Array.isArray(g?.hooks) ? g.hooks : []).forEach((h, hi) => isOwnedCommand(h?.command) && out.push({ gi, hi, command: h.command })));
  return out;
}

/**
 * Plan adding (or updating) our hook. Existing hooks of any kind are preserved byte-for-byte in meaning and
 * order; ours is a separate matcher group appended to the event. Returns {changed, next, action}.
 */
export function planHookInstall(data, command, event = HOOK_EVENT) {
  const next = structuredClone(data);
  const owned = ownedHooks(next, event);
  if (owned.length > 1) throw new SettingsError(`more than one hook carries the ${OWNER} marker; refusing to guess which to keep`);
  if (owned.length === 1) {
    const { gi, hi, command: current } = owned[0];
    const hook = next.hooks[event][gi].hooks[hi];
    if (current === command && hook.type === 'command' && hook.timeout === HOOK_TIMEOUT_SECONDS) return { changed: false, next, action: 'unchanged' };
    hook.type = 'command';
    hook.command = command;
    hook.timeout = HOOK_TIMEOUT_SECONDS;
    return { changed: true, next, action: 'update' };
  }
  if (next.hooks === undefined) next.hooks = {};
  if (typeof next.hooks !== 'object' || Array.isArray(next.hooks)) throw new SettingsError('"hooks" in settings is not an object; refusing to modify it');
  if (next.hooks[event] === undefined) next.hooks[event] = [];
  if (!Array.isArray(next.hooks[event])) throw new SettingsError(`hooks.${event} is not an array; refusing to modify it`);
  next.hooks[event].push({ hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_SECONDS }] });
  return { changed: true, next, action: 'add' };
}

/**
 * Plan removing our hook. Only a hook that carries the marker AND is recorded in the ledger is removed.
 * A matcher group is dropped only if our hook was the only thing in it.
 */
export function planHookRemove(data, ledgerCommands, event = HOOK_EVENT) {
  const next = structuredClone(data);
  const owned = ownedHooks(next, event);
  const ambiguous = owned.filter((o) => !ledgerCommands.includes(o.command));
  if (ambiguous.length) return { changed: false, next, action: 'ambiguous', ambiguous: ambiguous.length };
  if (owned.length === 0) return { changed: false, next, action: 'absent' };
  const groups = next.hooks[event];
  for (const { gi, hi } of [...owned].sort((a, b) => b.gi - a.gi || b.hi - a.hi)) {
    groups[gi].hooks.splice(hi, 1);
    if (groups[gi].hooks.length === 0 && Object.keys(groups[gi]).every((k) => k === 'hooks' || k === 'matcher')) groups.splice(gi, 1);
  }
  if (groups.length === 0) delete next.hooks[event];
  if (Object.keys(next.hooks).length === 0) delete next.hooks;
  return { changed: true, next, action: 'remove' };
}

export function backupName(file, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
  return `${file}.erdem-backup-${stamp}`;
}

/** Write settings, first saving the previous content next to it (once per change). Returns the backup path or null. */
export function writeSettings(file, data, { existed, now = new Date() } = {}) {
  let backup = null;
  if (existed) {
    backup = backupName(file, now);
    fs.copyFileSync(file, backup);
  }
  atomicWrite(file, JSON.stringify(data, null, 2) + '\n');
  return backup ? path.resolve(backup) : null;
}
