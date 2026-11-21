import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkResolveGateInvariants,
  evaluateResolveGate,
} from '../../src/domain/resolve-gate.ts';
import type { ResolveGateInput } from '../../src/shared/gate-types.ts';

function baseInput(overrides: Partial<ResolveGateInput> = {}): ResolveGateInput {
  return {
    issues: [
      {
        number: 10,
        title: 'Add proof-lock workflow',
        labels: ['agentic-uplift'],
        createdAt: '2026-11-20T00:00:00Z',
      },
      {
        number: 11,
        title: 'Fix security leak',
        labels: ['agent-ready', 'security'],
        createdAt: '2026-11-21T00:00:00Z',
      },
    ],
    openPrs: [],
    ciFailingNow: [],
    proofSealOk: true,
    requireProofSeal: true,
    agenticMonthlySpend: 10,
    agenticMonthlyBudget: 50,
    requestedIssue: null,
    maxOpenAgentPrs: 2,
    ...overrides,
  };
}

test('resolve-gate pauses immediately when proof seal is broken', () => {
  const input = baseInput({ proofSealOk: false, requireProofSeal: true });
  const decision = evaluateResolveGate(input);
  assert.deepEqual(checkResolveGateInvariants(input, decision), []);
  assert.equal(decision.proceed, false);
  assert.equal(decision.reason, 'proof-seal-broken');
});

test('resolve-gate prioritizes security/incident issues over audit/bug issues', () => {
  const input = baseInput();
  const decision = evaluateResolveGate(input);
  assert.deepEqual(checkResolveGateInvariants(input, decision), []);
  assert.equal(decision.proceed, true);
  assert.equal(decision.issue?.number, 11);
});

test('resolve-gate pauses on open agent PR cap and budget cap', () => {
  const capInput = baseInput({
    openPrs: [
      { number: 1, title: 'PR 1', body: '', isAgent: true },
      { number: 2, title: 'PR 2', body: '', isAgent: true },
    ],
  });
  const capDecision = evaluateResolveGate(capInput);
  assert.equal(capDecision.proceed, false);
  assert.equal(capDecision.reason, 'open-agent-pr-cap');

  const budgetInput = baseInput({
    agenticMonthlySpend: 50,
    agenticMonthlyBudget: 50,
  });
  const budgetDecision = evaluateResolveGate(budgetInput);
  assert.equal(budgetDecision.proceed, false);
  assert.equal(budgetDecision.reason, 'agentic-budget-exceeded');
});

test('resolve-gate allows only recovery issues when default-branch CI is red', () => {
  const onlyFeature = baseInput({
    issues: [
      {
        number: 20,
        title: 'Add dark mode',
        labels: ['agent-ready'],
        createdAt: '2026-11-20T00:00:00Z',
      },
    ],
    ciFailingNow: ['verify'],
  });
  const paused = evaluateResolveGate(onlyFeature);
  assert.equal(paused.proceed, false);
  assert.equal(paused.reason, 'ci-failing-on-main');

  const withIncident = baseInput({ ciFailingNow: ['verify'] });
  const recovery = evaluateResolveGate(withIncident);
  assert.equal(recovery.proceed, true);
  assert.equal(recovery.issue?.number, 11);
});
