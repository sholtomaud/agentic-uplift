/**
 * Writes the deterministic fixture the visual snapshot workflow renders:
 * `visual/fixture/data/economics.json` from seeded synthetic samples and a
 * frozen clock. The other endpoints in `visual/fixture/data/` are frozen
 * copies of a local publish; regenerate them only when their schema changes.
 *
 *   node visual/make-fixture.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildEconomicsReport, DEFAULT_COST_ASSUMPTIONS, resolveCostAssumptions } from '../src/domain/economics.ts';
import type { IssueClass, PayoffPoint, PullComplianceSample, ResolvedIssueSample } from '../src/shared/economics-types.ts';

const NOW = new Date('2026-11-20T12:00:00Z');
const OUT = path.join(import.meta.dirname, 'fixture', 'data', 'economics.json');

/** Small LCG so the fixture never changes between runs. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

const rand = rng(20261120);
const classes: IssueClass[] = ['security', 'bug', 'other'];
const issues: ResolvedIssueSample[] = [];
for (let i = 0; i < 40; i += 1) {
  const agent = i % 3 !== 0;
  const opened = new Date(NOW.getTime() - (2 + rand() * 40) * 86_400_000);
  const elapsedH = agent ? 1 + rand() * 30 : 8 + rand() * 200;
  const closed = new Date(Math.min(NOW.getTime(), opened.getTime() + elapsedH * 3_600_000));
  const reported = agent && i % 2 === 0;
  issues.push({
    number: 100 + i,
    issue_class: classes[i % 3] ?? 'other',
    origin: agent ? 'agent' : 'human',
    opened_at: opened.toISOString(),
    closed_at: closed.toISOString(),
    hours_to_first_pr: agent ? 0.2 + rand() * 3 : 4 + rand() * 60,
    hours_to_merge: agent ? 0.5 + rand() * 20 : 2 + rand() * 48,
    review_rounds: agent ? 1 + Math.floor(rand() * 3) : Math.floor(rand() * 2),
    reverted: agent && i % 13 === 1,
    reopened: i % 11 === 4,
    linked_fix: i % 9 !== 0,
    ci_minutes: Math.round((4 + rand() * 20) * 10) / 10,
    agent_run_minutes: reported ? Math.round(8 + rand() * 40) : null,
    reported_usage: reported
      ? {
          input_tokens: Math.round(400_000 + rand() * 1_500_000),
          output_tokens: Math.round(30_000 + rand() * 90_000),
          cache_read_tokens: Math.round(rand() * 2_000_000),
          model: 'claude-sonnet-5-5',
        }
      : null,
  });
}

const pulls: PullComplianceSample[] = issues.map((issue, i) => ({
  origin: issue.origin,
  conventional_title: issue.origin === 'agent' ? i % 7 !== 0 : i % 3 !== 0,
  links_issue: issue.linked_fix,
  attributed: issue.origin === 'agent' ? i % 5 !== 0 : false,
  touches_tests: issue.origin === 'agent' ? i % 4 !== 0 : i % 2 === 0,
  ci_green_first_push: issue.origin === 'agent' ? i % 3 !== 1 : i % 4 !== 1,
}));

const history: PayoffPoint[] = [52, 58, 61, 67, 72, 74, 79].map((score, i) => ({
  date: new Date(NOW.getTime() - (7 - i) * 3 * 86_400_000).toISOString().slice(0, 10),
  readiness_score: score,
  monthly_savings: { low: 400 + i * 260, high: 1500 + i * 520 },
  agent_change_failure_rate: Math.round((0.14 - i * 0.012) * 1000) / 1000,
}));

const report = buildEconomicsReport({
  repository: 'example/flight-deck',
  mode: 'github',
  now: NOW,
  windowDays: 42,
  issues,
  pulls,
  assumptions: resolveCostAssumptions(DEFAULT_COST_ASSUMPTIONS, {
    monthly_human_budget: 20_000,
    monthly_agentic_budget: 600,
  }),
  readinessScore: 82,
  history,
});

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Wrote ${path.relative(process.cwd(), OUT)}`);
