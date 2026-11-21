import assert from 'node:assert/strict';
import test from 'node:test';
import type { GitHubClient } from '../../src/adapters/github-client.ts';
import { collectGitHubTelemetry } from '../../src/adapters/github-collector.ts';
import type { RepoProfile } from '../../src/shared/audit-types.ts';

function stubProfile(): RepoProfile {
  return {
    repository: 'sholtomaud/agentic-uplift',
    defaultBranch: 'main',
    ecosystems: ['npm'],
    languages: ['TypeScript'],
    fileCount: 20,
    testFileCount: 5,
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
    agentsMdTopics: [],
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
    workflows: [],
    ciPassRate: null,
    ciFailingNow: [],
    closedIssuesCount: null,
    linkedFixShare: null,
    agentAttributionCount: null,
    costConfigured: false,
  };
}

function makeMockClient(
  protectionStatus: number,
  options: { readonly mergedPrs?: number } = {}
): GitHubClient {
  return {
    async rest(endpoint: string): Promise<unknown> {
      const res = await this.restWithStatus(endpoint);
      return res.ok ? res.data : null;
    },
    async restWithStatus(endpoint: string) {
      if (endpoint.includes('/protection')) {
        return {
          status: protectionStatus,
          ok: protectionStatus === 200,
          data: protectionStatus === 200 ? { required_status_checks: {} } : null,
        };
      }
      if (endpoint.includes('/pulls')) {
        const count = options.mergedPrs ?? 0;
        const pulls = Array.from({ length: count }, (_, i) => ({
          number: i + 1,
          state: 'closed',
          created_at: '2026-11-20T00:00:00Z',
          merged_at: '2026-11-20T01:00:00Z',
          user: { login: 'sholtomaud' },
          title: `PR ${i + 1}`,
          body: 'Co-Authored-By: Claude <noreply@anthropic.com>',
        }));
        return { status: 200, ok: true, data: pulls };
      }
      if (endpoint.includes('/actions/runs')) {
        return { status: 200, ok: true, data: { workflow_runs: [] } };
      }
      return { status: 200, ok: true, data: [] };
    },
  };
}

test('collectGitHubTelemetry maps 403 protection to null (waiting), 404 to false (missing), and 200 to true (pass)', async () => {
  const denied = await collectGitHubTelemetry(
    makeMockClient(403),
    stubProfile(),
    'sholtomaud/agentic-uplift'
  );
  assert.equal(denied.profile.branchProtectionEnabled, null);

  const missing = await collectGitHubTelemetry(
    makeMockClient(404),
    stubProfile(),
    'sholtomaud/agentic-uplift'
  );
  assert.equal(missing.profile.branchProtectionEnabled, false);

  const protectedRes = await collectGitHubTelemetry(
    makeMockClient(200),
    stubProfile(),
    'sholtomaud/agentic-uplift'
  );
  assert.equal(protectedRes.profile.branchProtectionEnabled, true);
});

test('collectGitHubTelemetry leaves agentAttributionCount null when 0 PRs and 0 closed issues exist', async () => {
  const emptyRepo = await collectGitHubTelemetry(
    makeMockClient(403, { mergedPrs: 0 }),
    stubProfile(),
    'sholtomaud/agentic-uplift'
  );
  assert.equal(emptyRepo.profile.agentAttributionCount, null);

  const activeRepo = await collectGitHubTelemetry(
    makeMockClient(403, { mergedPrs: 1 }),
    stubProfile(),
    'sholtomaud/agentic-uplift'
  );
  assert.equal(activeRepo.profile.agentAttributionCount, 1);
});
