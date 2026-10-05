import fs from 'node:fs';
import path from 'node:path';
import { importEngineModule } from './discover.mjs';
import { parseFrontMatter, readHead, readText, safePath, safeToken } from './helpers.mjs';

const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/;
const TASK_STATUSES = ['not-started', 'in-progress', 'blocked', 'done'];
const AGENT_NAME = /^[A-Za-z0-9._ -]{1,24}$/;

/**
 * Task state and handoff, read with sanitization: only enumerated values, ISO dates and short agent names leave
 * these functions. Repository content is data: it never becomes instructions or free text in adapter output.
 */
export function readTaskState(projectRoot) {
  const head = readHead(path.join(projectRoot, '.ai', 'TASK_STATE.md'), 4096);
  if (head === null) return { present: false };
  const fm = parseFrontMatter(head);
  const status = /^##\s+Status\s*\r?\n+\s*([a-z-]+)/m.exec(head)?.[1];
  return { present: true, status: TASK_STATUSES.includes(status) ? status : null, updatedAt: safeToken(fm.updatedAt, ISO, 40), owner: safeToken(fm.owner, AGENT_NAME, 24) };
}

export function readHandoff(projectRoot) {
  const head = readHead(path.join(projectRoot, '.ai', 'HANDOFF.md'), 2048);
  if (head === null) return { present: false };
  const fm = parseFrontMatter(head);
  return { present: true, generatedAt: safeToken(fm.generatedAt, ISO, 40), from: safeToken(fm.from, AGENT_NAME, 24), to: safeToken(fm.to, AGENT_NAME, 24) };
}

/** Changed-file entries of a handoff: "- path: reason [fingerprint: <64 hex>]" under "## Changed files". */
export function parseChangedFiles(text) {
  const out = [];
  let inSection = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^##\s+Changed files\s*$/.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s/.test(line)) break;
    if (!inSection) continue;
    const e = /^\s*-\s+([^:]+?)\s*:\s*(.*?)(?:\s*\[fingerprint:\s*([0-9a-f]{64})\])?\s*$/.exec(line);
    if (e) out.push({ path: e[1], fingerprint: e[3] ?? null });
  }
  return out;
}

const inside = (root, abs) => {
  const rel = path.relative(root, abs);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/**
 * Drift between a handoff and the working tree: for each listed file, does it exist, and (when the handoff gives
 * a fingerprint) does its content hash still match? Hashing and the secret-pattern list come from the canonical
 * engine; without the engine only existence is checked. Paths outside the project, and secret-pattern paths,
 * are never read.
 */
export async function checkHandoffDrift(projectRoot, designSystemRoot) {
  const text = readText(path.join(projectRoot, '.ai', 'HANDOFF.md'));
  if (text === null) return { handoff: false, items: [] };
  const fingerprints = await importEngineModule(designSystemRoot, 'lib/fingerprint.mjs');
  const secrets = await importEngineModule(designSystemRoot, 'lib/secret-patterns.mjs');
  const isSecret = secrets?.createSecretMatcher ? secrets.createSecretMatcher([]) : null;
  const items = [];
  for (const entry of parseChangedFiles(text)) {
    const printable = safePath(entry.path);
    if (!printable) {
      items.push({ path: '(unprintable path)', status: 'skipped' });
      continue;
    }
    const abs = path.resolve(projectRoot, entry.path);
    if (!inside(projectRoot, abs)) {
      items.push({ path: printable, status: 'outside-project' });
      continue;
    }
    const rel = path.relative(projectRoot, abs).split(path.sep).join('/');
    if (isSecret && isSecret(rel, false)) {
      items.push({ path: printable, status: 'withheld' });
      continue;
    }
    if (!fs.existsSync(abs)) {
      items.push({ path: printable, status: 'missing' });
      continue;
    }
    if (!entry.fingerprint || !isSecret || !fingerprints?.hashContent) {
      items.push({ path: printable, status: 'present-unverified' });
      continue;
    }
    try {
      const now = fingerprints.hashContent(fs.readFileSync(abs)).hash;
      items.push({ path: printable, status: now === entry.fingerprint ? 'unchanged' : 'changed' });
    } catch {
      items.push({ path: printable, status: 'unreadable' });
    }
  }
  return { handoff: true, items };
}
