#!/usr/bin/env node
// Launcher bundled with the /erdem skill. It finds the adapter (so the skill text needs no absolute path) and
// runs one command: context | root | intel <project-intel arguments>. It performs no work of its own.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function adapterDir() {
  if (process.env.ERDEM_ADAPTER_DIR) return process.env.ERDEM_ADAPTER_DIR;
  try {
    return JSON.parse(fs.readFileSync(path.join(here, '..', 'adapter-link.json'), 'utf8')).adapterDir;
  } catch {
    return null;
  }
}

const dir = adapterDir();
const entry = dir && path.join(dir, 'scripts', 'context.mjs');
if (!entry || !fs.existsSync(entry)) {
  process.stderr.write('erdem: the adapter checkout is not reachable (set ERDEM_ADAPTER_DIR or re-run the installer). Continue by inspecting the repository directly.\n');
  process.exit(1);
}
const { main } = await import(pathToFileURL(entry).href);
process.exitCode = main(process.argv.slice(2));
