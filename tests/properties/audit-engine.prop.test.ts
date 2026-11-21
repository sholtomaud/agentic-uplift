import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkAuditInvariants,
  runUpliftAudit,
  scoreAuditChecks,
} from '../../src/domain/audit-engine.ts';
import {
  AGENT_DOC_TOPICS,
  type AgentDocTopic,
  type RepoProfile,
} from '../../src/shared/audit-types.ts';
import { assertProperty } from '../lib/property.ts';

test('property: audit readiness score, autonomy level, and blockers ALWAYS satisfy formal invariants', () => {
  assertProperty(
    'audit-readiness-invariants',
    {
      sample: (rng): RepoProfile => {
        const topics: AgentDocTopic[] = AGENT_DOC_TOPICS.filter(() =>
          rng.bool(0.6)
        );
        const hasProofLock = rng.bool(0.6);
        const hasProofChangelog = rng.bool(0.6);
        return {
          repository: 'owner/repo',
          defaultBranch: 'main',
          ecosystems: ['npm'],
          languages: ['TypeScript'],
          fileCount: rng.int(1, 200),
          testFileCount: rng.int(0, 20),
          hasLockfile: rng.bool(0.5),
          hasProofLock,
          proofLockValid: hasProofLock ? rng.bool(0.7) : null,
          hasProofChangelog,
          proofChangelogValid: hasProofChangelog ? rng.bool(0.8) : null,
          hasPreCommitHook: rng.bool(0.6),
          hasPrePushHook: rng.bool(0.6),
          hooksPathConfigured: rng.bool(0.6),
          hasCodeowners: rng.bool(0.6),
          codeownersProtectsProof: rng.bool(0.5),
          hasAgentsMd: rng.bool(0.7),
          agentsMdTopics: topics,
          hasClaudeMd: rng.bool(0.3),
          hasSecurityPolicy: rng.bool(0.5),
          hasIssueForms: rng.bool(0.5),
          hasPrTemplate: rng.bool(0.5),
          hasDependabot: rng.bool(0.5),
          hasDependabotCooldown: rng.bool(0.4),
          hasCodeql: rng.bool(0.4),
          hasScorecard: rng.bool(0.4),
          hasDependencyReview: rng.bool(0.4),
          hasUpliftConfig: rng.bool(0.6),
          hasZeroRuntimeDeps: rng.bool(0.5) ? rng.bool(0.7) : null,
          branchProtectionEnabled: rng.bool(0.5) ? rng.bool(0.7) : null,
          workflows: rng.bool(0.8)
            ? [
                {
                  path: '.github/workflows/verify.yml',
                  triggers: rng.bool(0.8) ? ['pull_request', 'push'] : ['push'],
                  hasTests: rng.bool(0.7),
                  hasProofGate: rng.bool(0.6),
                  hasResolveGate: rng.bool(0.5),
                  hasPermissions: rng.bool(0.7),
                  unpinnedActions: rng.bool(0.25) ? ['actions/checkout@v4'] : [],
                },
              ]
            : [],
          ciPassRate: rng.bool(0.5) ? rng.int(0, 100) / 100 : null,
          ciFailingNow: rng.bool(0.25) ? ['verify'] : [],
          closedIssuesCount: rng.bool(0.5) ? rng.int(0, 30) : null,
          linkedFixShare: rng.bool(0.5) ? rng.int(0, 100) / 100 : null,
          agentAttributionCount: rng.bool(0.5) ? rng.int(0, 10) : null,
          costConfigured: rng.bool(0.5),
        };
      },
    },
    (profile) => {
      const checks = runUpliftAudit(profile);
      const summary = scoreAuditChecks(checks);
      assert.deepEqual(checkAuditInvariants(checks, summary), []);
    },
    { runs: 250 }
  );
});
