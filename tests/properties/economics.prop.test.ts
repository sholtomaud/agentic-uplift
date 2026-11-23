import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEconomicsReport, checkEconomicsInvariants, resolveCostAssumptions } from '../../src/domain/economics.ts';
import type { IssueClass, PullComplianceSample, ResolvedIssueSample } from '../../src/shared/economics-types.ts';
import { assertProperty } from '../lib/property.ts';

const CLASSES: readonly IssueClass[] = ['security', 'bug', 'other'];
const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'gemini-2.5-pro', 'unknown-model'];

test('property: economics reports always satisfy invariants and keep measured figures inside modeled ranges', () => {
  assertProperty(
    'economics-invariants',
    {
      sample: (rng) => {
        const day = rng.int(1, 28);
        const now = new Date(Date.UTC(2026, rng.int(0, 11), day, 12));
        const issues: ResolvedIssueSample[] = Array.from({ length: rng.int(0, 25) }, (_, i) => {
          const closed = new Date(now.getTime() - rng.int(0, 60) * 86_400_000);
          const opened = new Date(closed.getTime() - rng.int(1, 400) * 3_600_000);
          const reported = rng.bool(0.4);
          return {
            number: i + 1,
            issue_class: rng.pick(CLASSES),
            origin: rng.bool(0.5) ? 'agent' : 'human',
            opened_at: opened.toISOString(),
            closed_at: closed.toISOString(),
            hours_to_first_pr: rng.bool(0.7) ? rng.int(0, 100) : null,
            hours_to_merge: rng.bool(0.7) ? rng.int(0, 100) : null,
            review_rounds: rng.int(0, 5),
            reverted: rng.bool(0.1),
            reopened: rng.bool(0.1),
            linked_fix: rng.bool(0.8),
            ci_minutes: rng.int(0, 200),
            agent_run_minutes: rng.bool(0.3) ? rng.int(1, 90) : null,
            reported_usage: reported
              ? { input_tokens: rng.int(0, 5_000_000), output_tokens: rng.int(0, 300_000), cache_read_tokens: rng.int(0, 5_000_000), model: rng.pick(MODELS) }
              : null,
          };
        });
        const pulls: PullComplianceSample[] = Array.from({ length: rng.int(0, 15) }, () => ({
          origin: rng.bool(0.5) ? 'agent' : 'human',
          conventional_title: rng.bool(0.7),
          links_issue: rng.bool(0.7),
          attributed: rng.bool(0.7),
          touches_tests: rng.bool(0.2) ? null : rng.bool(0.6),
          ci_green_first_push: rng.bool(0.2) ? null : rng.bool(0.7),
        }));
        return {
          now,
          issues,
          pulls,
          seats: rng.int(0, 3),
          rate: rng.int(20, 300),
          readiness: rng.int(0, 100),
        };
      },
    },
    ({ now, issues, pulls, seats, rate, readiness }) => {
      const r = buildEconomicsReport({
        repository: 'o/r',
        mode: 'github',
        now,
        windowDays: 60,
        issues,
        pulls,
        assumptions: resolveCostAssumptions({ copilot_seats: seats, human_hourly_rate: rate }),
        readinessScore: readiness,
        history: [],
      });
      assert.deepEqual(checkEconomicsInvariants(r), []);
      const measured = r.budgets.agentic.measured_spent ?? 0;
      assert.ok(measured <= r.budgets.agentic.spent.high + 0.01, 'measured spend never exceeds the modeled upper bound');
      assert.ok(r.budgets.agentic.spent.low >= 0 && r.budgets.human.spent.low >= 0);
      assert.equal(r.payoff.length, 1);
      assert.equal(r.payoff[0].readiness_score, readiness);
    }
  );
});
