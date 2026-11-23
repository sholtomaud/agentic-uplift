import assert from 'node:assert/strict';
import test from 'node:test';
import type { GitHubClient, GitHubRestResponse } from '../../src/adapters/github-client.ts';
import { collectGitHubTelemetry } from '../../src/adapters/github-collector.ts';
import {
  computeIssueMetrics,
  extractClosingIssueNumbers,
  hasAgentAttribution,
  hasAgentOpenerDisclosure,
  isAgentIdentity,
  isAgentLogin,
  resolveClosureOrigin,
} from '../../src/domain/metrics.ts';
import type { RepoProfile } from '../../src/shared/audit-types.ts';

test('isAgentLogin matches agent names as whole tokens, not substrings', () => {
  for (const login of ['Copilot', 'claude', 'claude-bot', 'devin-ai-integration[bot]', 'antigravity-agent', 'gemini-code-assist', 'roo-code', 'amp-agent', 'openhands']) {
    assert.equal(isAgentLogin(login), true, login);
  }
  for (const login of ['claudeshannon', 'sholtomaud', 'ampersand', 'cursorial', 'rooster', '']) {
    assert.equal(isAgentLogin(login), false, login);
  }
  assert.equal(isAgentLogin('dependabot[bot]'), false, 'dependency bots are not coding agents');
  assert.equal(isAgentLogin('my-robot', ['My-Robot']), true, 'extra logins are honoured');
});

test('hasAgentAttribution reads Co-Authored-By, Assisted-by and Generated-by trailers and signatures', () => {
  assert.equal(hasAgentAttribution('fix\n\nCo-Authored-By: Claude <noreply@anthropic.com>'), true);
  assert.equal(hasAgentAttribution('Assisted-by: Gemini'), true);
  assert.equal(hasAgentAttribution('Generated-by: Antigravity'), true);
  assert.equal(hasAgentAttribution('Co-authored-by: Roo Code <roo@users.noreply.github.com>'), true);
  assert.equal(hasAgentAttribution('🤖 Generated with [Claude Code](https://claude.com/claude-code)'), true);
  assert.equal(hasAgentAttribution('Co-Authored-By: Claude Shannon <claude@example.com>'), false, 'human named Claude');
  assert.equal(hasAgentAttribution('Co-authored-by: Jane <jane@example.com>'), false);
  assert.equal(hasAgentAttribution('We discussed claude in the meeting'), false);
});

test('isAgentIdentity recognises structured commit authors', () => {
  assert.equal(isAgentIdentity('Claude', 'noreply@anthropic.com'), true);
  assert.equal(isAgentIdentity('Copilot', '198982749+Copilot@users.noreply.github.com'), true);
  assert.equal(isAgentIdentity('Claude Shannon', 'claude@example.com'), false);
  assert.equal(isAgentIdentity('Sholto', 'sholto@example.com'), false);
});

test('hasAgentOpenerDisclosure detects body disclosures and the agent-filed label', () => {
  assert.equal(hasAgentOpenerDisclosure("_Raised by Antigravity (an AI agent) at the maintainer's request._", []), true);
  assert.equal(hasAgentOpenerDisclosure('Filed by Claude Code (an AI agent).', []), true);
  assert.equal(hasAgentOpenerDisclosure('plain body', ['agent-filed']), true);
  assert.equal(hasAgentOpenerDisclosure('Raised by Dana', ['bug']), false);
});

test('extractClosingIssueNumbers finds same-repo closing references only', () => {
  assert.deepEqual(extractClosingIssueNumbers('Fixes #9\nFixes #7, closes other/repo#3 resolves: #12'), [7, 9, 12]);
  assert.deepEqual(extractClosingIssueNumbers('see #4'), []);
});

test('resolveClosureOrigin separates agent, human-directed agent-assisted, and human closures', () => {
  assert.equal(resolveClosureOrigin(true, []), 'agent');
  assert.equal(resolveClosureOrigin(false, ['human', 'agent']), 'agent');
  assert.equal(resolveClosureOrigin(false, ['assisted']), 'agent-assisted');
  assert.equal(resolveClosureOrigin(false, ['human']), 'human');
  assert.equal(resolveClosureOrigin(false, []), 'human');
});

test('computeIssueMetrics counts agent-assisted closures and agent-opened issues without double counting', () => {
  const m = computeIssueMetrics(
    [
      { state: 'closed', createdAt: '2026-11-01T00:00:00Z', closedAt: '2026-11-02T00:00:00Z', closedByAgent: true, fixReferenced: true },
      { state: 'closed', createdAt: '2026-11-01T00:00:00Z', closedAt: '2026-11-02T00:00:00Z', closedByAgent: false, closedAgentAssisted: true, openedByAgent: true, fixReferenced: true },
      { state: 'closed', createdAt: '2026-11-01T00:00:00Z', closedAt: '2026-11-02T00:00:00Z', closedByAgent: false, fixReferenced: false },
      { state: 'open', createdAt: '2026-11-01T00:00:00Z', closedAt: null, closedByAgent: false, openedByAgent: true, fixReferenced: false },
    ],
    Date.parse('2026-11-23T00:00:00Z')
  );
  assert.equal(m.closed, 3);
  assert.equal(m.closed_by_agent, 1);
  assert.equal(m.closed_agent_assisted, 1);
  assert.equal(m.closed_by_human, 1);
  assert.equal(m.closed_by_agent + m.closed_agent_assisted + m.closed_by_human, m.closed);
  assert.equal(m.opened_by_agent, 2);
  assert.equal(m.agent_resolution_share, 0.667);
});

function profile(): RepoProfile {
  return {
    repository: 'o/r', defaultBranch: 'main', ecosystems: [], languages: [], fileCount: 1,
    testFileCount: 0, hasLockfile: false, hasProofLock: false, proofLockValid: null,
    hasProofChangelog: false, proofChangelogValid: null, hasPreCommitHook: false,
    hasPrePushHook: false, hooksPathConfigured: false, hasCodeowners: false,
    codeownersProtectsProof: false, hasAgentsMd: false, agentsMdTopics: [], hasClaudeMd: false,
    hasSecurityPolicy: false, hasIssueForms: false, hasPrTemplate: false, hasDependabot: false,
    hasDependabotCooldown: false, hasCodeql: false, hasScorecard: false,
    hasDependencyReview: false, hasUpliftConfig: false, hasZeroRuntimeDeps: true,
    branchProtectionEnabled: null, workflows: [], ciPassRate: null, ciFailingNow: [],
    closedIssuesCount: null, linkedFixShare: null, agentAttributionCount: null, costConfigured: false,
  };
}

function client(routes: Readonly<Record<string, unknown>>): GitHubClient {
  const restWithStatus = async (endpoint: string): Promise<GitHubRestResponse> => {
    const key = Object.keys(routes).find((k) => endpoint.includes(k));
    return key ? { status: 200, ok: true, data: routes[key] } : { status: 404, ok: false, data: null };
  };
  return {
    restWithStatus,
    async rest(endpoint: string): Promise<unknown> {
      return (await restWithStatus(endpoint)).data;
    },
  };
}

const closed = (number: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  number,
  state: 'closed',
  created_at: '2026-11-20T00:00:00Z',
  closed_at: '2026-11-21T00:00:00Z',
  user: { login: 'sholtomaud' },
  labels: [],
  body: '',
  ...extra,
});

test('collector attributes human-directed closures via squash merges, commit authors, and opener disclosures', async () => {
  const telemetry = await collectGitHubTelemetry(
    client({
      '/issues': [
        closed(1, { body: '_Raised by Antigravity (an AI agent) at the maintainer request._' }), // closed by assisted squash PR
        closed(2, { labels: [{ name: 'agent-filed' }] }), // closed by agent-authored commit
        closed(3), // closed by human PR from a login that merely contains "claude"
        closed(4), // no linked work
      ],
      '/pulls': [
        {
          number: 10, state: 'closed', created_at: '2026-11-20T00:00:00Z', merged_at: '2026-11-20T02:00:00Z',
          user: { login: 'sholtomaud' }, title: 'fix: one', body: 'Fixes #1', merge_commit_sha: 'aaa',
        },
        {
          number: 11, state: 'closed', created_at: '2026-11-20T00:00:00Z', merged_at: '2026-11-20T02:00:00Z',
          user: { login: 'claudeshannon' }, title: 'fix: three', body: 'Fixes #3', merge_commit_sha: 'ccc',
        },
      ],
      '/commits': [
        // Squash merge commit of PR #10 keeps the trailer the PR body lacks.
        { sha: 'aaa', author: { login: 'sholtomaud' }, commit: { message: 'fix: one (#10)\n\nFixes #1\n\nCo-Authored-By: Claude <noreply@anthropic.com>', author: { name: 'Sholto', email: 's@example.com' } } },
        { sha: 'bbb', author: null, commit: { message: 'fix: two\n\nCloses #2', author: { name: 'Claude', email: 'noreply@anthropic.com' } } },
        { sha: 'ccc', author: { login: 'claudeshannon' }, commit: { message: 'fix: three (#11)\n\nFixes #3', author: { name: 'Claude Shannon', email: 'claude@example.com' } } },
      ],
      '/actions/runs': { workflow_runs: [] },
      '/releases': [],
    }),
    profile(),
    'o/r'
  );

  assert.equal(telemetry.issues.closed, 4);
  assert.equal(telemetry.issues.closed_by_agent, 1, 'issue #2 via agent-authored commit');
  assert.equal(telemetry.issues.closed_agent_assisted, 1, 'issue #1 via assisted squash merge');
  assert.equal(telemetry.issues.closed_by_human, 2, 'issues #3 and #4');
  assert.equal(telemetry.issues.opened_by_agent, 2, 'disclosure body + agent-filed label');
  assert.equal(telemetry.issues.fix_referenced, 3, 'linked closing work counts as a referenced fix');

  assert.equal(telemetry.pulls.merged_assisted_prs, 1, 'PR #10 assisted via squash commit trailer');
  assert.equal(telemetry.pulls.merged_agent_prs, 0, 'claudeshannon is a human');
  assert.equal(telemetry.pulls.merged_human_prs, 1);

  assert.equal(telemetry.attribution.basis, 'measured');
  assert.equal(telemetry.attribution.lower_bound, true);
  assert.equal(telemetry.attribution.commits_sampled, 3);
  assert.match(telemetry.attribution.caveat, /Lower bound/);
});
