import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.join(here, 'fixtures');
export const TOOLS_ROOT = path.resolve(here, '..');

const made = [];

export function tmpDir(prefix = 'pi-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/** Remove temp directories created by this process. Call from an `after` hook. */
export function cleanup() {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
}

/** Write a { 'rel/path': 'content' | Buffer } tree into a new temp directory. */
export function makeTree(files) {
  const dir = tmpDir();
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

/** Copy a committed fixture project into a temp directory so generated output never lands in the repository. */
export function copyFixture(name) {
  const dir = tmpDir();
  fs.cpSync(path.join(FIXTURES, name), dir, { recursive: true });
  return dir;
}

export function listTree(dir) {
  const out = [];
  (function walk(d) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, ent.name);
      if (ent.isDirectory()) walk(abs);
      else out.push(path.relative(dir, abs).split(path.sep).join('/'));
    }
  })(dir);
  return out.sort();
}

export function readAll(dir, sub) {
  const base = path.join(dir, sub);
  return listTree(base).map((rel) => ({ rel: `${sub}/${rel}`, text: fs.readFileSync(path.join(base, rel), 'utf8') }));
}

const ID = '[A-Za-z][A-Za-z0-9_]*';

/** Structural Mermaid check (not the official parser): returns a list of problems. */
export function validateMermaid(text) {
  const problems = [];
  const lines = text.split('\n').filter((l) => l.trim() && !l.trim().startsWith('%%'));
  if (lines[0] !== 'flowchart TD') problems.push(`first statement must be "flowchart TD", got ${JSON.stringify(lines[0])}`);
  let open = 0;
  const label = '"(?:[^"\\n]|#quot;)*"';
  const patterns = [
    new RegExp(`^\\s*subgraph ${ID}\\[${label}\\]$`),
    /^\s*end$/,
    new RegExp(`^\\s*${ID}(\\[${label}\\]|\\(\\[${label}\\]\\)|\\[\\[${label}\\]\\])$`),
    new RegExp(`^\\s*${ID} (-->|==>|-\\.->)(\\|[^|\\n"]+\\|)? ${ID}$`),
    new RegExp(`^\\s*classDef ${ID} [^\\n]+;$`),
    new RegExp(`^\\s*class ${ID}(,${ID})* ${ID};$`),
  ];
  for (const line of lines.slice(1)) {
    if (/^\s*subgraph /.test(line)) open++;
    if (/^\s*end$/.test(line)) open--;
    if (!patterns.some((p) => p.test(line))) problems.push(`unrecognized line: ${line}`);
    if (/[\\/]/.test(line.replace(label, '').replace(/"[^"]*"/g, ''))) problems.push(`path separator outside a label: ${line}`);
  }
  if (open !== 0) problems.push('unbalanced subgraph/end');
  return problems;
}

/** Structural DOT check (Graphviz is not required). */
export function validateDot(text) {
  const problems = [];
  const lines = text.split('\n').filter((l) => l.trim() && !l.trim().startsWith('//'));
  if (!/^digraph "[^"\\]*" \{$/.test(lines[0])) problems.push(`bad header: ${lines[0]}`);
  if (lines[lines.length - 1] !== '}') problems.push('missing closing brace');
  let depth = 0;
  for (const line of lines) {
    const stripped = line.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    if ((stripped.match(/"/g) ?? []).length % 2) problems.push(`unbalanced quotes: ${line}`);
    depth += (stripped.match(/\{/g) ?? []).length - (stripped.match(/\}/g) ?? []).length;
    const s = stripped.trim();
    const ok =
      /^digraph "" \{$/.test(s) ||
      s === '}' ||
      /^subgraph [A-Za-z_][A-Za-z0-9_]* \{$/.test(s) ||
      /^(graph|node|edge) \[.*\];$/.test(s) ||
      /^[A-Za-z_][A-Za-z0-9_]* \[.*\];$/.test(s) ||
      /^[A-Za-z_][A-Za-z0-9_]* -> [A-Za-z_][A-Za-z0-9_]*( \[.*\])?;$/.test(s) ||
      /^label=""; style=rounded;$/.test(s);
    if (!ok) problems.push(`unrecognized statement: ${line}`);
  }
  if (depth !== 0) problems.push('unbalanced braces');
  return problems;
}
