import { SCHEMA, TOOL } from '../lib/constants.mjs';
import { setFingerprint } from '../lib/fingerprint.mjs';
import { cmp, isUnder } from '../lib/util.mjs';
import { RISK_RANK, RISK_BY_RANK } from '../graph/risk.mjs';
import { roleOf } from './render.mjs';

const NOTICE = 'Derived by project-intel from static analysis. A navigation aid, never authoritative: verify against source before relying on it.';
const CAP = 20;

/**
 * Concise, replaceable summaries. Nothing here copies implementation: `purpose` is at most the first
 * sentence of a leading comment (or README), everything else is structural data from the graph.
 * Dependency, consumer, role, constraint and risk fields are volatile: they can change without the described
 * file changing, so they are listed in `volatileFields` and must be re-verified when relied on.
 */
const VOLATILE = ['architecturalRole', 'dependencies', 'consumers', 'constraints', 'risks'];

function constraintsFor(node) {
  const out = [];
  const m = node.metadata;
  if (node.publicSurface) out.push(`public surface (${m.publicSurfaceReasons.join(', ')}): a change can affect dependents outside its own subsystem`);
  if (m.inCycle) out.push('participates in a dependency cycle');
  if (m.dependencyAnalysis === 'none') out.push('no dependency analysis for this language: dependency and consumer lists may be incomplete');
  if (m.parseStatus === 'partial') out.push('partially parsed: dependency data may be incomplete');
  if (m.parseStatus === 'failed') out.push('parse failed: dependency data unavailable');
  return out;
}

export function fileSummary({ node, hint, now }) {
  const localDeps = node.imports.filter((i) => !i.startsWith('ext:'));
  return {
    schema: 'erdem.summary',
    schemaVersion: SCHEMA.summary,
    tool: { name: TOOL.name, version: TOOL.version },
    generatedAt: now,
    source: `${TOOL.name}@${TOOL.version} (graph and fingerprint)`,
    path: node.id,
    scope: 'file',
    fingerprint: node.fingerprint ?? { algo: 'sha256', hash: null, reason: 'unreadable' },
    purpose: hint ?? null,
    architecturalRole: roleOf(node),
    dependencies: {
      local: localDeps.slice(0, CAP),
      localCount: localDeps.length,
      external: node.metadata.externalImports.slice(0, CAP),
      externalCount: node.metadata.externalImports.length,
    },
    consumers: { ids: node.consumers.slice(0, CAP), count: node.consumers.length },
    constraints: constraintsFor(node),
    risks: { level: node.risk, basis: node.metadata.riskBasis },
    volatileFields: VOLATILE,
    notice: NOTICE,
  };
}

export function directorySummary({ dir, members, nodeMap, hashByPath, hint, now }) {
  const files = members.filter((n) => n.metadata.category === 'source' || n.metadata.category === 'test');
  const fp = setFingerprint(files.map((n) => ({ path: n.id, hash: hashByPath.get(n.id) ?? null })));
  const memberIds = new Set(members.map((n) => n.id));
  const deps = new Set();
  const ext = new Set();
  const users = new Set();
  let rank = 0;
  for (const n of members) {
    rank = Math.max(rank, RISK_RANK[n.risk] ?? 0);
    for (const t of n.imports) {
      if (memberIds.has(t)) continue;
      const tn = nodeMap.get(t);
      if (tn?.type === 'external') ext.add(tn.metadata.package);
      else if (tn) deps.add(tn.metadata.subsystem);
    }
    for (const c of n.consumers) {
      const cn = nodeMap.get(c);
      if (cn && !memberIds.has(c) && cn.metadata.category !== 'test') users.add(cn.metadata.subsystem);
    }
  }
  const surfaces = members.filter((n) => n.publicSurface).length;
  const constraints = [];
  if (surfaces) constraints.push(`${surfaces} public surface file(s) in this directory`);
  if (members.some((n) => n.metadata.inCycle)) constraints.push('contains files that participate in a dependency cycle');
  if (members.some((n) => n.metadata.dependencyAnalysis === 'none')) constraints.push('some files have no dependency analysis: lists may be incomplete');
  return {
    schema: 'erdem.summary',
    schemaVersion: SCHEMA.summary,
    tool: { name: TOOL.name, version: TOOL.version },
    generatedAt: now,
    source: `${TOOL.name}@${TOOL.version} (graph and set fingerprint of member files)`,
    path: dir,
    scope: 'directory',
    fingerprint: fp,
    purpose: hint ?? null,
    architecturalRole: surfaces ? 'subsystem with public surface' : 'subsystem',
    dependencies: { local: [...deps].sort(cmp).slice(0, CAP), localCount: deps.size, external: [...ext].sort(cmp).slice(0, CAP), externalCount: ext.size },
    consumers: { ids: [...users].sort(cmp).slice(0, CAP), count: users.size },
    constraints,
    risks: { level: RISK_BY_RANK[rank], basis: rank ? [`highest risk among ${members.length} files`] : ['no risk evidence'] },
    volatileFields: VOLATILE,
    notice: NOTICE,
  };
}

export { isUnder };
