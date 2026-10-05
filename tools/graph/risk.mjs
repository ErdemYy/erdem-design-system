import { createMatcher } from '../lib/glob.mjs';

export const RISK_RANK = Object.freeze({ LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 });
export const RISK_BY_RANK = Object.freeze([null, 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

const SURFACE_LEVEL = {
  'package-entry': ['HIGH', 'package entry point: external consumers depend on it'],
  'global-config': ['HIGH', 'global configuration at the project root'],
  'framework-route': ['MEDIUM', 'framework route file'],
  'shared-module': ['MEDIUM', 'imported from several other subsystems'],
  configured: ['MEDIUM', 'configured public surface'],
};

/**
 * Conservative risk. Every level carries its evidence. Names alone never raise risk: only structure
 * (consumers, entry points, root configuration) and explicit project rules do. CRITICAL is reachable only
 * through a project-configured rule.
 *
 * node: {id, category, language, supportsDependencies, parseStatus, surfaceReasons[], importerCount}
 */
export function createRiskEvaluator(cfg) {
  const rules = cfg.risk.rules.map((r) => ({ match: createMatcher([r.pattern]), level: r.level, reason: r.reason ?? `configured rule ${r.pattern}` }));
  return function evaluate(node) {
    const basis = [];
    let rank = 0;
    const raise = (level, why) => {
      basis.push(`${level}: ${why}`);
      rank = Math.max(rank, RISK_RANK[level]);
    };

    for (const r of rules) if (r.match(node.id, false)) raise(r.level, r.reason);
    for (const reason of node.surfaceReasons) {
      const entry = SURFACE_LEVEL[reason];
      if (entry) raise(entry[0], entry[1]);
    }
    const n = node.importerCount;
    if (n >= cfg.risk.fanInHigh) raise('HIGH', `${n} dependents (at or above ${cfg.risk.fanInHigh})`);
    else if (n >= cfg.risk.fanInMedium) raise('MEDIUM', `${n} dependents (at or above ${cfg.risk.fanInMedium})`);
    else if (rank === 0 && n >= 1) raise('LOW', `${n} dependent${n === 1 ? '' : 's'}`);
    else if (rank === 0 && node.category === 'test') raise('LOW', 'test file');
    else if (rank === 0 && node.supportsDependencies && (node.parseStatus === 'parsed' || node.parseStatus === 'partial')) raise('LOW', 'no dependents found by static analysis');

    if (node.parseStatus === 'partial') basis.push('note: file only partially parsed; dependency data may be incomplete');
    if (node.parseStatus === 'failed') basis.push('note: parse failed; dependency data unavailable');
    if (rank === 0) {
      basis.push('insufficient evidence: no dependency analysis for this file or its dependents');
      return { level: null, basis };
    }
    return { level: RISK_BY_RANK[rank], basis };
  };
}
