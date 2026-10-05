import fs from 'node:fs';
import path from 'node:path';
import { ADAPTER, REPO, tree } from './helpers.mjs';

/**
 * Context-cost model. It measures what the adapter's *instructions* cause to be loaded, from the routing table in
 * skill/references/design-routing.md, in documents and bytes. Token figures are bytes/4, an approximation and not a
 * tokenizer measurement. It does not claim what Claude will actually read in a live session.
 */
export const APPROX_BYTES_PER_TOKEN = 4;

export function parseRouting() {
  const text = fs.readFileSync(path.join(ADAPTER, 'skill/references/design-routing.md'), 'utf8');
  const rows = [];
  for (const line of text.split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 5 || cells[1] === 'Task' || /^-+$/.test(cells[1])) continue;
    const load = [...cells[2].matchAll(/`([^`]+\.md)`/g)].map((m) => m[1].replace('<platform>', 'WEB'));
    rows.push({ task: cells[1], load, none: /^none$/i.test(cells[2]) });
  }
  return rows;
}

const size = (rel) => fs.statSync(path.join(REPO, rel)).size;

export function systemSize() {
  let bytes = 0;
  let docs = 0;
  for (const dir of ['core', 'ai', 'platforms']) {
    for (const f of tree(path.join(REPO, dir)).filter((x) => x.endsWith('.md'))) {
      bytes += size(`${dir}/${f}`);
      docs++;
    }
  }
  return { bytes, docs };
}

export function fixedCost() {
  const skill = fs.statSync(path.join(ADAPTER, 'skill/SKILL.md')).size;
  const routing = fs.statSync(path.join(ADAPTER, 'skill/references/design-routing.md')).size;
  const claudeMd = fs.statSync(path.join(ADAPTER, 'CLAUDE.md')).size;
  return { skill, routing, claudeMd };
}

export function scenarioCost(rowMatch) {
  const row = parseRouting().find((r) => rowMatch.test(r.task));
  if (!row) throw new Error(`no routing row for ${rowMatch}`);
  const docs = row.load;
  const bytes = docs.reduce((n, d) => n + size(d), 0);
  return { task: row.task, docs, documentCount: docs.length, bytes };
}

export const tokens = (bytes) => Math.round(bytes / APPROX_BYTES_PER_TOKEN);
