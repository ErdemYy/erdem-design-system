/**
 * Validation command discovery (ai/AUTOMATION_PROTOCOL.md → Validation: "commands come from the project; automation never
 * invents or guesses a command"). Reads a small, named set of project manifests and nothing else: the manifest nearest to each
 * changed file and the project root's. It executes nothing, writes nothing, reads no secret and no source file.
 *
 *   package.json    scripts whose names are validation names (test, lint, typecheck, build, ...): declared by the project
 *   pyproject.toml, Cargo.toml, pom.xml
 *                   the project names a tool but declares no command: the tool's standard invocation is offered as an A2 proposal
 *                   (reason `inferred-from-config`), never run on its own
 *   anything else   (Makefile, tox.ini, gradle, go.mod, ...) is reported as present and not parsed: free text and build systems
 *                   are not guessed at
 *
 * Every command carries `scriptDigest`, a SHA-256 over everything its classification depends on (the whole scripts table of its
 * manifest, hooks and nested scripts included, and the package manager; or the config file for an inferred command). The runner
 * calls `rediscoverCommand` right before it runs an action and refuses it when the definition has changed since planning.
 *
 * The commands found are untrusted data until validation-classify.mjs has classified them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { classifyText, combineClassification, executionFor, pathTargeting, summarizeScript, typeOfScriptName } from './validation-classify.mjs';
import { isSecretPath } from './path-safety.mjs';

export const DISCOVERY_BOUNDS = Object.freeze({ manifestDirs: 5, scriptsPerManifest: 40, manifestBytes: 262144, scriptChars: 1000 });
const NOT_PARSED = ['Makefile', 'makefile', 'tox.ini', 'noxfile.py', 'build.gradle', 'build.gradle.kts', 'go.mod', 'pubspec.yaml', 'justfile', 'Taskfile.yml', 'Rakefile', 'composer.json', 'Gemfile'];
const posix = (p) => p.split(path.sep).join('/');
const sha = (text) => createHash('sha256').update(text).digest('hex');

function readSmallText(abs) {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > DISCOVERY_BOUNDS.manifestBytes) return { tooLarge: st.isFile() && st.size > DISCOVERY_BOUNDS.manifestBytes };
    return { text: fs.readFileSync(abs, 'utf8') };
  } catch {
    return {};
  }
}

/** The directories (project-relative, "." for the root) whose package.json governs the changed files: the root and the nearest one above each file. */
function manifestDirs(root, changedFiles) {
  const dirs = new Set(['.']);
  for (const f of changedFiles) {
    if (isSecretPath(f)) continue;
    let d = path.posix.dirname(f);
    while (d && d !== '.') {
      if (fs.existsSync(path.join(root, ...d.split('/'), 'package.json'))) {
        dirs.add(d);
        break;
      }
      d = path.posix.dirname(d);
    }
  }
  return [...dirs].sort((a, b) => (a === '.' ? -1 : b === '.' ? 1 : a < b ? -1 : a > b ? 1 : 0));
}

function packageManagerOf(root, dir, pkg) {
  const field = typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : null;
  if (['npm', 'yarn', 'pnpm', 'bun'].includes(field)) return field;
  const has = (name) => [dir, '.'].some((d) => fs.existsSync(path.join(root, ...(d === '.' ? [] : d.split('/')), name)));
  if (has('pnpm-lock.yaml')) return 'pnpm';
  if (has('yarn.lock')) return 'yarn';
  if (has('bun.lockb') || has('bun.lock')) return 'bun';
  return 'npm';
}

/**
 * The shell npm will be told to use for scripts, resolved WITHOUT reading any configuration: cmd.exe of the system directory on
 * Windows, /bin/sh elsewhere. { id, path, digest } (the digest binds the resolved path without showing it) or { refused }.
 */
export function resolveScriptShell({ platform = process.platform, env = process.env, exists = (p) => fs.existsSync(p) } = {}) {
  const win = platform === 'win32';
  const p = win ? path.join(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'cmd.exe') : '/bin/sh';
  return exists(p) ? { id: win ? 'cmd.exe' : 'sh', path: p, digest: sha(p) } : { refused: 'script-shell-not-found' };
}

/**
 * The package manager's own configuration can change what a script runs (a script shell, hooks, registries). A file that matches a
 * secret pattern (.npmrc) is never read or hashed: only its existence enters the digest, and the plan says it is outside the binding.
 * Other configuration (.yarnrc, .yarnrc.yml) is hashed, never shown.
 */
function packageManagerConfig(root, dir) {
  const dirs = dir === '.' ? ['.'] : ['.', dir];
  const present = [];
  const digests = [];
  const unread = [];
  for (const d of dirs) {
    const base = d === '.' ? [] : d.split('/');
    for (const name of ['.npmrc', '.yarnrc', '.yarnrc.yml']) {
      const abs = path.join(root, ...base, name);
      if (!fs.existsSync(abs)) continue;
      const rel = d === '.' ? name : d + '/' + name;
      present.push(rel);
      if (isSecretPath(rel)) {
        unread.push(rel);
        continue;
      }
      const { text } = readSmallText(abs);
      digests.push([rel, text === undefined ? null : sha(text)]);
    }
  }
  return { present, digests, unread };
}

/** The validation commands of one package.json (read once, never executed). */
function packageCommands(root, dir) {
  const rel = dir === '.' ? 'package.json' : `${dir}/package.json`;
  const out = { rel, commands: [], limitations: [], read: false };
  const abs = path.join(root, ...rel.split('/'));
  if (!fs.existsSync(abs)) return out;
  const { text, tooLarge } = readSmallText(abs);
  if (tooLarge) {
    out.limitations.push(`${rel} is larger than ${DISCOVERY_BOUNDS.manifestBytes} bytes and was not read`);
    return out;
  }
  out.read = true;
  let pkg;
  try {
    pkg = JSON.parse(text);
  } catch {
    out.limitations.push(`${rel} is not valid JSON: no command was taken from it`);
    return out;
  }
  const scripts = pkg && typeof pkg.scripts === 'object' && pkg.scripts && !Array.isArray(pkg.scripts) ? Object.fromEntries(Object.entries(pkg.scripts).filter(([, v]) => typeof v === 'string')) : {};
  const pm = packageManagerOf(root, dir, pkg ?? {});
  // Everything the classification of any script of this manifest depends on: a change anywhere in it is a different command.
  const cfg = packageManagerConfig(root, dir);
  const scriptDigest = sha(JSON.stringify([pm, Object.keys(scripts).sort().map((k) => [k, scripts[k]]), cfg.present, cfg.digests]));
  let taken = 0;
  for (const name of Object.keys(scripts).sort()) {
    const type = typeOfScriptName(name);
    if (!type) continue;
    if (taken >= DISCOVERY_BOUNDS.scriptsPerManifest) {
      out.limitations.push(`${rel}: more than ${DISCOVERY_BOUNDS.scriptsPerManifest} validation scripts; the rest were not considered`);
      break;
    }
    taken++;
    const body = scripts[name];
    const classification = combineClassification(
      classifyText(body, { scripts }),
      scripts[`pre${name}`] !== undefined ? classifyText(scripts[`pre${name}`], { scripts }) : null,
      scripts[`post${name}`] !== undefined ? classifyText(scripts[`post${name}`], { scripts }) : null,
      body.length > DISCOVERY_BOUNDS.scriptChars ? { level: 'A2', reasons: ['unclear-command'] } : null,
    );
    out.commands.push({
      id: `pkg:${dir}:${name}`,
      type,
      source: `${rel}#scripts.${name}`,
      origin: 'declared',
      cwd: dir,
      argv: [pm, 'run', name],
      display: `${pm} run ${name}`,
      script: body.slice(0, DISCOVERY_BOUNDS.scriptChars),
      scriptSummary: summarizeScript(body),
      scriptDigest,
      hooks: ['pre', 'post'].filter((h) => scripts[`${h}${name}`] !== undefined),
      npmConfig: cfg.unread,
      execution: pm === 'npm' ? { ...executionFor('npm'), shellDigest: resolveScriptShell().digest ?? null } : executionFor(pm),
      targeting: pathTargeting(body),
      classification,
    });
  }
  return out;
}

const CONFIGS = [
  ['pyproject.toml', [[/^\[tool\.pytest(\.ini_options)?\]/m, 'pytest', 'unit-test', ['python', '-m', 'pytest'], { mode: 'append-paths', runner: 'pytest', narrows: true }], [/^\[tool\.ruff(\.[\w.]+)?\]/m, 'ruff', 'lint', ['ruff', 'check'], { mode: 'append-paths', runner: 'ruff', narrows: true }], [/^\[tool\.mypy\]/m, 'mypy', 'type-check', ['mypy', '.'], null]]],
  ['Cargo.toml', [[/^\[package\]|^\[workspace\]/m, 'cargo-check', 'type-check', ['cargo', 'check'], null], [/^\[package\]|^\[workspace\]/m, 'cargo-test', 'unit-test', ['cargo', 'test'], null]]],
  ['pom.xml', [[/<project[\s>]/, 'maven-test', 'unit-test', ['mvn', '-q', 'test'], null]]],
];

/** Tools the project names without declaring a command: proposals only. */
function configCommands(root) {
  const out = { commands: [], sources: [], limitations: [] };
  for (const [file, rules] of CONFIGS) {
    const { text, tooLarge } = readSmallText(path.join(root, file));
    if (tooLarge) out.limitations.push(`${file} is larger than ${DISCOVERY_BOUNDS.manifestBytes} bytes and was not read`);
    if (text === undefined) continue;
    out.sources.push(file);
    for (const [re, id, type, argv, targeting] of rules) {
      if (!re.test(text)) continue;
      out.commands.push({
        id: `cfg:${id}`, type, source: `${file}#${id}`, origin: 'inferred', cwd: '.', argv, display: argv.join(' '), script: argv.join(' '), scriptSummary: argv.join(' '), scriptDigest: sha(JSON.stringify([file, text])), hooks: [], targeting, execution: executionFor(argv[0]),
        classification: combineClassification({ level: 'A2', reasons: ['inferred-from-config'] }, /^(cargo|mvn)$/.test(argv[0]) ? { level: 'A2', reasons: ['network-possible'] } : null),
      });
    }
  }
  return out;
}

/**
 * @param {string} root         the project root (an absolute path)
 * @param {{changedFiles?: string[]}} opts  project-relative changed paths, to find the manifests that govern them
 * @returns {{commands: object[], sources: string[], notParsed: string[], limitations: string[]}}
 */
export function discoverCommands(root, { changedFiles = [] } = {}) {
  const commands = [];
  const sources = [];
  const limitations = [];
  const dirsAll = manifestDirs(root, changedFiles);
  const dirs = dirsAll.slice(0, DISCOVERY_BOUNDS.manifestDirs);
  if (dirsAll.length > dirs.length) limitations.push(`${dirsAll.length - dirs.length} more package manifest(s) govern the changed files and were not read (limit ${DISCOVERY_BOUNDS.manifestDirs})`);
  for (const dir of dirs) {
    const p = packageCommands(root, dir);
    if (p.read) sources.push(p.rel);
    commands.push(...p.commands);
    limitations.push(...p.limitations);
  }
  const cfg = configCommands(root);
  commands.push(...cfg.commands);
  sources.push(...cfg.sources);
  limitations.push(...cfg.limitations);
  const notParsed = NOT_PARSED.filter((n) => fs.existsSync(path.join(root, n))).filter((n, i, all) => all.findIndex((m) => m.toLowerCase() === n.toLowerCase()) === i).sort();
  if (notParsed.length) limitations.push(`present and not parsed (commands are never guessed): ${notParsed.join(', ')}`);
  commands.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { commands, sources: sources.map(posix), notParsed, limitations };
}

/**
 * Read the definition of ONE command again, from its source, right now. The runner uses this immediately before executing an
 * action: what it finds, and not what the plan remembers, is what would run.
 * @returns the command (same shape as discoverCommands) or null when the project no longer defines it
 */
export function rediscoverCommand(root, commandId) {
  const id = String(commandId ?? '');
  if (id.startsWith('pkg:')) {
    const rest = id.slice(4);
    const i = rest.indexOf(':');
    if (i < 0) return null;
    const dir = rest.slice(0, i);
    if (dir.split('/').includes('..') || path.isAbsolute(dir)) return null;
    return packageCommands(root, dir).commands.find((c) => c.id === id) ?? null;
  }
  if (id.startsWith('cfg:')) return configCommands(root).commands.find((c) => c.id === id) ?? null;
  return null;
}
