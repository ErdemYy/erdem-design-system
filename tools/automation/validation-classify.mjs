/**
 * Classification of validation commands (ai/AUTOMATION_PROTOCOL.md → Validation, Automation levels, Safety boundaries).
 * Pure: no file access, no process, no network. Command text is untrusted project data until classified here; this module
 * only reads text and answers one question: which automation level does it need, and why.
 *
 *   A1  a project-declared check whose effects can be read from its text: a known checker used in a form that is known to be
 *       read-only (verified patterns, never a whole-tool allowance)
 *   A2  unclear, may need the network, expensive or external, long-running, writes, runs a project script, expands the
 *       environment (fails closed: "an action that cannot be classified is A2")
 *   A3  installs, publishes, deploys, migrates, rewrites version-control history, destroys data, downloads, reads secrets
 *
 * The most restrictive part wins. Nothing here lowers a level: lowering an A2 is a named, scoped standing opt-in of the
 * caller (validation-plan.mjs, optInCovers), and A3 can never be lowered by anything.
 */

import { isSecretPath } from './path-safety.mjs';

export const ACTION_TYPES = Object.freeze(['syntax', 'unit-test', 'integration-test', 'type-check', 'lint', 'build', 'static-analysis', 'security-check', 'targeted-check']);
export const LEVEL_ORDER = Object.freeze(['A1', 'A2', 'A3']);
const worse = (a, b) => (LEVEL_ORDER.indexOf(b) > LEVEL_ORDER.indexOf(a) ? b : a);

/** Reason codes, by level. Stable words: they are what a decline and an opt-in name (validation-plan.mjs). */
export const A3_REASONS = Object.freeze(['install', 'publish', 'deploy', 'git-history', 'destructive', 'migration', 'download', 'secrets', 'privilege']);
export const A2_REASONS = Object.freeze(['unclear-command', 'network-possible', 'external-tool', 'expensive', 'mutating', 'shell-construct', 'inferred-from-config', 'validation-set', 'project-script', 'env-expansion', 'env-assignment', 'long-running']);
/** A2 reasons that no opt-in may lower: they expose or cannot be read from the text. */
export const NEVER_LOWERABLE = Object.freeze(['shell-construct', 'env-expansion', 'env-assignment']);

/**
 * How a package-manager command is executed. For npm every setting that decides WHAT a script runs under is pinned on the command
 * line (the highest-precedence source: it beats npm_config_* variables and every .npmrc, none of which is read): the script shell,
 * whether lifecycle scripts run, and where the node path goes. yarn, pnpm and bun cannot be pinned here, so they are not run.
 */
export function executionFor(exe) {
  if (exe === 'npm') return { manager: 'npm', scriptShell: 'platform-default', ignoreScripts: false, prependNodePath: 'warn-only', shellDigest: null };
  if (['yarn', 'pnpm', 'bun'].includes(exe)) return { manager: exe, pinned: false };
  return { manager: 'direct' };
}

/** The flags that pin npm's execution, for a script shell resolved to `shellPath`. */
export function pinArgs(execution, shellPath) {
  if (execution?.manager !== 'npm') return [];
  return ['--script-shell=' + shellPath, '--ignore-scripts=' + String(!!execution.ignoreScripts), '--scripts-prepend-node-path=' + execution.prependNodePath];
}

/** The arguments that are really passed: the manifest command, then the pins, then exactly the planned files. */
export function effectiveArgv(command, shellPath) {
  const base = command.baseArgv ?? command.argv;
  return [...base, ...pinArgs(command.execution, shellPath), ...command.argv.slice(base.length)];
}

/** Which script names are validation, and of what type. Anything else is not a validation command. */
export function typeOfScriptName(name) {
  const n = String(name);
  if (/^(pre|post)/.test(n) && /^(pre|post)(test|lint|build|typecheck|check|install|publish|deploy)/.test(n)) return null; // lifecycle hooks are classified with their script, never run on their own
  if (/(^|[:\-_])(integration|e2e|acceptance|system|smoke)([:\-_]|$)/.test(n)) return 'integration-test';
  if (/^(test|tests|spec|specs)([:\-_].*)?$/.test(n) || /^(unit|jest|vitest|mocha|pytest)$/.test(n)) return 'unit-test';
  if (/^(lint|eslint|stylelint|format:check|prettier:check|fmt:check|check:format|check-format)([:\-_].*)?$/.test(n) || /^lint/.test(n)) return 'lint';
  if (/^(typecheck|type-check|types|tsc|check:types|check-types|typecheck:.*|type-check:.*)$/.test(n)) return 'type-check';
  if (/^(build|compile)([:\-_].*)?$/.test(n)) return 'build';
  if (/^(security|audit|sast|secrets|scan)([:\-_].*)?$/.test(n)) return 'security-check';
  if (/^(analy[sz]e|static|sonar|codeql)([:\-_].*)?$/.test(n)) return 'static-analysis';
  if (/^(check|checks|verify|validate)([:\-_].*)?$/.test(n)) return 'targeted-check';
  return null;
}

/**
 * Runners that take file paths after their own options. `narrows` says whether appending paths is known to REPLACE what the
 * script would run (so the run is narrower), and only then is a run called narrow: jest takes regular expressions, mocha merges
 * the paths with its configured spec, and a script that already names a path keeps running it.
 */
const PATH_RUNNERS = [
  [/^node\s+(--[a-z-]+\s+)*--test(\s|$)/, 'node-test', true],
  [/^vitest(\s+run)?(\s|$)/, 'vitest', true],
  [/^jest(\s|$)/, 'jest', false],
  [/^mocha(\s|$)/, 'mocha', false],
  [/^ava(\s|$)/, 'ava', true],
  [/^pytest(\s|$)/, 'pytest', true],
  [/^python3?\s+-m\s+pytest(\s|$)/, 'pytest', true],
];
const SHELL_OPERATORS = /&&|\|\||[;|&\n]|\$\(|`|<\(|>>?|<(?!=)/;
/** Characters a runner would read as a pattern or a glob instead of a literal path. */
export const PATTERN_CHARS = /[[\]{}()*?!^$|\\+]/;
export const PATTERN_RUNNERS = Object.freeze(['jest', 'mocha', 'node-test', 'ava']);

/** `append-paths` when the script is one plain command of a runner that accepts paths; otherwise null (nothing is guessed). */
export function pathTargeting(body) {
  const text = String(body ?? '').trim().replace(/^(\w+=\S+\s+)+/, '');
  if (!text || SHELL_OPERATORS.test(text)) return null;
  const hit = PATH_RUNNERS.find(([re]) => re.test(text));
  if (!hit) return null;
  const rest = text.split(/\s+/).slice(1).filter((t) => !t.startsWith('-') && !['run', 'node'].includes(t));
  // a script that already names a path or a pattern keeps running it after the appended paths
  return { mode: 'append-paths', runner: hit[1], narrows: hit[2] && rest.length === 0 };
}

// ---- classification ---------------------------------------------------------------------------------------------

const A3_RULES = [
  ['install', /^(npm|pnpm|yarn|bun)\s+(i|install|add|ci|update|upgrade|up|remove|rm|uninstall|link|dedupe|prune)(\s|$)/],
  ['install', /^(pip3?|pipx|uv|poetry|conda|mamba)\s+(install|uninstall|add|remove|sync|update|upgrade)(\s|$)/],
  ['install', /^python3?\s+-m\s+pip\s+(install|uninstall)(\s|$)/],
  ['install', /^(python3?|py)\s+(\S+[\\/])?setup\.py\s+(install|develop|upload|register|bdist\S*|sdist)(\s|$)/],
  ['install', /^deno\s+(install|uninstall|add|remove|upgrade)(\s|$)/],
  ['install', /^(npm|pnpm|yarn|bun)\s+(init|create)(\s|$)/],
  ['install', /\b(playwright|cypress|puppeteer|husky|lefthook|pre-commit)\s+install\b/],
  ['install', /(^|\s)--(install-types|install-hook|init)(\s|=|$)/],
  ['install', /^(apt|apt-get|dnf|yum|brew|choco|winget|scoop|gem\s+install|composer\s+(install|require|update)|cargo\s+(install|add|update)|go\s+(get|install)|dotnet\s+(add|tool))(\s|$)/],
  ['publish', /(^|\s)publish(\s|$)|\b(twine|vsce|ovsx)\b/],
  ['deploy', /(^|\s)deploy(\s|$)|^(vercel|netlify|firebase|wrangler|serverless|sls|heroku|fly|flyctl|kubectl|helm|terraform|pulumi|ansible-playbook|cdk|sam)\b|^docker\s+push|^gh\s+release|^npm\s+(run\s+)?release\b/],
  ['git-history', /^git\s+(commit|push|pull|fetch|clone|rebase|merge|reset|clean|stash|tag|branch|checkout|switch|cherry-pick|revert|am|restore|gc|prune|filter-branch|update-ref|worktree|submodule|config|init|add|rm|mv|apply)(\s|$)/],
  ['destructive', /^(rm|rmdir|del|erase|rd|shred|truncate|mkfs|dd|format|remove-item|ri)\b|\s-(rf|fr)\b|--force-with-lease/],
  ['migration', /\bmigrat(e|es|ion|ions)\b|\bdb[:\s-](push|reset|seed|drop)\b|\balembic\s+(upgrade|downgrade)\b|\bflyway\b|\bliquibase\b|\bprisma\s+(migrate|db)\b|\brake\s+db:/],
  ['download', /^(curl|wget|iwr|invoke-webrequest|invoke-restmethod|irm|scp|ssh|ftp|sftp|rsync|nc|ncat|telnet|ping|nslookup)\b/],
  ['secrets', /(^|[\s/\\=])\.env(\.[\w.-]+)?(\s|$)|\bid_(rsa|dsa|ecdsa|ed25519)\b|\.pem(\s|$)|\.p12(\s|$)|\.pfx(\s|$)|\bcredentials?(\.json)?\b|\bprintenv\b|^env(\s|$)|^set(\s|$)|\bGet-ChildItem\s+env:/],
  ['privilege', /^(sudo|su|doas|runas)\b/],
];

const A2_RULES = [
  ['network-possible', /\baudit\b|^(npx|pnpx|bunx)(\s|$)|^bun\s+x(\s|$)|^(pnpm|yarn)\s+dlx\b|^npm\s+(exec|view|info|search|outdated|doctor|ping)(\s|$)|^(cargo|go|mvn|mvnw|gradle|gradlew|dotnet|bundle|composer|pod|flutter|dart)\b/],
  ['external-tool', /^(docker|podman|docker-compose|snyk|trivy|sonar-scanner|lighthouse|codecov|newman)\b/],
  ['expensive', /\b(e2e|cypress|playwright|selenium|puppeteer|webdriver|appium|detox)\b/],
  ['mutating', /(^|\s)(--(fix|fix-only|fix-type|unsafe-fixes?|write|update|updatesnapshot|update-snapshots?|snapshot-update|test-update-snapshots|fix-dry-run|in-place|apply|apply-unsafe|auto-correct(-all)?|autocorrect(-all)?|safe-auto-correct|safe-autocorrect|auto-gen-config|fix-layout|add-noqa|force-regen|incremental|tsbuildinfofile|generatetrace|cache|cache-dir|cache-location|coverage(-[\w]+)?|createstub|create-stub|output(-file)?|outfile|out-dir|outdir|basetemp|junitxml|junit-xml|junit-path|html-report|xml-report|txt-report|report-dir|cov-report|report-log|log-file|logfile|tee)|-w|-u|-i|-o)(\s|=|$)|^prettier\b(?!.*(--check|-c\b|--list-different|-l\b))/],
];

/** Processes that do not end by themselves (servers, watchers, dev servers). */
const LONG_RUNNING = /(^|\s)(serve|dev|start|preview|watch|watchall)(\s|$)|(^|\s)--(watch|watchall|serve|dev|interactive)(\s|=|$)|http\.server|live-server|nodemon|webpack-dev-server|^(vite|next|nuxt|astro|parcel|gatsby|remix|storybook)(\s*$|\s+(-|\.))|^vitest(?!.*(^|\s)(run|--run)(\s|$))/;

// ---- verified read-only forms ---------------------------------------------------------------------------------------------------------
//
// A command is A1 only when its form is PROVEN read-only and bounded: a known tool, its subcommand, and every flag and positional
// argument checked against a table of what that tool may be given. A flag that is not in the table is not "probably fine": the
// command is A2 (`mutating` when the flag family writes, otherwise `unclear-command`). No tool is trusted by name alone.

const KINDS = {
  n: (v) => /^\d{1,6}$/.test(v ?? ''),
  w: (v) => /^[\w.:-]{1,40}$/.test(v ?? ''),
  l: (v) => /^[\w.,:*+/-]{1,120}$/.test(v ?? ''),
  e: (v) => /^[\w\s().,!:*[\]-]{1,100}$/.test(v ?? ''),
  p: (v) => pathOk(v),
  f: (v) => /^(?:[\w.:-]|%[A-Za-z]){1,60}$/.test(v ?? ''), // a git format: words and %X placeholders only
};

/** A plain project-relative path or glob: no scheme, no drive, not absolute, no "..", no home, no secret path. */
/** The environment-reference syntaxes the classifier recognizes. A "%" next to a letter is NOT one (it needs the closing "%"). */
const GENUINE_ENV_REF = /\$env:[A-Za-z_]\w*|\$\{[A-Za-z_]\w*\}|\$[A-Za-z_]\w*|%[A-Za-z_]\w*%/;

function pathOk(t, { colons = false } = {}) {
  if (!t || t.startsWith('-')) return false;
  const x = String(t).replace(/\\/g, '/');
  if (x.startsWith('/') || x.startsWith('~') || /^[A-Za-z]:/.test(x) || x.split('/').includes('..') || isSecretPath(x)) return false;
  if (/:/.test(x) && !(colons && /::/.test(x))) return false;
  return /^[\w@.\-/*?[\]{}+~]+(::[\w[\].-]+)*$/.test(x);
}

/** Flag families that write or install: a flag outside a tool's table that looks like one is `mutating`, anything else `unclear-command`. */
const WRITES = /fix|write|update|snapshot|output|out-|outdir|outfile|cache|coverage|cov-|report|install|init|createstub|incremental|buildinfo|trace|regen|noqa|auto|junit|html|xml|log-file|logfile|tee|watch|apply|in-place|format(?!ter)/i;

const spec = (s) => Object.fromEntries(s.split(/\s+/).filter(Boolean).map((x) => { const i = x.lastIndexOf(':'); return [x.slice(0, i).toLowerCase(), x.slice(i + 1)]; }));
const GIT_FLAGS = '--stat:b --shortstat:b --numstat:b --name-only:b --name-status:b --exit-code:b --quiet:b --cached:b --staged:b --no-color:b --color:b --oneline:b -n:n --max-count:n --pretty:f --format:f --no-pager:b --short:b -s:b --porcelain:b --branch:b --ignored:b --others:b --exclude-standard:b --verify:b --abbrev-ref:b --show-toplevel:b --is-inside-work-tree:b';

const TOOLS = [
  { exe: ['eslint'], flags: spec('--quiet:b --max-warnings:n --format:w -f:w --ext:l --config:p -c:p --ignore-path:p --no-error-on-unmatched-pattern:b --report-unused-disable-directives:b --color:b --no-color:b --no-eslintrc:b --debug:b --version:b -v:b --help:b -h:b') },
  { exe: ['gofmt'], requireAny: ['-l', '-d'], mutatingIfMissing: true, flags: spec('-l:b -d:b -s:b -e:b') },
  { exe: ['tsc', 'vue-tsc'], writes: ['-b', '--build', '-w', '--watch'], require: ['--noemit'], mutatingIfMissing: true, flags: spec('--noemit:b -p:p --project:p --pretty:b --strict:b --skiplibcheck:b --nounusedlocals:b --nounusedparameters:b --noimplicitany:b --strictnullchecks:b --target:w --module:w --moduleresolution:w --lib:l --jsx:w --listfiles:b --version:b') },
  { exe: ['node'], requireAny: ['--test', '--check', '-c'], nullIfMissing: true, flags: spec('--test:b --check:b -c:b --test-concurrency:n --test-reporter:w --test-name-pattern:e --test-only:b --test-timeout:n --no-warnings:b --enable-source-maps:b') },
  { exe: ['black'], requireAny: ['--check', '--diff'], mutatingIfMissing: true, flags: spec('--check:b --diff:b --quiet:b -q:b --verbose:b -v:b --color:b --no-color:b --line-length:n -l:n --target-version:w -t:w --config:p --workers:n --skip-string-normalization:b -S:b') },
  { exe: ['isort'], requireAny: ['--check-only', '--check', '-c', '--diff'], mutatingIfMissing: true, flags: spec('--check-only:b --check:b -c:b --diff:b --profile:w --settings-path:p --settings:p -q:b --quiet:b --line-length:n -l:n --jobs:n -j:n --filter-files:b') },
  { exe: ['ruff'], sub: ['check'], flags: spec('--select:l --ignore:l --extend-select:l --extend-ignore:l --output-format:w --config:p --exit-zero:b --quiet:b -q:b --verbose:b -v:b --no-cache:b --target-version:w --line-length:n') },
  { exe: ['ruff'], sub: ['format'], requireAny: ['--check', '--diff'], mutatingIfMissing: true, flags: spec('--check:b --diff:b --config:p --line-length:n --quiet:b -q:b --no-cache:b --target-version:w') },
  { exe: ['rubocop'], writes: ['-a', '-x', '--auto-correct', '--autocorrect', '--auto-correct-all', '--autocorrect-all', '--safe-auto-correct', '--safe-autocorrect', '--auto-gen-config', '--fix-layout', '-o', '--out'], flags: spec('--format:w -f:w --only:l --except:l --parallel:b -P:b --display-cop-names:b -D:b --force-exclusion:b --fail-level:w -F:w --no-color:b --color:b --config:p -c:p --lint:b -l:b --version:b -v:b') },
  { exe: ['mypy'], flags: spec('--strict:b --ignore-missing-imports:b --python-version:w --config-file:p --show-error-codes:b --pretty:b --no-error-summary:b --follow-imports:w --exclude:l --namespace-packages:b --check-untyped-defs:b --disallow-untyped-defs:b --warn-unused-ignores:b --version:b') },
  { exe: ['pyright'], flags: spec('--outputjson:b --project:p -p:p --pythonversion:w --warnings:b --level:w --version:b') },
  { exe: ['flake8'], flags: spec('--max-line-length:n --select:l --ignore:l --extend-ignore:l --count:b --statistics:b --show-source:b --config:p --quiet:b -q:b --exclude:l --max-complexity:n --version:b') },
  { exe: ['pylint'], flags: spec('--disable:l --enable:l --rcfile:p --output-format:w --score:w --jobs:n -j:n --errors-only:b -e:b --fail-under:n --reports:w') },
  { exe: ['bandit'], flags: spec('--recursive:b -r:b -ll:b -l:b -q:b --quiet:b --format:w -f:w --configfile:p -c:p --severity-level:w --exit-zero:b') },
  { exe: ['pytest'], colons: true, flags: spec('-q:b -v:b -vv:b -x:b -s:b --maxfail:n -k:e -m:e --tb:w --durations:n -n:w --collect-only:b --co:b --disable-warnings:b --strict-markers:b --timeout:n -p:w -ra:b -ra:b --no-header:b -w:l --lf:b --import-mode:w --config-file:p -c:p --rootdir:p --verbose:b --quiet:b') },
  { exe: ['unittest'], flags: spec('-v:b -q:b --failfast:b -f:b --buffer:b -b:b -k:e') },
  { exe: ['jest'], flags: spec('--ci:b --runinband:b -i:b --silent:b --verbose:b --bail:b -b:b --maxworkers:w --testpathpattern:e --testnamepattern:e -t:e --passwithnotests:b --forceexit:b --detectopenhandles:b --testtimeout:n --json:b --config:p -c:p --colors:b --no-colors:b --nostacktrace:b --shard:w') },
  { exe: ['vitest'], sub: ['run'], subOptional: true, requireAny: ['sub:run', '--run'], mutatingIfMissing: false, flags: spec('--run:b --reporter:w --silent:b --bail:n --passwithnotests:b --config:p -c:p --root:p -r:p --dir:p --testtimeout:n -t:e --no-color:b --pool:w --shard:w --changed:b') },
  { exe: ['mocha'], writes: ['--reporter-option', '--reporter-options', '-O', '--watch', '-w'], flags: spec('--reporter:w -r:p --timeout:n -t:n --bail:b -b:b --recursive:b --exit:b --require:p --spec:p --grep:e -g:e --fgrep:e -f:e --parallel:b -p:b --jobs:n -j:n --forbid-only:b --check-leaks:b --config:p --file:p --extension:l') },
  { exe: ['ava'], flags: spec('--verbose:b -v:b --tap:b -t:b --fail-fast:b --serial:b -s:b --timeout:w --concurrency:n -c:n --match:e -m:e') },
  { exe: ['prettier'], requireAny: ['--check', '-c', '--list-different', '-l'], mutatingIfMissing: true, flags: spec('--check:b -c:b --list-different:b -l:b --config:p --ignore-path:p --no-color:b --log-level:w --no-error-on-unmatched-pattern:b') },
  { exe: ['stylelint'], flags: spec('--config:p --formatter:w -f:w --quiet:b -q:b --max-warnings:n --allow-empty-input:b') },
  { exe: ['oxlint'], flags: spec('-d:w -w:w -a:w --format:w -f:w --quiet:b') },
  { exe: ['biome'], sub: ['check', 'lint', 'ci'], flags: spec('--max-diagnostics:w --colors:w --config-path:p --diagnostic-level:w --error-on-warnings:b --verbose:b') },
  { exe: ['markdownlint', 'markdownlint-cli2'], flags: spec('--config:p -c:p --ignore:p -i:p --dot:b -d:b --json:b -j:b') },
  { exe: ['shellcheck'], flags: spec('-e:l --exclude:l -s:w --shell:w -s:w -x:b --external-sources:b -f:w --format:w') },
  { exe: ['hadolint'], flags: spec('--config:p -c:p --ignore:l --format:w -f:w --failure-threshold:w -t:w') },
  { exe: ['yamllint'], flags: spec('-c:p -f:w -s:b --strict:b') },
  { exe: ['golangci-lint'], sub: ['run'], flags: spec('--timeout:w --config:p -c:p --out-format:w --enable:l -e:l --disable:l -d:l --new-from-rev:w --issues-exit-code:n -v:b --verbose:b') },
  { exe: ['deno'], sub: ['test'], flags: spec('--filter:e --fail-fast:b --quiet:b -q:b --no-check:b --parallel:b') },
  { exe: ['deno'], sub: ['lint'], flags: spec('--rules-tags:l --rules-include:l --rules-exclude:l --json:b --compact:b --quiet:b -q:b') },
  { exe: ['deno'], sub: ['check'], flags: spec('--quiet:b -q:b --all:b') },
  { exe: ['bun'], sub: ['test'], flags: spec('--timeout:n --bail:b --rerun-each:n --only:b -t:e --test-name-pattern:e') },
  { exe: ['svelte-check'], flags: spec('--threshold:w --output:w --tsconfig:p --workspace:p --fail-on-warnings:b') },
  { exe: ['git'], sub: ['status', 'diff', 'log', 'show', 'ls-files', 'rev-parse', 'rev-list', 'describe', 'blame', 'shortlog', 'grep', 'cat-file', 'ls-tree', 'check-ignore', 'diff-tree'], revs: true, flags: spec(GIT_FLAGS) },
];

/**
 * The verdict for a command whose tool and form are in the table: { safe: true }, or { safe: false, reason }. null when the tool
 * is not in the table (the caller decides: an interpreter running a project script, or an unknown command).
 */
function verifiedForm(seg) {
  const tokens = (seg.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((raw) => ({ text: raw.replace(/^["']|["']$/g, ''), quoted: /^["']/.test(raw) }));
  if (!tokens.length) return null;
  let exe = tokens[0].text.replace(/\\/g, '/').split('/').pop().toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
  let rest = tokens.slice(1);
  if (/^(python3?|py)$/.test(exe) && rest[0]?.text === '-m' && rest[1]) {
    exe = rest[1].text.toLowerCase();
    rest = rest.slice(2);
  }
  const sub = rest[0]?.text.toLowerCase();
  const entry = TOOLS.find((t) => t.exe.includes(exe) && (!t.sub || (t.subOptional ? true : t.sub.includes(sub))));
  if (!entry) return null;
  const seen = new Set();
  if (entry.sub && entry.sub.includes(sub)) {
    seen.add(`sub:${sub}`);
    rest = rest.slice(1);
  }
  let onlyPositional = false;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (!onlyPositional && t.text === '--') {
      onlyPositional = true;
      continue;
    }
    if (GENUINE_ENV_REF.test(t.text)) continue; // a real environment reference ($NAME, ${NAME}, $env:NAME, %NAME%): classified (A2, never lowerable) by its own rule; any other token is validated
    if (!onlyPositional && !t.quoted && t.text.startsWith('-') && t.text.length > 1) {
      const eq = t.text.indexOf('=');
      const name = (eq < 0 ? t.text : t.text.slice(0, eq)).toLowerCase();
      if (entry.writes?.includes(name)) return { safe: false, reason: 'mutating' };
      if (entry.revs && /^-\d{1,4}$/.test(name)) continue; // git log -1
      const kind = entry.flags[name];
      if (!kind) return { safe: false, reason: WRITES.test(name) ? 'mutating' : 'unclear-command' };
      if (kind === 'b') {
        const v = eq < 0 ? undefined : t.text.slice(eq + 1);
        if (v !== undefined && !/^(true|false)$/i.test(v)) return { safe: false, reason: 'unclear-command' };
      } else {
        const value = eq < 0 ? rest[++i]?.text : t.text.slice(eq + 1);
        if (!KINDS[kind](value)) return { safe: false, reason: 'unclear-command' };
      }
      seen.add(name);
      continue;
    }
    if (!pathOk(t.text, { colons: !!entry.colons || !!entry.revs })) return { safe: false, reason: 'unclear-command' };
  }
  const need = entry.requireAny ?? entry.require;
  if (need && !(entry.require ? need.every((r) => seen.has(r)) : need.some((r) => seen.has(r)))) {
    if (entry.nullIfMissing) return null;
    return { safe: false, reason: entry.mutatingIfMissing === false ? 'unclear-command' : 'mutating' };
  }
  return { safe: true };
}

/** Build tools write their output (a build directory): never A1, whatever their flags. */
const BUILD_TOOLS = /^(vite|next|nuxt|astro|parcel)\s+build\b|^(webpack|rollup|esbuild|tsup)(\s|$)|^ng\s+build\b|^nx\s+build\b/;

function segments(text) {
  return String(text)
    .split(/&&|\|\||;|\n|\|(?!\|)|&(?!&)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The only environment assignments that may precede a command in an A1 form: variables whose value cannot change which code is
 * loaded, which executable is found, how libraries are linked, which plugins or modules are used, or how the shell behaves; each with
 * a plain value. NODE_ENV only selects among configurations the project itself declares. Everything else (NODE_OPTIONS, NODE_PATH, PATH,
 * LD_*, PYTHON*, GIT_*, npm_config_*, ...) is not listed on purpose: an assignment outside this list is A2 \`env-assignment\`, never lowerable.
 */
const INERT_ASSIGNMENTS = Object.freeze({
  NODE_ENV: /^(development|production|test)$/,
  CI: /^(true|false|1|0)$/,
  FORCE_COLOR: /^(0|1|2|3|true|false)$/,
  NO_COLOR: /^1$/,
  TZ: /^[A-Za-z0-9_/+-]{1,40}$/,
  LANG: /^[A-Za-z0-9_.@-]{1,30}$/,
  LC_ALL: /^[A-Za-z0-9_.@-]{1,30}$/,
});

/**
 * Peel what comes before the command: assignments, \`env\` and \`cross-env\`, and wrappers that only forward. Returns the command, and
 * whether an assignment (or an \`env\` option, or a malformed assignment) that is not on the inert list was seen.
 */
function peel(segment) {
  let s = segment.trim();
  let unsafe = false;
  for (let guard = 0; guard < 12; guard++) {
    const wrapper = s.match(/^(cross-env(?:-shell)?|env)\s+/i);
    if (wrapper) {
      s = s.slice(wrapper[0].length);
      if (/^-/.test(s)) unsafe = true; // env -i, env -S, ...: not inert
      continue;
    }
    const forward = s.match(/^(time|nice|nohup|command|builtin|exec|setsid|ionice|call|stdbuf|timeout)\s+(-\S+\s+|\d+[smhd]?\s+)*/i);
    if (forward) {
      s = s.slice(forward[0].length);
      continue;
    }
    const m = s.match(/^([^\s=]*)=("[^"]*"|'[^']*'|\S*)\s*/);
    if (!m) break;
    const value = m[2].replace(/^["']|["']$/g, '');
    const rule = INERT_ASSIGNMENTS[m[1]];
    if (!rule || !rule.test(value)) {
      // a value that is itself an environment reference is classified by that rule; anything else is not inert
      if (!/[$%]/.test(value) || !/^[A-Za-z_]\w*$/.test(m[1])) unsafe = true;
    }
    s = s.slice(m[0].length);
  }
  return { rest: s.trim(), unsafe };
}

/** Nested scripts a package script runs through its package manager (`npm run x`, `yarn x`, `pnpm x`). */
function nestedScript(segment, scripts) {
  const m = segment.match(/^(npm|pnpm|yarn|bun)\s+(run(?:-script)?\s+)?([\w:.\-]+)(\s|$)/);
  if (!m) return null;
  const name = m[3];
  // `npm <word>` is an npm command unless it is one of the four lifecycle shorthands; the others accept any script name.
  if (m[1] === 'npm' && !m[2] && !['test', 'start', 'stop', 'restart'].includes(name)) return null;
  if (m[1] === 'bun' && !m[2] && ['test', 'x', 'pm', 'create', 'init', 'upgrade'].includes(name)) return null; // bun's own commands, not scripts
  if (['test', 'start', 'stop', 'restart'].includes(name) || scripts?.[name] !== undefined) return name;
  return null;
}

const SHELL_WRAPPER = /^(sh|bash|zsh|dash|ksh|fish|cmd|powershell|pwsh)(\s|$)/;
const PAYLOAD = /(?:^|\s)(?:-[a-z]*c|\/[ck]|-command)\s+(.+)$/i;
const SECRET_NAME = /(key|token|secret|passw|credential|private|auth)/i;
/** `$VAR`, `${VAR}`, `%VAR%`, `$env:VAR`: a value from the environment is about to enter the command. */
const ENV_REF = /\$env:([A-Za-z_][A-Za-z0-9_]*)|\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?|%([A-Za-z_][A-Za-z0-9_]*)%/g;

/**
 * Classify one piece of command text (a package script body, or a joined argv).
 * @param {string} text
 * @param {{scripts?: object, depth?: number}} ctx  the package scripts, to follow `npm run x` into x (bounded to 3 levels)
 * @returns {{level: 'A1'|'A2'|'A3', reasons: string[]}}
 */
export function classifyText(text, ctx = {}) {
  const depth = ctx.depth ?? 0;
  const reasons = new Set();
  let level = 'A1';
  const add = (lv, why) => {
    level = worse(level, lv);
    reasons.add(why);
  };
  const body = String(text ?? '').trim().replace(/\d?>&\d/g, '');
  if (!body) return { level: 'A2', reasons: ['unclear-command'] };
  if (/\$\(|`|<\(/.test(body)) add('A2', 'shell-construct');
  if (/(^|\s)(--watch|--watchAll|--serve|--dev|--interactive)(\s|=|$)/.test(body)) add('A2', 'long-running'); // does not end by itself
  if (/(^|[^>])>{1,2}(?!&)|(^|\s)\d?>/.test(body.replace(/2>&1/g, '').replace(/>\s*\/dev\/null|>\s*nul\b/gi, ''))) add('A2', 'mutating');
  for (const raw of segments(body)) {
    // The environment: a secret-named variable reaching a command exposes it (A3); any other expansion is not readable from the text (A2).
    for (const m of raw.matchAll(ENV_REF)) {
      const name = m[1] ?? m[2] ?? m[3];
      if (SECRET_NAME.test(name)) add('A3', 'secrets');
      else add('A2', 'env-expansion');
    }
    const peeled = peel(raw);
    if (peeled.unsafe) add('A2', 'env-assignment');
    const seg = peeled.rest;
    if (!seg) continue;
    const lower = seg.toLowerCase().replace(/^\.?[\\/]?(node_modules[\\/]\.bin[\\/])/, '').replace(/\.(cmd|exe|bat|ps1)\b/g, '');
    // A shell given a string (sh -c "..."): the string is a command line like any other and is classified as one; the wrapper itself
    // is a shell construct, which no opt-in can lower. An encoded payload cannot be read at all.
    if (SHELL_WRAPPER.test(lower) || /^(eval|source)\s/.test(lower)) {
      const m = seg.match(PAYLOAD);
      if (/^(eval|source)\s/.test(lower)) add('A2', 'shell-construct');
      if (/(^|\s)-(e|enc|encodedcommand)(\s|$)/i.test(seg)) {
        add('A2', 'shell-construct');
        add('A2', 'unclear-command');
      } else if (m) {
        add('A2', 'shell-construct'); // a shell given a string: never lowerable
        if (depth >= 3) add('A2', 'unclear-command');
        else {
          const inner = classifyText(m[1].trim().replace(/\\(["'])/g, '$1').replace(/^["']|["']$/g, ''), { scripts: ctx.scripts, depth: depth + 1 });
          for (const r of inner.reasons) add(inner.level, r);
        }
      } else add('A2', 'project-script');
      continue;
    }
    let matched = false;
    for (const [why, re] of A3_RULES) if (re.test(lower)) {
      add('A3', why);
      matched = true;
    }
    if (matched) continue;
    for (const [why, re] of A2_RULES) if (re.test(lower)) {
      if (why === 'network-possible' && /--offline|--frozen|--locked(\s|$)/.test(lower) && /^(cargo|go|mvn|gradle|dotnet)\b/.test(lower)) {
        add('A2', 'mutating'); // no network needed, but it writes its build directory
        matched = true;
        continue;
      }
      add('A2', why);
      matched = true;
    }
    const nested = nestedScript(lower, ctx.scripts);
    if (nested !== null) {
      if (depth >= 3) add('A2', 'unclear-command');
      else if (ctx.scripts?.[nested] === undefined) add('A2', 'unclear-command');
      else {
        const inner = classifyText(ctx.scripts[nested], { scripts: ctx.scripts, depth: depth + 1 });
        for (const r of inner.reasons) add(inner.level, r);
        for (const hook of [`pre${nested}`, `post${nested}`]) if (ctx.scripts[hook] !== undefined) {
          const h = classifyText(ctx.scripts[hook], { scripts: ctx.scripts, depth: depth + 1 });
          for (const r of h.reasons) add(h.level, r);
        }
      }
      continue;
    }
    if (matched) continue;
    if (LONG_RUNNING.test(lower)) {
      add('A2', 'long-running');
      continue;
    }
    if (BUILD_TOOLS.test(lower)) {
      add('A2', 'mutating');
      continue;
    }
    // Only a form that is proven read-only is A1; a tool in the table used in any other form is A2, with the reason.
    const verdict = verifiedForm(seg);
    if (verdict) {
      if (!verdict.safe) add('A2', verdict.reason);
      continue;
    }
    // A project script run by an interpreter: its body is not read here, so it is never "a check we can read".
    if (/^(node|deno|bun|python3?|py|ruby|php|perl|bash|sh)\b/.test(lower)) {
      if (/\s(-e|--eval|-p|--print|-c)(\s|=|$)/.test(lower)) add('A2', 'unclear-command');
      else add('A2', 'project-script');
      continue;
    }
    add('A2', 'unclear-command');
  }
  return { level, reasons: [...reasons].sort() };
}

/** Classify an argument vector the runner is about to execute: the executable and its arguments, with no shell involved. */
export function classifyArgv(argv, ctx = {}) {
  if (!Array.isArray(argv) || !argv.length || argv.some((a) => typeof a !== 'string' || a.includes('\0'))) return { level: 'A3', reasons: ['unclear-command'] };
  const exe = argv[0].replace(/\\/g, '/').split('/').pop().replace(/\.(exe|cmd|bat|ps1)$/i, '');
  return classifyText([exe, ...argv.slice(1)].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' '), ctx);
}

/** Combine classifications: the most restrictive level, the union of reasons. */
export function combineClassification(...parts) {
  let level = 'A1';
  const reasons = new Set();
  for (const p of parts) {
    if (!p) continue;
    level = worse(level, p.level);
    for (const r of p.reasons) reasons.add(r);
  }
  return { level, reasons: [...reasons].sort() };
}

const KNOWN_TOOLS = new Set(['eslint', 'tsc', 'vue-tsc', 'prettier', 'jest', 'vitest', 'mocha', 'ava', 'tap', 'pytest', 'ruff', 'black', 'isort', 'mypy', 'pyright', 'flake8', 'pylint', 'bandit', 'stylelint', 'biome', 'oxlint', 'playwright', 'cypress', 'node', 'python', 'python3', 'npm', 'pnpm', 'yarn', 'bun', 'deno', 'npx', 'cargo', 'go', 'mvn', 'gradle', 'dotnet', 'make', 'vite', 'next', 'webpack', 'rollup', 'esbuild', 'nx', 'turbo', 'ng', 'svelte-check', 'git', 'docker', 'c8', 'nyc', 'rubocop', 'shellcheck', 'markdownlint', 'cross-env', 'sh', 'bash', 'cmd', 'powershell', 'pwsh']);
const SUBCOMMANDS = new Set(['run', 'run-script', 'test', 'tests', 'lint', 'check', 'build', 'format', 'fmt', 'vet', 'verify', 'typecheck', 'type-check', 'ci', 'start', 'dev', 'serve', 'watch', 'install', 'add', 'exec', 'dlx', 'x', 'publish', 'deploy', 'audit', 'status', 'diff', 'log', 'show', 'push', 'pull', 'commit', 'init', 'create', 'up', 'down', 'help', 'version']);
const SAFE_DIRS = new Set(['src', 'lib', 'test', 'tests', 'app', 'apps', 'packages', 'scripts', 'tools', 'docs', 'dist', 'build', 'spec', 'specs', 'e2e', 'bin', 'cmd', 'pkg', 'internal', 'public', 'source', 'sources', 'components', 'pages', 'server', 'client']);

/** A token that is plainly a project path or glob: a separator or an extension, no user-info, no scheme, nothing opaque. */
function pathLike(t) {
  if (t === '.' || t === '..') return true;
  if (t.length > 60 || /[:]/.test(t) || (/@/.test(t) && !/^@[\w.-]+\//.test(t)) || /[A-Za-z0-9+_=-]{24,}/.test(t.replace(/[\\/.]/g, ' '))) return false;
  if (!/^[A-Za-z0-9_@.\-[\]{}*?\\/]+$/.test(t)) return false;
  return /[\\/]/.test(t) || /\.[A-Za-z0-9]{1,6}$/.test(t);
}

/**
 * A bounded description of a script for people (proposals, plan output): never the script, and never a positional value. Shown:
 * the executable of each command, option names (and their value only when it is a number or a boolean), plain project paths and
 * globs, a few well-known tool and subcommand words, variable names (never values), and the operators between commands. Everything
 * else (every other positional word, URL, assignment value, user:password pair, token) is replaced, so that a credential is not
 * shown even when nothing about it looks secret.
 */
export function summarizeScript(body, { max = 160 } = {}) {
  const spaced = String(body ?? '').replace(/\s*(&&|\|\||;|\|)\s*/g, ' $1 ');
  const tokens = spaced.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const out = [];
  let startOfCommand = true;
  let prev = '';
  for (const raw of tokens) {
    if (/^(&&|\|\||;|\|)$/.test(raw)) {
      out.push(raw);
      startOfCommand = true;
      prev = '';
      continue;
    }
    const quoted = /^["']/.test(raw);
    const t = raw.replace(/^["']|["']$/g, '');
    let shown;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) && !t.startsWith('-')) shown = t.slice(0, t.indexOf('=')) + '=[redacted]'; // an assignment: never the value
    else if (/^(\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|%[A-Za-z_][A-Za-z0-9_]*%)$/.test(t)) shown = t; // a variable name, never its value
    else if (/^-{1,2}[A-Za-z][A-Za-z0-9-]*(=.*)?$/.test(t) && !quoted) {
      const eq = t.indexOf('=');
      shown = eq < 0 ? t : /^(\d{1,6}|true|false)$/.test(t.slice(eq + 1)) ? t : t.slice(0, eq) + '=[redacted]';
    } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) shown = '[url]';
    else if (/^(>>?|2>&1|<)$/.test(t)) shown = t;
    else if (/^(run|run-script)$/.test(prev) && /^[A-Za-z0-9:_-]{1,40}$/.test(t)) shown = t; // a script name
    else if (/:/.test(t) && !/^[A-Za-z]:[\\/]/.test(t)) shown = '[redacted]'; // user:password, host:port:secret, ...
    else if (startOfCommand && /^[A-Za-z][\w.-]{0,30}$/.test(t)) shown = t; // the executable
    else if (pathLike(t) || /^\d{1,6}$/.test(t) || KNOWN_TOOLS.has(t) || SUBCOMMANDS.has(t) || SAFE_DIRS.has(t) || (/^(run|run-script)$/.test(prev) && /^[A-Za-z0-9:_-]{1,40}$/.test(t))) shown = t;
    else shown = '[arg]';
    out.push(shown);
    startOfCommand = false;
    prev = t;
  }
  let s = out.join(' ').trim();
  if (s.length > max) s = s.slice(0, max - 1) + '…';
  return s;
}
