// Static checks without third-party tools: syntax of every module, and no third-party imports.
// (There is no linter or type checker in this repository because adding one would add a dependency.)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', 'fixtures']);
const files = [];
(function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(ent.name)) continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(abs);
    else if (ent.name.endsWith('.mjs')) files.push(abs);
  }
})(root);

let failures = 0;
for (const file of files) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    failures++;
    process.stderr.write(`syntax error in ${path.relative(root, file)}\n${r.stderr}\n`);
  }
  const text = fs.readFileSync(file, 'utf8');
  for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s+['"]([^'"]+)['"]/g)) {
    const spec = m[1];
    if (!spec.startsWith('.') && !spec.startsWith('node:')) {
      failures++;
      process.stderr.write(`third-party import "${spec}" in ${path.relative(root, file)}\n`);
    }
  }
}
process.stdout.write(`checked ${files.length} modules: ${failures ? failures + ' problem(s)' : 'ok'}\n`);
process.exit(failures ? 1 : 0);
