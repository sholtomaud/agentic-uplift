import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkAuditInvariants,
  runUpliftAudit,
  scoreAuditChecks,
} from '../../src/domain/audit-engine.ts';
import { AGENT_DOC_TOPICS, type RepoProfile } from '../../src/shared/audit-types.ts';

function makeHealthyProfile(overrides: Partial<RepoProfile> = {}): RepoProfile {
  return {
    repository: 'sholtomaud/agentic-uplift',
    defaultBranch: 'main',
    ecosystems: ['npm'],
    languages: ['TypeScript'],
    fileCount: 40,
    testFileCount: 12,
    hasLockfile: false,
    hasProofLock: true,
    proofLockValid: true,
    hasProofChangelog: true,
    proofChangelogValid: true,
    hasPreCommitHook: true,
    hasPrePushHook: true,
    hooksPathConfigured: true,
    hasCodeowners: true,
    codeownersProtectsProof: true,
    hasAgentsMd: true,
    agentsMdTopics: [...AGENT_DOC_TOPICS],
    hasClaudeMd: false,
    hasSecurityPolicy: true,
    hasIssueForms: true,
    hasPrTemplate: true,
    hasDependabot: true,
    hasDependabotCooldown: true,
    hasCodeql: true,
    hasScorecard: true,
    hasDependencyReview: true,
    hasUpliftConfig: true,
    hasZeroRuntimeDeps: true,
    branchProtectionEnabled: true,
    workflows: [
      {
        path: '.github/workflows/verify.yml',
        triggers: ['push', 'pull_request'],
        hasTests: true,
        hasProofGate: true,
        hasResolveGate: false,
        hasPermissions: true,
        unpinnedActions: [],
      },
      {
        path: '.github/workflows/agent-resolve.yml',
        triggers: ['schedule'],
        hasTests: false,
        hasProofGate: false,
        hasResolveGate: true,
        hasPermissions: true,
        unpinnedActions: [],
      },
    ],
    ciPassRate: 1,
    ciFailingNow: [],
    closedIssuesCount: 10,
    linkedFixShare: 0.9,
    agentAttributionCount: 3,
    costConfigured: true,
    ...overrides,
  };
}

test('fully hardened repo scores autonomous-ready with zero blockers', () => {
  const checks = runUpliftAudit(makeHealthyProfile());
  const summary = scoreAuditChecks(checks);
  assert.deepEqual(checkAuditInvariants(checks, summary), []);
  assert.equal(summary.autonomy, 'autonomous-ready');
  assert.equal(summary.blockers.length, 0);
  assert.equal(summary.score, 100);
});

test('missing proof-lock or pr-tamper-gate blocks autonomous-ready', () => {
  const checks = runUpliftAudit(
    makeHealthyProfile({ hasProofLock: false, proofLockValid: null })
  );
  const summary = scoreAuditChecks(checks);
  assert.deepEqual(checkAuditInvariants(checks, summary), []);
  assert.equal(summary.autonomy, 'not-ready');
  assert.ok(summary.blockers.includes('proof-lock'));
});

test('missing git hooks emits executable pre-commit and pre-push fix templates', () => {
  const checks = runUpliftAudit(
    makeHealthyProfile({
      hasPreCommitHook: false,
      hasPrePushHook: false,
      hooksPathConfigured: false,
    })
  );
  const hookCheck = checks.find((c) => c.id === 'git-hooks');
  assert.ok(hookCheck);
  assert.equal(hookCheck.status, 'missing');
  assert.ok(hookCheck.fixes.some((f) => f.path === '.githooks/pre-commit'));
  assert.ok(hookCheck.fixes.some((f) => f.path === '.githooks/pre-push'));
});
