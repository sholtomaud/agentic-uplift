import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkResolveGateInvariants,
  evaluateResolveGate,
} from '../../src/domain/resolve-gate.ts';
import type {
  GateIssue,
  GatePr,
  ResolveGateInput,
} from '../../src/shared/gate-types.ts';
import { assertProperty } from '../lib/property.ts';

const LABEL_POOL = [
  'agentic-uplift',
  'agent-ready',
  'security',
  'incident',
  'bug',
  'enhancement',
] as const;

test('property: Proof-Aware resolve-gate NEVER violates safety invariants across arbitrary repository states', () => {
  assertProperty(
    'resolve-gate-safety-invariants',
    {
      sample: (rng): ResolveGateInput => {
        const issueCount = rng.int(0, 8);
        const issues: GateIssue[] = [];
        for (let i = 1; i <= issueCount; i += 1) {
          const labels: string[] = [];
          for (const l of LABEL_POOL) {
            if (rng.bool(0.35)) labels.push(l);
          }
          issues.push({
            number: i,
            title: rng.bool(0.25) ? `Fix CI check #${i}` : `Task #${i}`,
            labels,
            createdAt: `2026-11-${String(rng.int(10, 20)).padStart(2, '0')}T00:00:00Z`,
          });
        }

        const prCount = rng.int(0, 4);
        const openPrs: GatePr[] = [];
        for (let i = 1; i <= prCount; i += 1) {
          const fixesIssue = rng.bool(0.4) && issueCount > 0;
          openPrs.push({
            number: 100 + i,
            title: `PR ${i}`,
            body: fixesIssue ? `Fixes #${rng.int(1, issueCount)}` : 'misc',
            isAgent: rng.bool(0.5),
          });
        }

        const hasBudget = rng.bool(0.5);
        return {
          issues,
          openPrs,
          ciFailingNow: rng.bool(0.35) ? ['verify'] : [],
          proofSealOk: rng.bool(0.7),
          requireProofSeal: rng.bool(0.8),
          agenticMonthlyBudget: hasBudget ? rng.int(10, 100) : null,
          agenticMonthlySpend: hasBudget ? rng.int(0, 130) : null,
          requestedIssue:
            rng.bool(0.25) && issueCount > 0 ? rng.int(1, issueCount + 1) : null,
          maxOpenAgentPrs: rng.int(1, 3),
        };
      },
    },
    (input) => {
      const decision = evaluateResolveGate(input);
      const errors = checkResolveGateInvariants(input, decision);
      assert.deepEqual(errors, []);
    },
    { runs: 300 }
  );
});
