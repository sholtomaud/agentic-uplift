import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildManualUpliftCommands,
  checkAuditInvariants,
  runUpliftAudit,
  scoreAuditChecks,
} from '../../src/domain/audit-engine.ts';
import {
  AGENT_DOC_TOPICS,
  type RepoProfile,
} from '../../src/shared/audit-types.ts';

function makeProfile(overrides: Partial<RepoProfile> = {}): RepoProfile {
  return {
    repository: 'sholtomaud/agentic-uplift',
    defaultBranch: 'main',
    ecosystems: ['npm'],
    languages: ['TypeScript'],
    fileCount: 60,
    testFileCount: 13,
    hasLockfile: false,
    hasProofLock: true,
    proofLockValid: true,
    hasProofChangelog: true,
    proofChangelogValid: true,
    hasPreCommitHook: true,
    hasPrePushHook: true,
    hooksPathConfigured: false,
    hasCodeowners: true,
    codeownersProtectsProof: true,
    hasAgentsMd: true,
    agentsMdTopics: [...AGENT_DOC_TOPICS],
    hasClaudeMd: false,
    hasSecurityPolicy: true,
    hasIssueForms: true,
    hasPrTemplate: true,
    hasDependabot: false,
    hasDependabotCooldown: false,
    hasCodeql: false,
    hasScorecard: false,
    hasDependencyReview: false,
    hasUpliftConfig: true,
    hasZeroRuntimeDeps: true,
    branchProtectionEnabled: null,
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
    closedIssuesCount: 0,
    linkedFixShare: null,
    agentAttributionCount: null,
    costConfigured: true,
    ...overrides,
  };
}

test('git-hooks passes in github CI mode when tracked hooks exist even without local core.hooksPath', () => {
  const ciChecks = runUpliftAudit(
    makeProfile({ hooksPathConfigured: false }),
    'github'
  );
  const ciHook = ciChecks.find((c) => c.id === 'git-hooks');
  assert.ok(ciHook);
  assert.equal(ciHook.status, 'pass');

  const localChecks = runUpliftAudit(
    makeProfile({ hooksPathConfigured: false }),
    'local'
  );
  const localHook = localChecks.find((c) => c.id === 'git-hooks');
  assert.ok(localHook);
  assert.equal(localHook.status, 'improve');
});

test('branch-protection waits on null (403/offline) and emits repo-interpolated gh CLI ruleset command on false (404)', () => {
  const waitingChecks = runUpliftAudit(
    makeProfile({ branchProtectionEnabled: null }),
    'github'
  );
  const waiting = waitingChecks.find((c) => c.id === 'branch-protection');
  assert.ok(waiting);
  assert.equal(waiting.status, 'waiting');
  assert.ok(
    waiting.fixes.some(
      (f) =>
        f.language === 'shell' &&
        f.content.includes('gh api') &&
        f.content.includes('sholtomaud/agentic-uplift')
    )
  );

  const missingChecks = runUpliftAudit(
    makeProfile({ branchProtectionEnabled: false }),
    'github'
  );
  const missing = missingChecks.find((c) => c.id === 'branch-protection');
  assert.ok(missing);
  assert.equal(missing.status, 'missing');
  assert.ok(
    missing.fixes.some(
      (f) =>
        f.language === 'shell' &&
        f.content.includes('gh api') &&
        f.content.includes('sholtomaud/agentic-uplift') &&
        !f.content.includes('{owner}')
    )
  );
});

test('agent-attribution stays waiting when no PRs or closed issues exist yet', () => {
  const checks = runUpliftAudit(
    makeProfile({ agentAttributionCount: null, closedIssuesCount: 0 }),
    'github'
  );
  const attr = checks.find((c) => c.id === 'agent-attribution');
  assert.ok(attr);
  assert.equal(attr.status, 'waiting');
  const summary = scoreAuditChecks(checks);
  assert.deepEqual(checkAuditInvariants(checks, summary), []);
});

test('buildManualUpliftCommands produces actionable repo-specific gh CLI commands', () => {
  const profile = makeProfile({ branchProtectionEnabled: false });
  const checks = runUpliftAudit(profile, 'github');
  const commands = buildManualUpliftCommands(profile, checks);
  assert.ok(commands.length >= 3);
  for (const item of commands) {
    assert.ok(item.title.length > 0);
    assert.ok(item.command.length > 0);
    assert.ok(!item.command.includes('{owner}'));
    assert.ok(!item.command.includes('@OWNER'));
  }
  assert.ok(
    commands.some(
      (c) =>
        c.id === 'branch-rules' &&
        c.command.includes('gh api') &&
        c.command.includes('sholtomaud/agentic-uplift') &&
        c.command.includes('"bypass_actors"') &&
        c.command.includes('"bypass_mode": "pull_request"')
    )
  );
  assert.ok(
    commands.some(
      (c) =>
        c.id === 'tamper-labels' &&
        c.command.includes('gh label create') &&
        c.command.includes('allow-test-change')
    )
  );
});
