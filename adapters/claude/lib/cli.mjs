import path from 'node:path';
import { fileURLToPath } from 'node:url';

export class UsageError extends Error {}

/** Minimal argument parser: flags and valued options, no dependencies. */
export function parseArgs(argv, { flags = [], values = [] }) {
  const out = { _: [], opts: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (flags.includes(a)) out.opts[a.slice(2)] = true;
    else if (values.includes(a)) {
      if (i + 1 >= argv.length) throw new UsageError(`${a} needs a value`);
      out.opts[a.slice(2)] = argv[++i];
    } else if (a.startsWith('--')) throw new UsageError(`unknown option ${a}`);
    else out._.push(a);
  }
  return out;
}

/** True when `metaUrl` is the module being run directly. */
export function isMain(metaUrl) {
  return !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(metaUrl);
}

export function makeIo(stream = process) {
  return { out: (t) => stream.stdout.write(t.endsWith('\n') ? t : t + '\n'), err: (t) => stream.stderr.write(t.endsWith('\n') ? t : t + '\n') };
}
