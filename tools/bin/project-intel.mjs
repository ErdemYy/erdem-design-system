#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { TOOL } from '../lib/constants.mjs';
import { ConfigError, loadConfig } from '../lib/config.mjs';
import { buildProjectGraph, runGraph, runImpact, runIndex, runStatus } from '../lib/pipeline.mjs';
import { createGraphQuery } from '../analyze/query.mjs';
import { classifyPath, compileCategoryRules } from '../lib/classify.mjs';
import { autoRefresh, declaredProfile } from '../automation/refresh.mjs';
import { EVIDENCE, INTELLIGENCE_STATES, RoutingInputError, artifactTrust, intelligenceFromStatus, routeContext } from '../automation/context-router.mjs';
import { analyzeChangeImpact } from '../automation/change-impact.mjs';
import { cleanPath, isSecretPath } from '../automation/path-safety.mjs';
import { discoverCommands } from '../automation/validation-discovery.mjs';
import { planValidation } from '../automation/validation-plan.mjs';
import { applyValidationToTaskState, runValidationPlan } from '../automation/validation-runner.mjs';
import { decideValidationStateAndHandoff, parseLastValidation, validationRecord } from '../automation/validation-state.mjs';
import { A2_REASONS } from '../automation/validation-classify.mjs';
import crypto from 'node:crypto';
import { SIGNALS } from '../automation/context-sources.mjs';
import { CLASSES, EVENTS, PROPOSAL_REASONS, RELIANCE, RISKS } from '../automation/refresh-decision.mjs';
import { listAdapters } from '../lib/languages/registry.mjs';
import { createHandoff, resumeHandoff } from '../automation/continuity-io.mjs';
import { HANDOFF_REASONS } from '../automation/continuity-handoff.mjs';

const HELP = `${TOOL.name} ${TOOL.version}

Usage: project-intel <command> [options]

Commands
  index [root]            refresh the index, summaries and graph (writes only inside the output directory)
  graph [root]            write graph.json, graph.mmd, graph.dot (or one filtered view)
  status [root]           report which derived artifacts are CURRENT, STALE or UNVERIFIABLE (read-only)
  impact <file> [root]    show what depends on a file, risk, public surface and affected tests (read-only)
  refresh [root]          decide whether an automatic incremental refresh is allowed and, if it is, run it
  change-impact [root]    what a change affects: dependents, tests, public surface, risk, validation depth, stale intelligence (read-only)
  validate [root]         plan the validation a change needs (depth, checks, levels A1/A2/A3); with --run, execute only the A1 part of that plan
  route [root]            plan the next context level to read for a task (read-only; returns paths and queries, never contents)
  handoff create|resume   session continuity: issue an immutable handoff for the task in TASK_STATE.md, or verify one and (with a yes) take ownership
  adapters                list language adapters
  help | version

Options
  --root <dir>            project root (default: current directory)
  --config <file>         configuration file (default: <root>/project-intel.config.json); for refresh, the file
                          the existing intelligence was produced with
  --profile <p>           index profile: auto | none | lite | standard | full
  --rehash                ignore the optional size/mtime shortcut and hash every file
  --json                  machine-readable output
  change-impact only (ai/AUTOMATION_PROTOCOL.md, Change impact; bounded, deterministic, never runs tests or refreshes):
  --modified <list> --created <list> --deleted <list> --renamed old=new,..   the explicit change set (nothing is scanned for;
                          renames are never inferred); at most 20 files are analyzed, the rest are reported for batching
  --phase <p>             planned | completed (default completed);  --class --risk --types --signals --state --artifacts --reached --loaded as for route
  --fresh-graph           use a graph built now from the current sources (the in-memory build of the impact command) instead of the artifact
                          (the artifact is used only when it is current)
  validate only (ai/AUTOMATION_PROTOCOL.md, Validation; commands come from the project's own manifests and are never invented):
  the change set and --class --risk --types --signals --state --artifacts --fresh-graph --reached --loaded --phase as for change-impact
  --run                   execute the A1 actions of the plan (default: plan only, nothing is executed); no shell, no retry
  --confirm <planId>      the user's yes for the A2 proposals of exactly that plan (V3 and V4 are one proposal); --confirm-reasons <list>
                          narrows the yes to those proposal reasons;  --declined <list> proposal reasons declined earlier (network-possible,
                          external-tool, expensive, mutating, shell-construct, inferred-from-config, unclear-command, validation-set)
  --opt-in <list>         standing opt-ins the project or user recorded, each naming ONE action exactly:
                          commandId|scriptDigest|type|reason+reason|scope (copy it from the plan's proposal: optIn); a changed script, another
                          reason set or another scope is another action; validation-set|setId|depth|risk|project authorizes ONE exact V3/V4 plan (its proposal prints it); never an A3
  --update-state          write the outcome into TASK_STATE.md (the one state record): --task-state <path> (default .ai/TASK_STATE.md),
                          --owner <name> (required: only the current owner writes), --goal <text> for a new file
  --task-status <s>       in-progress (default) | blocked | done;  --session-ending  the session cannot continue (decides the handoff)
  route only (ai/AUTOMATION_PROTOCOL.md, Context automation; the plan is for the agent to carry out):
  --class --risk          as for refresh;  --types <list> task types: ui, bugfix, feature, refactor, performance, architecture,
                          documentation, dependency, configuration, migration, test, security
  --kind <k>              design | implementation | mixed;  --platform <p> web, mobile, flutter, react-native, desktop, webgl-3d
  --concerns <list>       design concerns: principles, tokens, token-values, typography, color, spacing, layout, motion,
                          components, content, accessibility, quality, origin
  --targets <list>        project-relative files the change touches (at most 12 are planned; the rest are reported for
                          batching);  --subsystem <dir>.  Brackets and braces are literal (app/[id]/page.tsx); globs are refused
  --signals <list>        publicSurface, crossSubsystem, layerBoundary, dependencyUncertain, sharedDependency, buildOrRuntime,
                          dataLoss, securityBoundary, architectureUnresolved, maybeShared, configImpact, apiImpact, dataImpact,
                          platformImpact, designSystemImpact
  --queries <list>        graph questions the task needs (dependents, impact, shortest-path, ...)
  --between <from,to>     the two endpoints a shortest-path question needs (library-only; never guessed from --targets)
  --intent <i>            change (default) | read-only;  --event <e> SESSION_START | TASK_RECEIVED | TASK_CLASSIFIED |
                          CONTEXT_EXPANDED | INTELLIGENCE_CHECKED
  --state <s> [--artifacts k=v,..]  reuse the session state you already hold instead of running a status check
  --reached <n>           highest level already read (-1 = none);  --loaded path=unchanged|changed|unknown,...
  --answers 1=read,4=open,..  evidence for the five sufficiency questions (open, assumption, read, search, graph, instruction, test)
  --escalation-reason <r> why to go beyond the class ceiling;  --searched  a targeted search was already done
  refresh only (ai/AUTOMATION_PROTOCOL.md):
  --relies-on <list>      comma list of what the task relies on: graph, dependents, consumers, dependencies, impact,
                          risk, cycles, public-surface, index, navigation, file-index, directory-index, summary
  --scope <list>          comma list of project-relative paths the task touches (narrows per-path artifacts)
  --class <c>             TRIVIAL | SMALL | MEDIUM | LARGE | ARCHITECTURAL (recorded; never proof of reliance)
  --risk <r>              LOW | MEDIUM | HIGH | CRITICAL
  --event <e>             SESSION_START | INTELLIGENCE_CHECKED | CONTEXT_EXPANDED | IMPACT_REQUIRED | CHANGE_COMPLETED
  --search-insufficient   targeted inspection could not answer "what depends on it"
  --declined <list>       comma list of proposal reasons the user declined earlier in this session (first-index,
                          profile-unknown, profile-differs-from-config, configuration-changed, vcs-unknown,
                          derived-files-tracked): those are not proposed again, other reasons still are
  --after-failure         a refresh already failed in this session (no retry)
  --check                 decide only; never run the refresh
  (--rehash and --profile are refused here: forced rebuilds and profile changes are manual; options that do not
  apply to refresh, such as --view, --depth or --stdout, are errors)
  graph only:
  --view <mode>           full | subsystem | file | impact   (default: full)
  --target <path>         file or subsystem for the non-full views
  --depth <n>             neighborhood or impact depth
  --max-nodes <n>         diagram size limit (default from configuration)
  --include-tests         show test files in the view
  --include-external      show external packages in the view
  --stdout                print the Mermaid view instead of only writing files
  handoff only (ai/CONTINUITY.md; writes only TASK_STATE.md and HANDOFF.md; never runs, validates or refreshes anything):
  handoff create --owner <name> --reason <r>   session-ending | ownership-transfer | blocked | context-too-large | user-request; the owner issues it
                          --to <name> receiver (default any), --next-action <text> (default: first item of Remaining), --active <text> (repeatable),
                          --caveat <text> and --decision <text> (repeatable), --context-files <path[=why],..>, --indexes <paths>, --context-level <0-5>
  handoff resume          verify: handoff integrity, task identity, ownership, drift, intelligence and validation assumptions (read-only)
                          --accept --owner <name> --confirm <handoffId> [--acknowledge <driftDigest>]  take ownership (the yes names exactly that handoff)
                          both: --task-state <path> --handoff <path> --state <intelligence state>
Exit codes: 0 ok, 1 stale or missing artifacts (status), not found (impact), or a refresh decision that needs attention
(proposal, refusal, failed refresh), 2 usage or configuration error.
`;

function parseArgs(argv) {
  const flags = new Set(['--json', '--rehash', '--include-tests', '--include-external', '--stdout', '--help', '--search-insufficient', '--after-failure', '--check', '--searched', '--fresh-graph', '--run', '--update-state', '--session-ending', '--accept']);
  const valued = new Set(['--root', '--config', '--profile', '--view', '--target', '--depth', '--max-nodes', '--relies-on', '--scope', '--class', '--risk', '--event', '--declined', '--types', '--kind', '--platform', '--concerns', '--targets', '--subsystem', '--signals', '--queries', '--intent', '--state', '--artifacts', '--reached', '--answers', '--escalation-reason', '--loaded', '--between', '--created', '--modified', '--deleted', '--renamed', '--phase', '--confirm', '--confirm-reasons', '--task-state', '--owner', '--task-status', '--goal', '--opt-in', '--reason', '--to', '--next-action', '--context-files', '--indexes', '--context-level', '--handoff', '--acknowledge']);
  const repeatable = new Set(['--active', '--caveat', '--decision']);
  const args = { _: [], opts: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (flags.has(a)) args.opts[a.slice(2)] = true;
    else if (repeatable.has(a)) {
      if (i + 1 >= argv.length) throw new UsageError(`${a} needs a value`);
      (args.opts[a.slice(2)] ??= []).push(argv[++i]);
    } else if (valued.has(a)) {
      if (i + 1 >= argv.length) throw new UsageError(`${a} needs a value`);
      args.opts[a.slice(2)] = argv[++i];
    } else if (a.startsWith('--')) throw new UsageError(`unknown option ${a}`);
    else args._.push(a);
  }
  return args;
}

class UsageError extends Error {}

function int(v, name) {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`${name} must be a positive integer`);
  return n;
}

function print(obj, json, text) {
  process.stdout.write(json ? JSON.stringify(obj, null, 2) + '\n' : text);
}

/** The Phase 5D impact report for the options of a command (shared by change-impact and validate): the change set is explicit, the graph is used only when it can be trusted. */
function gatherImpact(root, opts, pos, extra = []) {
    const list = (v) => (v ? String(v).split(',').map((x) => x.trim()).filter(Boolean) : []);
    const applicable = new Set([...extra, 'json', 'config', 'root', 'created', 'modified', 'deleted', 'renamed', 'phase', 'class', 'risk', 'types', 'signals', 'state', 'artifacts', 'fresh-graph', 'reached', 'loaded', 'help']);
    const stray = Object.keys(opts).filter((k) => !applicable.has(k));
    if (stray.length) throw new UsageError(`option(s) that do not apply to change-impact: ${stray.map((k) => `--${k}`).join(', ')}`);
    if (pos.length > 2) throw new UsageError(`unexpected argument "${pos[2]}"`);
    if (opts.class !== undefined && !CLASSES.includes(opts.class)) throw new UsageError(`--class must be one of ${CLASSES.join(', ')}`);
    if (opts.risk !== undefined && !RISKS.includes(opts.risk)) throw new UsageError(`--risk must be one of ${RISKS.join(', ')}`);
    if (opts.state !== undefined && !INTELLIGENCE_STATES.includes(opts.state)) throw new UsageError(`--state must be one of ${INTELLIGENCE_STATES.join(', ')}`);
    if (opts.phase !== undefined && !['planned', 'completed'].includes(opts.phase)) throw new UsageError('--phase must be planned or completed');
    if (opts.config !== undefined && !fs.existsSync(path.resolve(opts.config))) throw new UsageError(`--config file not found: ${opts.config}`);
    const reached = opts.reached === undefined ? 3 : Number(opts.reached);
    if (!Number.isInteger(reached) || reached < -1 || reached > 5) throw new UsageError('--reached is -1 (nothing read yet) to 5');
    const signals = {};
    for (const x of list(opts.signals)) {
      if (!SIGNALS.includes(x)) throw new UsageError(`unknown --signals value "${x}" (known: ${SIGNALS.join(', ')})`);
      signals[x] = true;
    }
    // The change set is explicit. Nothing is discovered by scanning, and renames are never inferred.
    const files = [
      ...list(opts.modified).map((p) => ({ path: p, status: 'modified' })),
      ...list(opts.created).map((p) => ({ path: p, status: 'created' })),
      ...list(opts.deleted).map((p) => ({ path: p, status: 'deleted' })),
      ...list(opts.renamed).map((p) => {
        const i = p.indexOf('=');
        if (i < 1 || i === p.length - 1) throw new UsageError('--renamed entries look like old=new');
        return { from: p.slice(0, i), path: p.slice(i + 1), status: 'renamed' };
      }),
    ];
    if (!files.length) throw new UsageError('change-impact needs the changed files: --modified, --created, --deleted or --renamed old=new');
    const loaded = list(opts.loaded).map((p) => ({ path: p, unchanged: true }));
    let cfg = null;
    let status = null;
    let intelligence = { state: opts.state, artifacts: {} };
    for (const e of list(opts.artifacts)) {
      const i = e.lastIndexOf('=');
      if (i < 1) throw new UsageError('--artifacts entries look like key=value');
      intelligence.artifacts[e.slice(0, i)] = e.slice(i + 1);
    }
    try {
      cfg = loadConfig(root, { configPath: opts.config });
      if (!opts.state) {
        status = runStatus(root, { configPath: opts.config }).status;
        intelligence = intelligenceFromStatus(status, declaredProfile(root, cfg.outputDir));
      }
    } catch {
      if (!opts.state) intelligence = { state: 'unavailable' };
    }
    const outputDir = cfg?.outputDir ?? '.ai';
    // The graph: a freshly built one only when asked for (the same in-memory build `impact` does); otherwise the artifact, and only when current.
    let query = null;
    let graphSource = null;
    try {
      if (opts['fresh-graph']) {
        query = buildProjectGraph(root, { configPath: opts.config }).query;
        graphSource = 'fresh-build';
      } else if (artifactTrust(intelligence).trust.graph === 'trusted') {
        const g = JSON.parse(fs.readFileSync(path.join(root, outputDir, 'graph', 'graph.json'), 'utf8'));
        if (g?.schema === 'erdem.graph' && Array.isArray(g.nodes)) {
          query = createGraphQuery(g);
          graphSource = 'artifact';
        }
      }
    } catch {
      query = null;
    }
    // Categories for files the graph cannot know (created or renamed), from the engine's own classifier.
    const categories = {};
    if (cfg) {
      const rules = compileCategoryRules(cfg);
      for (const f of files) if (f.status === 'created' || f.status === 'renamed') {
        try {
          categories[cleanPath(f.path)] = classifyPath(cleanPath(f.path), path.posix.extname(cleanPath(f.path)), cfg, rules).category;
        } catch {
          // an invalid path is reported by the analysis below
        }
      }
    }
    let report;
    try {
      report = analyzeChangeImpact(
        { phase: opts.phase, files, taskClass: opts.class, risk: opts.risk, taskTypes: list(opts.types), signals },
        intelligence,
        { query, graphSource, categories, loaded, reached, subsystemRoots: cfg?.subsystemRoots, artifacts: (status?.artifacts ?? []).map((a) => ({ ...a, outputDir })) },
      );
    } catch (e) {
      if (e instanceof RoutingInputError) throw new UsageError(e.message);
      throw e;
    }
    // When the graph could not be used, ask the existing refresh decision what is allowed (decide only: nothing is refreshed here).
    if (!report.graph.used && report.phase === 'completed') {
      const d = autoRefresh(root, { event: 'CHANGE_COMPLETED', reliesOn: ['impact', 'dependents'], taskClass: opts.class, risk: opts.risk, configPath: opts.config }, { execute: false }).decision;
      report.intelligenceImpact.refreshDecision = { decision: d.decision, reason: d.reason, level: d.level };
    }
  return { report, files, cfg, status, outputDir, list };
}

async function main() {
  const { _: pos, opts } = parseArgs(process.argv.slice(2));
  const command = pos[0] ?? 'help';
  if (command === 'help' || opts.help) return process.stdout.write(HELP);
  if (command === 'version') return process.stdout.write(`${TOOL.name} ${TOOL.version}\n`);
  if (command === 'adapters') {
    return print(listAdapters(), opts.json, listAdapters().map((a) => `${a.id} v${a.version}: ${a.languages.join(', ')}${a.supportsDependencies ? '' : ' (metadata only)'}`).join('\n') + '\n');
  }

  const common = { configPath: opts.config, rehash: !!opts.rehash };
  const rootArg = (command === 'impact' || command === 'handoff' ? pos[2] : pos[1]) ?? opts.root ?? '.';
  const root = path.resolve(rootArg);

  if (command === 'index') {
    const { report, graph } = runIndex(root, { ...common, profile: opts.profile });
    const text =
      `index ${report.profile}: ${graph.stats.files} files, ${graph.stats.edges} edges, ${graph.stats.cycles} cycles\n` +
      `artifacts: ${report.counts.created} created, ${report.counts.updated} updated, ${report.counts.unchanged} unchanged` +
      `${report.removed.length ? `, ${report.removed.length} removed` : ''} (in ${report.outputDir}/)\n` +
      `diagnostics: ${report.diagnostics.filter((d) => d.severity === 'error').length} errors, ${report.diagnostics.filter((d) => d.severity === 'warning').length} warnings (see ${report.outputDir}/state/report.json)\n`;
    return print({ profile: report.profile, counts: report.counts, removed: report.removed, stats: graph.stats }, opts.json, text);
  }

  if (command === 'graph') {
    const result = runGraph(root, {
      ...common,
      view: opts.view,
      target: opts.target ?? (opts.view && opts.view !== 'full' ? pos[1] : undefined),
      depth: int(opts.depth, '--depth'),
      maxNodes: int(opts['max-nodes'], '--max-nodes'),
      includeTests: opts['include-tests'] ? true : undefined,
      includeExternal: opts['include-external'] ? true : undefined,
    });
    if (opts.stdout) return process.stdout.write(result.rendered.mmd);
    const written = Object.entries(result.writes).map(([p, s]) => `${s.padEnd(9)} ${p}`).join('\n');
    return print({ view: result.view.title, nodes: result.view.nodes.length, edges: result.view.edges.length, truncated: result.view.truncated, writes: result.writes }, opts.json, `${result.view.title}: ${result.view.nodes.length} nodes, ${result.view.edges.length} edges${result.view.truncated ? ` (+${result.view.truncated.omitted} ${result.view.truncated.unit} omitted)` : ''}\n${written}\n`);
  }

  if (command === 'refresh') {
    const list = (v) => (v ? String(v).split(',').map((x) => x.trim()).filter(Boolean) : []);
    const reliesOn = list(opts['relies-on']).map((x) => x.toLowerCase());
    const unknown = reliesOn.filter((x) => !RELIANCE[x]);
    if (unknown.length) throw new UsageError(`unknown --relies-on value(s): ${unknown.join(', ')}`);
    // Nothing that changes meaning is silently ignored: options that do not apply, unknown values and bad paths are errors.
    const applicable = new Set(['json', 'config', 'root', 'relies-on', 'scope', 'class', 'risk', 'event', 'search-insufficient', 'declined', 'after-failure', 'check', 'help', 'rehash', 'profile']);
    const stray = Object.keys(opts).filter((k) => !applicable.has(k));
    if (stray.length) throw new UsageError(`option(s) that do not apply to refresh: ${stray.map((k) => `--${k}`).join(', ')}`);
    if (pos.length > 2) throw new UsageError(`unexpected argument "${pos[2]}"`);
    if (opts.event !== undefined && !EVENTS.includes(opts.event)) throw new UsageError(`--event must be one of ${EVENTS.join(', ')}`);
    if (opts.class !== undefined && !CLASSES.includes(opts.class)) throw new UsageError(`--class must be one of ${CLASSES.join(', ')}`);
    if (opts.risk !== undefined && !RISKS.includes(opts.risk)) throw new UsageError(`--risk must be one of ${RISKS.join(', ')}`);
    if (opts.config !== undefined && !fs.existsSync(path.resolve(opts.config))) throw new UsageError(`--config file not found: ${opts.config}`);
    const declinedReasons = list(opts.declined);
    const badDeclined = declinedReasons.filter((x) => !PROPOSAL_REASONS.includes(x));
    if (badDeclined.length) throw new UsageError(`unknown --declined reason(s): ${badDeclined.join(', ')} (known: ${PROPOSAL_REASONS.join(', ')})`);
    const scope = list(opts.scope);
    const badScope = scope.filter((p) => path.isAbsolute(p) || /^[A-Za-z]:/.test(p) || p.split(/[\\/]/).includes('..'));
    if (badScope.length) throw new UsageError('--scope paths must be project-relative and stay inside the project');
    const r = autoRefresh(root, {
      configPath: opts.config,
      event: opts.event, reliesOn, scope, taskClass: opts.class, risk: opts.risk,
      searchInsufficient: !!opts['search-insufficient'], declinedReasons, priorFailure: !!opts['after-failure'],
      requested: { rehash: !!opts.rehash, profileChange: opts.profile !== undefined },
    }, { execute: !opts.check });
    const d = r.decision;
    const text = `${d.decision} (${d.level}): ${d.reason}${d.command ? `; command: ${d.command}` : ''}
` + (d.affectedArtifacts.length ? `affected: ${d.affectedArtifacts.join(', ')}
` : '') + (r.refreshed ? `refresh: ${r.refreshed.ok ? 'ok' : 'FAILED'} (${r.refreshed.counts.created} created, ${r.refreshed.counts.updated} updated, ${r.refreshed.counts.unchanged} unchanged)
` : '');
    print({ decision: d, record: r.record, refreshed: r.refreshed }, opts.json, text);
    const attention = d.decision === 'PROPOSE_REFRESH' || d.decision === 'BLOCKED' || (r.refreshed && !r.refreshed.ok);
    if (attention) process.exitCode = 1;
    return;
  }

  if (command === 'route') {
    const list = (v) => (v ? String(v).split(',').map((x) => x.trim()).filter(Boolean) : []);
    const applicable = new Set(['json', 'config', 'root', 'class', 'risk', 'types', 'kind', 'platform', 'concerns', 'targets', 'subsystem', 'signals', 'queries', 'intent', 'event', 'state', 'artifacts', 'reached', 'answers', 'escalation-reason', 'searched', 'loaded', 'between', 'help']);
    const stray = Object.keys(opts).filter((k) => !applicable.has(k));
    if (stray.length) throw new UsageError(`option(s) that do not apply to route: ${stray.map((k) => `--${k}`).join(', ')}`);
    if (pos.length > 2) throw new UsageError(`unexpected argument "${pos[2]}"`);
    if (opts.class !== undefined && !CLASSES.includes(opts.class)) throw new UsageError(`--class must be one of ${CLASSES.join(', ')}`);
    if (opts.risk !== undefined && !RISKS.includes(opts.risk)) throw new UsageError(`--risk must be one of ${RISKS.join(', ')}`);
    if (opts.state !== undefined && !INTELLIGENCE_STATES.includes(opts.state)) throw new UsageError(`--state must be one of ${INTELLIGENCE_STATES.join(', ')}`);
    if (opts.config !== undefined && !fs.existsSync(path.resolve(opts.config))) throw new UsageError(`--config file not found: ${opts.config}`);
    const signals = {};
    for (const x of list(opts.signals)) {
      if (!SIGNALS.includes(x)) throw new UsageError(`unknown --signals value "${x}" (known: ${SIGNALS.join(', ')})`);
      signals[x] = true;
    }
    const pairs = (v, name) => list(v).map((p) => {
      const i = p.lastIndexOf('=');
      if (i < 1) throw new UsageError(`--${name} entries look like key=value`);
      return [p.slice(0, i), p.slice(i + 1)];
    });
    const answers = opts.answers === undefined ? undefined : {};
    for (const [q, v] of pairs(opts.answers, 'answers')) {
      if (!/^[1-5]$/.test(q)) throw new UsageError('--answers keys are the question numbers 1 to 5');
      if (v !== 'open' && !EVIDENCE.includes(v) && v !== 'assumption') throw new UsageError(`--answers values: open, assumption, ${EVIDENCE.join(', ')}`);
      answers[q] = v === 'open' ? { status: 'open' } : { status: 'answered', evidence: v };
    }
    const loaded = pairs(opts.loaded, 'loaded').map(([p, v]) => {
      if (!['unchanged', 'changed', 'unknown'].includes(v)) throw new UsageError('--loaded entries look like path=unchanged|changed|unknown');
      return { path: p, unchanged: v === 'unchanged' ? true : v === 'changed' ? false : 'unknown' };
    });
    const artifacts = {};
    for (const [k, v] of pairs(opts.artifacts, 'artifacts')) artifacts[k] = v;
    const reached = opts.reached === undefined ? -1 : Number(opts.reached);
    if (!Number.isInteger(reached) || reached < -1 || reached > 5) throw new UsageError('--reached is -1 (nothing read yet) to 5');
    // The session state: reuse what the caller already holds (--state), otherwise one read-only status check.
    let intelligence = { state: opts.state, artifacts };
    let outputDir = '.ai';
    if (!opts.state) {
      try {
        const cfg = loadConfig(root, { configPath: opts.config });
        outputDir = cfg.outputDir;
        intelligence = intelligenceFromStatus(runStatus(root, { configPath: opts.config }).status, declaredProfile(root, cfg.outputDir));
      } catch {
        intelligence = { state: 'unavailable' };
      }
    }
    let rootFiles = [];
    try {
      rootFiles = fs.readdirSync(root);
    } catch {
      rootFiles = [];
    }
    const has = (f) => fs.existsSync(path.join(root, outputDir, f));
    let plan;
    try {
      plan = routeContext({
        event: opts.event, taskClass: opts.class, risk: opts.risk, taskTypes: list(opts.types), kind: opts.kind, platform: opts.platform,
        concerns: list(opts.concerns), targets: list(opts.targets), subsystem: opts.subsystem, intent: opts.intent, signals, queries: list(opts.queries),
        pathBetween: opts.between === undefined ? undefined : list(opts.between),
      }, intelligence, {
        reached, answers, escalationReason: opts['escalation-reason'], searched: !!opts.searched, loaded, rootFiles,
        hasTaskState: has('TASK_STATE.md'), hasHandoff: has('HANDOFF.md'), hasDecisions: has('DECISIONS.md'),
      });
    } catch (e) {
      if (e instanceof RoutingInputError) throw new UsageError(e.message);
      throw e;
    }
    const head = plan.level === null ? (plan.stop ? 'stop: sufficient' : `none: ${plan.evaluation?.action ?? ''}`) : plan.level;
    const text = [
      `level ${head} (class ${plan.class ?? 'unclassified'}, risk ${plan.risk}, minimum ${plan.minimumLevel}, ceiling ${plan.ceiling}; intelligence ${plan.intelligence.state})`,
      ...plan.skipped.map((k) => `skipped level ${k.level}: ${k.reason}`),
      ...plan.requiredSources.map((x) => `read ${x.root === 'design-system' ? '<design-system>/' : ''}${x.path}${x.headerOnly ? ' (header only)' : ''}${x.recheck ? ' (re-check first)' : ''}  - ${x.why}`),
      ...plan.requiredQueries.map((q) => `query ${q.op}${q.target ? ` ${q.target}` : ''} via ${q.via}${q.command ? `: ${q.command.join(' ')}` : ''}`),
      ...plan.skip.map((x) => `skip ${x.path}: ${x.reason}`),
      ...plan.unresolvedRequirements.map((u) => `unresolved ${u.op}: ${u.requires} (${u.why})`),
      ...(plan.targets.truncated ? [`batching required: ${plan.targets.remainingTargets} more target(s) beyond the limit of ${plan.targets.targetLimit}`] : []),
      ...(plan.evaluation ? [`sufficiency: ${plan.evaluation.sufficient === null ? plan.evaluation.reason : plan.evaluation.sufficient ? 'sufficient' : `insufficient (${plan.evaluation.reason}; ${plan.evaluation.action})`}`] : []),
    ].join('\n') + '\n';
    print(plan, opts.json, text);
    return;
  }

  if (command === 'change-impact') {
    const { report } = gatherImpact(root, opts, pos);
    const lines = [
      `impact of ${report.changedFiles.length} changed file(s) (${report.phase}); graph: ${report.graph.used ? report.graph.basis : `not used (${report.graph.artifact})`}; ${report.completeness}, confidence ${report.confidence}`,
      `class ${report.class.value ?? 'unclassified'}, risk ${report.risk.level}, validation depth ${report.requiredValidation.depth}${report.requiredValidation.broader ? ' (broader)' : ''}`,
      ...report.changedFiles.map((c) => `  ${c.status.padEnd(8)} ${c.from ? `${c.from} -> ` : ''}${c.path}${c.known === false ? '  (not in the graph)' : ''}`),
      `direct dependents (${report.bounded.directDependents.total ?? '?'}): ${report.directImpact.dependents === null ? 'unknown (graph not used)' : report.directImpact.dependents.map((d) => d.path).join(', ') || 'none'}`,
      `transitive dependents (${report.bounded.transitive.total ?? '?'}): ${report.transitiveImpact.dependents === null ? 'unknown (graph not used)' : report.transitiveImpact.dependents.map((d) => `${d.path}:${d.distance}`).join(', ') || 'none'}`,
      report.affectedTests.direct === null ? 'tests: unknown (graph not used)' : `tests: direct ${report.affectedTests.direct.join(', ') || 'none'}; consumer ${report.requiredValidation.tests.consumer.join(', ') || (report.affectedTests.consumer.length ? `${report.affectedTests.consumer.length} (not recommended)` : 'none')}`,
      `public surface: ${report.publicSurfaceImpact.present === null ? 'unknown (graph not used)' : report.publicSurfaceImpact.present ? [...report.publicSurfaceImpact.changed.map((c) => `changed ${c.path}`), ...report.publicSurfaceImpact.affected.map((p) => `affected ${p}`)].join(', ') : 'none'}`,
      `dimensions: ${Object.entries(report.dimensions).filter(([, v]) => v.present).map(([k]) => k).join(', ') || (report.evidence.graph === 'unknown' ? 'none signalled (the rest unknown)' : 'none')}`,
      `intelligence made stale: ${Object.entries(report.intelligenceImpact).filter(([, v]) => v === 'stale').map(([k]) => k).join(', ') || 'none'}${report.intelligenceImpact.refreshDecision ? `; refresh decision: ${report.intelligenceImpact.refreshDecision.decision} (${report.intelligenceImpact.refreshDecision.reason})` : ''}`,
      ...(report.requiredContext.justified ? [`reopen context: ${report.requiredContext.reasons.join(', ')} (router level ${report.requiredContext.plan.level ?? 'evaluate'})`] : []),
      ...(report.batching.required ? [`batching required: ${report.batching.truncatedLists.join(', ')} were bounded (see bounded)`] : []),
      ...report.limitations.map((l) => `limitation: ${l}`),
    ].join('\n') + '\n';
    print(report, opts.json, lines);
    return;
  }

  if (command === 'validate') {
    const extra = ['run', 'confirm', 'confirm-reasons', 'declined', 'opt-in', 'update-state', 'task-state', 'owner', 'task-status', 'goal', 'session-ending', 'intent'];
    const list = (v) => (v ? String(v).split(',').map((x) => x.trim()).filter(Boolean) : []);
    const declined = list(opts.declined);
    const bad = declined.find((r) => !A2_REASONS.includes(r));
    if (bad) throw new UsageError(`unknown --declined reason "${bad}" (known: ${A2_REASONS.join(', ')})`);
    if (opts['task-status'] !== undefined && !['in-progress', 'blocked', 'done'].includes(opts['task-status'])) throw new UsageError('--task-status must be in-progress, blocked or done');
    if (opts['update-state'] && !opts.owner) throw new UsageError('--update-state needs --owner: only the current owner writes TASK_STATE.md');
    if (opts.confirm !== undefined && !opts.run) throw new UsageError('--confirm only applies with --run');
    for (const k of ['confirm-reasons', 'opt-in']) if (opts[k] !== undefined && !String(opts[k]).trim()) throw new UsageError(`--${k} needs a value`);
    const confirmReasons = list(opts['confirm-reasons']);
    const badReason = confirmReasons.find((r) => !A2_REASONS.includes(r));
    if (badReason) throw new UsageError(`unknown --confirm-reasons value "${badReason}" (known: ${A2_REASONS.join(', ')})`);
    const standingOptIn = list(opts['opt-in']).map((e) => {
      const parts = e.split('|');
      if (parts.length === 5 && parts[0] === 'validation-set') return { type: 'validation-set', setId: parts[1], depth: parts[2], riskCeiling: parts[3], scope: parts[4] };
      if (parts.length !== 5) throw new UsageError('--opt-in entries look like commandId|scriptDigest|type|reason+reason|scope (the plan shows each action\'s optIn), or validation-set|setId|depth|risk|project (the V3/V4 proposal prints it)');
      return { commandId: parts[0], scriptDigest: parts[1], type: parts[2], reason: parts[3].split('+'), scope: parts[4] };
    });
    const { report, files, outputDir, list: _l } = gatherImpact(root, opts, pos, extra);
    void _l;
    void files;
    const changedPaths = report.changedFiles.map((c) => c.path);
    const discovery = discoverCommands(root, { changedFiles: changedPaths });
    const taskTypes = list(opts.types);
    let plan;
    try {
      plan = planValidation({
      task: { taskClass: opts.class, risk: opts.risk, taskTypes, intent: opts.intent },
      impact: report,
      project: { commands: discovery.commands, limitations: discovery.limitations, declined, standingOptIn },
      });
    } catch (e) {
      if (e instanceof RoutingInputError) throw new UsageError(e.message);
      throw e;
    }
    // Idempotency: what the task state recorded last, and the content it was recorded for.
    const statePath = opts['task-state'] ?? `${outputDir}/TASK_STATE.md`;
    let stateText = null;
    try {
      const abs = path.resolve(root, statePath);
      if (path.relative(root, abs).startsWith('..') || path.basename(abs) !== 'TASK_STATE.md') throw new UsageError('--task-state must be a TASK_STATE.md inside the project');
      stateText = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
    } catch (e) {
      if (e instanceof UsageError) throw e;
    }
    const hash = crypto.createHash('sha256');
    for (const p of changedPaths.filter((x) => !isSecretPath(x)).sort()) {
      hash.update(p + '\0');
      try {
        const abs = path.resolve(root, p);
        if (fs.statSync(abs).size <= 1048576) hash.update(fs.readFileSync(abs));
      } catch {
        hash.update('absent');
      }
    }
    const contentKey = hash.digest('hex').slice(0, 16);
    const previous = stateText ? parseLastValidation(stateText) : null;
    let result = null;
    let state = null;
    let handoff = null;
    let decision = null;
    const planRecord = validationRecord({ phase: 'planned', plan });
    if (opts.run) {
      const confirm = opts.confirm ? { planId: opts.confirm, proposals: plan.confirmationRequired.filter((p) => !confirmReasons.length || confirmReasons.includes(p.reason)).map((p) => p.id) } : null;
      result = runValidationPlan(plan, root, { execute: true, confirm, previous, contentKey, standingOptIn });
      decision = decideValidationStateAndHandoff({ result, taskClass: plan.class, risk: plan.risk, taskStatus: opts['task-status'] ?? 'in-progress', sessionEnding: !!opts['session-ending'], readOnly: plan.intent === 'read-only', stateExists: stateText !== null });
      handoff = decision.handoff;
    }
    if (opts['update-state'] && (!decision || decision.state.write)) {
      state = applyValidationToTaskState(root, statePath, result ?? { ...plan, status: 'NOT_RUN', actions: plan.actions.map((a) => ({ id: a.id, status: 'NOT_RUN' })) }, { phase: result ? 'completed' : 'planned', owner: opts.owner, taskClass: plan.class, risk: plan.risk, contentKey, goal: opts.goal, handoffAhead: !!handoff?.required });
    } else if (opts['update-state'] && decision) {
      state = { changed: false, created: false, skipped: 'state-not-required', refused: null, path: statePath.replace(/\\/g, '/'), reason: decision.state.reason };
    }
    const out = { plan, ...(result ? { result } : {}), ...(state ? { state } : {}), ...(handoff ? { handoff } : {}), ...(decision ? { decision: { state: decision.state, order: decision.order, consistent: decision.consistent, completion: decision.completion } } : {}), records: { planned: planRecord, ...(result ? { completed: result.record } : {}) }, discovery: { sources: discovery.sources, notParsed: discovery.notParsed } };
    const act = (a) => `  ${a.level} ${a.id.padEnd(22)} ${a.command ? a.command.display : `${a.type} (${(a.files ?? []).length} file(s))`}  [${a.reasons.join(', ') || a.sourceRef}]`;
    const lines = [
      `validation ${plan.depth} for class ${plan.class ?? 'unclassified'}, risk ${plan.risk}; plan ${plan.planId}; confidence ${plan.confidence}; impact ${plan.impact.state}`,
      ...(plan.required ? [] : [`not required: ${plan.rationale[0]}`]),
      ...plan.actions.map(act),
      ...plan.unresolved.map((u) => `  unresolved ${u.type}: ${u.note}`),
      ...plan.prohibited.map((p) => `  A3 PROHIBITED ${p.id}: ${p.reasons.join(', ')} (run it manually, outside automation)`),
      ...plan.confirmationRequired.map((p) => `proposal ${p.id}${p.declined ? ' (declined)' : ''}: ${p.effect}; if no: ${p.alternative}${p.authorization ? `; to authorize exactly this plan without a prompt: --opt-in ${p.authorization.entry}` : ''}`),
      ...(plan.contextNeeds.justified ? [`context to reopen (route it): ${plan.contextNeeds.reasons.join(', ')}`] : []),
      ...(result ? [`result: ${result.status} (passed ${result.passed.length}, failed ${result.failed.length}, not run ${result.notRun.length}, declined ${result.declined.length}, blocked ${result.blocked.length}, unknown ${result.unknown.length})`, ...result.actions.map((a) => `  ${a.status.padEnd(9)} ${a.id}${a.reason ? ` (${a.reason})` : ''}`), ...result.evidence.failures.flatMap((x) => x.excerpt.map((l) => `    | ${l}`))] : []),
      ...(state ? [`task state: ${state.refused ? `refused (${state.refused})` : state.changed ? `${state.created ? 'created' : 'updated'} ${state.path}` : `skipped (${state.skipped})`}`] : []),
      ...(decision && !decision.completion.allowed ? [`not complete: ${decision.completion.reason}`] : []),
      ...(handoff?.required && !opts['update-state'] ? ['TASK_STATE.md must be updated first (--update-state --owner <name>), then the handoff is written'] : []),
      ...(handoff ? [`handoff: ${handoff.required ? `REQUIRED (${handoff.reason}); ${handoff.order.join(', ')}` : `not required (${handoff.reason})`}`] : []),
      ...plan.limitations.map((l) => `limitation: ${l}`),
    ].join('\n') + '\n';
    print(out, opts.json, lines);
    if ((result && result.status !== 'PASS' && !(result.status === 'NOT_RUN' && result.required === false)) || (decision && !decision.completion.allowed)) process.exitCode = 1;
    return;
  }

  if (command === 'status') {
    const { status } = runStatus(root, common);
    const lines = status.artifacts.filter((a) => a.state !== 'CURRENT').map((a) => `${a.state.padEnd(12)} ${a.path}${a.reason ? `  (${a.reason})` : ''}`);
    const text = `${status.ok ? 'OK' : 'ATTENTION'}: ${status.counts.CURRENT} current, ${status.counts.STALE} stale, ${status.counts.UNVERIFIABLE} unverifiable, ${status.counts.MISSING} missing\n${lines.join('\n')}${lines.length ? '\n' : ''}${status.changes.changed.length ? `changed: ${status.changes.changed.slice(0, 10).join(', ')}\n` : ''}`;
    print(status, opts.json, text);
    if (!status.ok) process.exitCode = 1;
    return;
  }

  if (command === 'impact') {
    const target = pos[1] ?? opts.target;
    if (!target) throw new UsageError('impact needs a file path');
    const { impact } = runImpact(root, target, { ...common, depth: int(opts.depth, '--depth') });
    if (!impact.found) {
      print(impact, opts.json, `not found: ${target}\n`);
      process.exitCode = 1;
      return;
    }
    const list = (items) => (items.length ? items.map((i) => `  - ${typeof i === 'string' ? i : `${i.id} (distance ${i.distance})`}`).join('\n') : '  (none)');
    const text =
      `${impact.target}\n` +
      `risk: ${impact.risk.level ?? 'unknown'}${impact.risk.basis.length ? ` (${impact.risk.basis.join('; ')})` : ''}\n` +
      `public surface: ${impact.publicSurface ? impact.publicSurfaceReasons.join(', ') : 'no'}${impact.inCycle ? '; in a dependency cycle' : ''}\n` +
      `direct dependents (${impact.directDependents.length}):\n${list(impact.directDependents)}\n` +
      `affected overall (${impact.affectedCount}), highest risk among them: ${impact.maxRiskAmongAffected ?? 'n/a'}\n` +
      `tests that depend on it (${impact.tests.length}):\n${list(impact.tests)}\n` +
      `dependencies (${impact.dependencies.length}):\n${list(impact.dependencies)}\n` +
      impact.notes.map((n) => `note: ${n}`).join('\n') + '\n';
    return print(impact, opts.json, text);
  }

  if (command === 'handoff') {
    const sub = pos[1];
    if (!['create', 'resume'].includes(sub)) throw new UsageError('handoff needs a subcommand: create | resume');
    if (pos.length > 3) throw new UsageError(`unexpected argument "${pos[3]}"`);
    const common2 = ['json', 'root', 'config', 'task-state', 'handoff', 'owner', 'state', 'help'];
    const applicable = new Set(sub === 'create'
      ? [...common2, 'reason', 'to', 'next-action', 'active', 'caveat', 'decision', 'context-files', 'indexes', 'context-level']
      : [...common2, 'accept', 'confirm', 'acknowledge']);
    const stray = Object.keys(opts).filter((k) => !applicable.has(k));
    if (stray.length) throw new UsageError(`option(s) that do not apply to handoff ${sub}: ${stray.map((k) => `--${k}`).join(', ')}`);
    if (opts.state !== undefined && !INTELLIGENCE_STATES.includes(opts.state)) throw new UsageError(`--state must be one of ${INTELLIGENCE_STATES.join(', ')}`);
    const list = (v) => (v ? String(v).split(',').map((x) => x.trim()).filter(Boolean) : []);
    let outputDir = '.ai';
    try {
      outputDir = loadConfig(root, { configPath: opts.config }).outputDir;
    } catch {
      outputDir = '.ai';
    }
    const common3 = { taskState: opts['task-state'], handoff: opts.handoff, outputDir, intelligenceState: opts.state, configPath: opts.config };
    let out;
    if (sub === 'create') {
      if (!opts.owner) throw new UsageError('handoff create needs --owner: only the current owner issues a handoff');
      if (!opts.reason) throw new UsageError(`handoff create needs --reason: ${HANDOFF_REASONS.join(' | ')}`);
      out = await createHandoff(root, { ...common3, owner: opts.owner, reason: opts.reason, to: opts.to, nextAction: opts['next-action'], active: opts.active, caveats: opts.caveat, decisions: opts.decision, contextFiles: list(opts['context-files']), indexes: list(opts.indexes), contextLevel: opts['context-level'] });
    } else {
      if (opts.accept && !opts.owner) throw new UsageError('--accept needs --owner: the agent that takes ownership');
      out = await resumeHandoff(root, { ...common3, agent: opts.owner, accept: !!opts.accept, confirm: opts.confirm, acknowledge: opts.acknowledge });
    }
    const d = out.decision;
    const text = sub === 'create'
      ? [
        `handoff ${out.result}${out.code ? ` (${out.code})` : ''}${out.note ? `: ${out.note}` : ''}`,
        ...(out.handoff ? [`  id ${out.handoff.id}  to ${out.handoff.to}  reason ${out.handoff.reason}  file ${out.handoff.path}${out.handoff.previous ? `  previous ${out.handoff.previous}` : ''}`] : []),
        ...(out.state ? [`  task state ${out.state.path}: ownership ${out.state.ownership} (owner stays ${out.state.owner} until the receiver accepts)`] : []),
        ...(out.notes ?? []),
      ].join('\n') + '\n'
      : [
        `resume: ${out.result === 'refused' || out.result === 'needs-confirmation' || out.result === 'accepted' || out.result === 'noop' ? out.result : d.verdict}${out.code ? ` (${out.code})` : ''}${out.note ? `: ${out.note}` : ''}`,
        ...(d.ownership && !out.state ? [`  ownership ${d.ownership.label} (owner ${d.ownership.owner ?? 'none'}, status ${d.ownership.status ?? 'unknown'})`] : []),
        ...d.stops.map((s) => `  STOP ${s.code}: ${s.note}`),
        ...d.reconcile.map((r2) => `  RECONCILE ${r2.code}: ${r2.note}${r2.items?.length ? ` [${r2.items.join(', ')}]` : ''}`),
        ...(d.driftDigest ? [`  drift digest ${d.driftDigest} (acknowledge exactly this with --acknowledge to accept despite it)`] : []),
        ...d.notes.map((n) => `  note: ${n}`),
        ...(out.context && d.verdict !== 'noop' ? [`  context: handoff reached level ${out.context.handoffLevel}; start at 0, the router's next level is ${out.context.next ?? 'none'} (${out.context.rule})`] : []),
        ...(d.handoffId && d.verdict !== 'stop' && d.verdict !== 'noop' && !out.state ? [`  to take ownership: handoff resume --accept --owner <name> --confirm ${d.handoffId}${d.driftDigest ? ` --acknowledge ${d.driftDigest}` : ''}`] : []),
        ...(out.state ? [`  task state ${out.state.path}: owner ${out.state.owner}`] : []),
      ].join('\n') + '\n';
    print(out, opts.json, text);
    if (['refused', 'needs-confirmation', 'stop', 'reconcile'].includes(out.result)) process.exitCode = 1;
    return;
  }

  throw new UsageError(`unknown command "${command}"`);
}

main().catch((err) => {
  if (err instanceof UsageError || err instanceof ConfigError) {
    process.stderr.write(`${TOOL.name}: ${err.message}\n`);
    process.exitCode = 2;
  } else {
    process.stderr.write(`${TOOL.name}: unexpected error: ${err.stack ?? err}\n`);
    process.exitCode = 2;
  }
});
