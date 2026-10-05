#!/usr/bin/env node
// Launcher bundled with the erdem skill. It finds the adapter and runs one command:
//   context | root | handoff-check | intel <project-intel arguments>
// It performs no work of its own and starts no shell.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.resolve(here, '..');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** ERDEM_ADAPTER_DIR, then the link written by a user-scope install, then the project's untracked ledger. */
function adapterDir() {
  if (process.env.ERDEM_ADAPTER_DIR) return process.env.ERDEM_ADAPTER_DIR;
  const link = readJson(path.join(skillDir, 'adapter-link.json'));
  if (link?.adapterDir) return link.adapterDir;
  // project scope: <project>/.agents/skills/erdem -> <project>/.agents/.erdem-antigravity-install.json
  const ledger = readJson(path.join(skillDir, '..', '..', '.erdem-antigravity-install.json'));
  return ledger?.adapterDir ?? null;
}

const dir = adapterDir();
const entry = dir && path.join(dir, 'scripts', 'context.mjs');
if (!entry || !fs.existsSync(entry)) {
  process.stderr.write('erdem: the adapter checkout is not reachable (set ERDEM_ADAPTER_DIR, or re-run the installer). Continue by inspecting the repository directly.\n');
  process.exit(1);
}
const { main } = await import(pathToFileURL(entry).href);
process.exitCode = await main(process.argv.slice(2));
