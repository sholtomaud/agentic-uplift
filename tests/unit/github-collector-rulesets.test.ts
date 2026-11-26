import assert from 'node:assert/strict';
import test from 'node:test';
import type { GitHubClient, GitHubRestResponse } from '../../src/adapters/github-client.ts';
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

/**
 * Legacy `/branches/{b}/protection` answers 404 for a branch that is
 * protected only by a repository ruleset; `/rules/branches/{b}` lists the
 * active ruleset rules and is readable with the default GITHUB_TOKEN.
 */
function makeClient(
  legacyStatus: number,
  rules: GitHubRestResponse,
  seen: string[] = []
): GitHubClient {
  return {
    async rest(endpoint: string): Promise<unknown> {
      const res = await this.restWithStatus(endpoint);
      return res.ok ? res.data : null;
    },
    async restWithStatus(endpoint: string): Promise<GitHubRestResponse> {
      seen.push(endpoint);
      if (endpoint.includes('/rules/branches/')) return rules;
      if (endpoint.includes('/protection')) {
        return {
          status: legacyStatus,
          ok: legacyStatus === 200,
          data: legacyStatus === 200 ? { required_status_checks: {} } : null,
        };
      }
      if (endpoint.includes('/actions/runs')) {
        return { status: 200, ok: true, data: { workflow_runs: [] } };
      }
      return { status: 200, ok: true, data: [] };
    },
  };
}

function ok(data: unknown): GitHubRestResponse {
  return { status: 200, ok: true, data };
}

const RULESET_RULES = [
  { type: 'deletion', ruleset_source_type: 'Repository', ruleset_id: 1 },
  { type: 'non_fast_forward', ruleset_source_type: 'Repository', ruleset_id: 1 },
  {
    type: 'pull_request',
    ruleset_source_type: 'Repository',
    ruleset_id: 1,
    parameters: { required_approving_review_count: 1, require_code_owner_review: true },
  },
  {
    type: 'required_status_checks',
    ruleset_source_type: 'Repository',
    ruleset_id: 1,
    parameters: { required_status_checks: [{ context: 'Proof tamper gate (agentic-uplift)' }] },
  },
];

test('collectGitHubTelemetry queries the branch rules endpoint for the default branch', async () => {
  const seen: string[] = [];
  await collectGitHubTelemetry(makeClient(404, ok([]), seen), stubProfile(), 'sholtomaud/agentic-uplift');
  assert.ok(seen.includes('/repos/sholtomaud/agentic-uplift/rules/branches/main'), seen.join('\n'));
});

test('a ruleset-only branch (legacy 404) counts as protected', async () => {
  const res = await collectGitHubTelemetry(
    makeClient(404, ok(RULESET_RULES)),
    stubProfile(),
    'sholtomaud/agentic-uplift'
  );
  assert.equal(res.profile.branchProtectionEnabled, true);
});

test('a ruleset counts as protected even when the legacy endpoint is denied (403)', async () => {
  const res = await collectGitHubTelemetry(
    makeClient(403, ok(RULESET_RULES)),
    stubProfile(),
    'sholtomaud/agentic-uplift'
  );
  assert.equal(res.profile.branchProtectionEnabled, true);
});

test('rules that neither require a PR nor status checks do not count as protection', async () => {
  const res = await collectGitHubTelemetry(
    makeClient(404, ok([{ type: 'deletion' }, { type: 'non_fast_forward' }])),
    stubProfile(),
    'sholtomaud/agentic-uplift'
  );
  assert.equal(res.profile.branchProtectionEnabled, false);
});

test('no rules and legacy 404 is still missing; unreadable rules fall back to legacy', async () => {
  const none = await collectGitHubTelemetry(makeClient(404, ok([])), stubProfile(), 'sholtomaud/agentic-uplift');
  assert.equal(none.profile.branchProtectionEnabled, false);

  const denied = await collectGitHubTelemetry(
    makeClient(403, { status: 403, ok: false, data: null }),
    stubProfile(),
    'sholtomaud/agentic-uplift'
  );
  assert.equal(denied.profile.branchProtectionEnabled, null);

  const legacyOnly = await collectGitHubTelemetry(
    makeClient(200, { status: 404, ok: false, data: null }),
    stubProfile(),
    'sholtomaud/agentic-uplift'
  );
  assert.equal(legacyOnly.profile.branchProtectionEnabled, true);
});
