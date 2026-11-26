/**
 * Online GitHub telemetry collector: enriches local RepoProfile with live
 * issues, pull requests, CI runs, releases, and branch protection status.
 * Layer 3 (`src/adapters/`).
 */
import {
  computeCiHealth,
  computeDeliveryMetrics,
  computeIssueMetrics,
  computePullMetrics,
  extractClosingIssueNumbers,
  hasAgentAttribution,
  hasAgentOpenerDisclosure,
  isAgentIdentity,
  isAgentLogin,
  resolveClosureOrigin,
  type RawCiRunSample,
  type RawIssueSample,
  type RawPullSample,
} from '../domain/metrics.ts';
import type { RepoProfile } from '../shared/audit-types.ts';
import { isRecord } from '../shared/contracts.ts';
import type { GateIssue, GatePr } from '../shared/gate-types.ts';
import type {
  AttributionCoverage,
  CiHealthMetrics,
  DeliveryMetrics,
  IssueMetrics,
  PullMetrics,
} from '../shared/status-types.ts';
import type { GitHubClient } from './github-client.ts';

/** Merged PR facts reused by the economics collector (no PR text leaves the adapter layer). */
export interface MergedPullRecord {
  readonly number: number;
  readonly origin: WorkOrigin;
  readonly title: string;
  /** PR body plus squash/merge commit message (for usage lines and trailers). */
  readonly text: string;
  readonly createdAt: string;
  readonly mergedAt: string;
  readonly closes: readonly number[];
}

/** Closed issue facts reused by the economics collector. */
export interface ClosedIssueRecord {
  readonly number: number;
  readonly labels: readonly string[];
  readonly createdAt: string;
  readonly closedAt: string;
  readonly stateReason: string;
  readonly origin: 'agent' | 'agent-assisted' | 'human';
}

export interface GitHubTelemetry {
  readonly mergedPulls: readonly MergedPullRecord[];
  readonly closedIssues: readonly ClosedIssueRecord[];
  readonly profile: RepoProfile;
  readonly issues: IssueMetrics;
  readonly pulls: PullMetrics;
  readonly attribution: AttributionCoverage;
  readonly ci: CiHealthMetrics;
  readonly delivery: DeliveryMetrics;
  readonly openGateIssues: readonly GateIssue[];
  readonly openGatePrs: readonly GatePr[];
}

function readString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  return typeof value === 'string' ? value : '';
}

function readNumber(obj: Record<string, unknown>, key: string): number {
  const value = obj[key];
  return typeof value === 'number' ? value : 0;
}

function readLogin(obj: Record<string, unknown>, key: string): string {
  const nested = obj[key];
  return isRecord(nested) ? readString(nested, 'login') : '';
}

function readLabels(obj: Record<string, unknown>): string[] {
  const raw = obj.labels;
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string') names.push(item);
    else if (isRecord(item) && typeof item.name === 'string') {
      names.push(item.name);
    }
  }
  return names;
}

export type WorkOrigin = 'agent' | 'assisted' | 'human';

const ATTRIBUTION_CAVEAT =
  'Lower bound: only the most recent 100 issues, pull requests, and default-branch commits are sampled, and agent work without an agent account, attribution trailer, commit author, or opener disclosure is counted as human. All figures are measured from GitHub records, not modeled.';

function addClosingWork(
  target: Map<number, WorkOrigin[]>,
  text: string,
  origin: WorkOrigin
): void {
  for (const num of extractClosingIssueNumbers(text)) {
    const list = target.get(num) ?? [];
    list.push(origin);
    target.set(num, list);
  }
}

/** Rule types that make a ruleset count as branch protection for the audit. */
const PROTECTING_RULE_TYPES: ReadonlySet<string> = new Set([
  'pull_request',
  'required_status_checks',
]);

/** True when `/rules/branches/{b}` lists a PR or required-status-check rule. */
export function rulesetProtects(rules: unknown): boolean {
  if (!Array.isArray(rules)) return false;
  return rules.some(
    (rule) => isRecord(rule) && PROTECTING_RULE_TYPES.has(readString(rule, 'type'))
  );
}

export async function collectGitHubTelemetry(
  client: GitHubClient,
  baseProfile: RepoProfile,
  repository: string,
  extraAgentLogins: readonly string[] = [],
  now = new Date()
): Promise<GitHubTelemetry> {
  const [rawIssues, rawPulls, rawRuns, rawReleases, protectionRes, rawCommits, rulesRes] =
    await Promise.all([
      client.rest(`/repos/${repository}/issues?state=all&per_page=100`),
      client.rest(`/repos/${repository}/pulls?state=all&per_page=100`),
      client.rest(
        `/repos/${repository}/actions/runs?branch=${encodeURIComponent(baseProfile.defaultBranch)}&per_page=50`
      ),
      client.rest(`/repos/${repository}/releases?per_page=30`),
      client.restWithStatus(
        `/repos/${repository}/branches/${encodeURIComponent(baseProfile.defaultBranch)}/protection`
      ),
      client.rest(
        `/repos/${repository}/commits?sha=${encodeURIComponent(baseProfile.defaultBranch)}&per_page=100`
      ),
      // Rulesets are invisible to the legacy endpoint above (it answers 404
      // for a ruleset-only branch); this one lists active ruleset rules and
      // is readable with the default GITHUB_TOKEN.
      client.restWithStatus(
        `/repos/${repository}/rules/branches/${encodeURIComponent(baseProfile.defaultBranch)}`
      ),
    ]);

  // Default-branch commits: structured authors, trailers, and squash messages.
  const closingWork = new Map<number, WorkOrigin[]>();
  const commitMessageBySha = new Map<string, string>();
  let commitsSampled = 0;
  if (Array.isArray(rawCommits)) {
    for (const item of rawCommits) {
      if (!isRecord(item) || !isRecord(item.commit)) continue;
      commitsSampled += 1;
      const message = readString(item.commit, 'message');
      const author = isRecord(item.commit.author) ? item.commit.author : {};
      const origin: WorkOrigin =
        isAgentIdentity(readString(author, 'name'), readString(author, 'email')) ||
        isAgentLogin(readLogin(item, 'author'), extraAgentLogins)
          ? 'agent'
          : hasAgentAttribution(message)
            ? 'assisted'
            : 'human';
      commitMessageBySha.set(readString(item, 'sha'), message);
      addClosingWork(closingWork, message, origin);
    }
  }

  const pullSamples: RawPullSample[] = [];
  const openGatePrs: GatePr[] = [];
  const mergedPulls: MergedPullRecord[] = [];
  if (Array.isArray(rawPulls)) {
    for (const item of rawPulls) {
      if (!isRecord(item)) continue;
      const state = item.state === 'open' ? 'open' : 'closed';
      const authorLogin = readLogin(item, 'user');
      const title = readString(item, 'title');
      const mergedAt = typeof item.merged_at === 'string' ? item.merged_at : null;
      const mergeMessage = mergedAt
        ? (commitMessageBySha.get(readString(item, 'merge_commit_sha')) ?? '')
        : '';
      // Squash merges can drop per-commit trailers: check the PR body AND the merge commit.
      const body = `${readString(item, 'body')}${mergeMessage ? `\n\n${mergeMessage}` : ''}`;
      if (mergedAt) {
        const origin: WorkOrigin = isAgentLogin(authorLogin, extraAgentLogins)
          ? 'agent'
          : hasAgentAttribution(body)
            ? 'assisted'
            : 'human';
        addClosingWork(closingWork, `${title}\n${body}`, origin);
        mergedPulls.push({
          number: readNumber(item, 'number'),
          origin,
          title,
          text: body,
          createdAt: readString(item, 'created_at'),
          mergedAt,
          closes: extractClosingIssueNumbers(`${title}\n${body}`),
        });
      }
      pullSamples.push({
        state,
        createdAt: readString(item, 'created_at'),
        mergedAt,
        authorLogin,
        body,
      });
      if (state === 'open') {
        openGatePrs.push({
          number: readNumber(item, 'number'),
          title,
          body,
          isAgent:
            isAgentLogin(authorLogin, extraAgentLogins) ||
            hasAgentAttribution(body),
        });
      }
    }
  }

  const issueSamples: RawIssueSample[] = [];
  const openGateIssues: GateIssue[] = [];
  const closedIssues: ClosedIssueRecord[] = [];
  if (Array.isArray(rawIssues)) {
    for (const item of rawIssues) {
      if (!isRecord(item) || 'pull_request' in item) continue;
      const state = item.state === 'closed' ? 'closed' : 'open';
      const createdAt = readString(item, 'created_at');
      const closedAt =
        typeof item.closed_at === 'string' ? item.closed_at : null;
      const closedByLogin = readLogin(item, 'closed_by');
      const body = readString(item, 'body');
      const labels = readLabels(item);
      const work = closingWork.get(readNumber(item, 'number')) ?? [];
      const origin =
        state === 'closed'
          ? resolveClosureOrigin(isAgentLogin(closedByLogin, extraAgentLogins), work)
          : 'human';
      issueSamples.push({
        state,
        createdAt,
        closedAt,
        closedByAgent: origin === 'agent',
        closedAgentAssisted: origin === 'agent-assisted',
        openedByAgent:
          isAgentLogin(readLogin(item, 'user'), extraAgentLogins) ||
          hasAgentOpenerDisclosure(body, labels),
        fixReferenced:
          work.length > 0 ||
          /\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s+#\d+/i.test(body),
      });
      if (state === 'closed' && closedAt) {
        closedIssues.push({
          number: readNumber(item, 'number'),
          labels,
          createdAt,
          closedAt,
          stateReason: readString(item, 'state_reason'),
          origin,
        });
      }
      if (state === 'open') {
        openGateIssues.push({
          number: readNumber(item, 'number'),
          title: readString(item, 'title'),
          labels,
          createdAt,
        });
      }
    }
  }

  const ciSamples: RawCiRunSample[] = [];
  if (isRecord(rawRuns) && Array.isArray(rawRuns.workflow_runs)) {
    for (const run of rawRuns.workflow_runs) {
      if (!isRecord(run)) continue;
      ciSamples.push({
        workflowName: readString(run, 'name') || 'workflow',
        conclusion:
          typeof run.conclusion === 'string' ? run.conclusion : null,
      });
    }
  }

  const thirtyDaysAgo = now.getTime() - 30 * 24 * 60 * 60 * 1000;
  let releases30d = 0;
  if (Array.isArray(rawReleases)) {
    for (const rel of rawReleases) {
      if (!isRecord(rel)) continue;
      const ts = Date.parse(readString(rel, 'published_at'));
      if (Number.isFinite(ts) && ts >= thirtyDaysAgo) {
        releases30d += 1;
      }
    }
  }

  const issues = computeIssueMetrics(issueSamples, now.getTime());
  const pulls = computePullMetrics(pullSamples, extraAgentLogins);
  const ci = computeCiHealth(ciSamples);
  const delivery = computeDeliveryMetrics(
    releases30d,
    pulls.median_hours_to_merge
  );

  // HTTP 200 -> protected, HTTP 404 -> unprotected, HTTP 403 -> token lacks administration:read (waiting)
  const branchProtectionEnabled =
    protectionRes.ok || rulesetProtects(rulesRes.ok ? rulesRes.data : null)
      ? true
      : protectionRes.status === 404
        ? false
        : null;

  const hasActivity = pulls.merged + issues.closed > 0;
  const agentAttributionCount = hasActivity
    ? pulls.merged_agent_prs +
      pulls.merged_assisted_prs +
      issues.closed_by_agent +
      issues.closed_agent_assisted
    : null;

  const attribution: AttributionCoverage = {
    basis: 'measured',
    lower_bound: true,
    sources: [
      'issues: author login, agent-filed label, opener disclosure',
      'pull requests: author login, body trailers, squash merge commit',
      'commits: structured author, Co-Authored-By/Assisted-by/Generated-by trailers, closing references',
    ],
    issues_sampled: issueSamples.length,
    pulls_sampled: pullSamples.length,
    commits_sampled: commitsSampled,
    caveat: ATTRIBUTION_CAVEAT,
  };

  const enrichedProfile: RepoProfile = {
    ...baseProfile,
    repository,
    branchProtectionEnabled,
    ciPassRate: ci.pass_rate,
    ciFailingNow: ci.failing_workflows,
    closedIssuesCount: issues.closed,
    linkedFixShare:
      issues.closed > 0 ? issues.fix_referenced / issues.closed : null,
    agentAttributionCount,
  };

  return {
    mergedPulls,
    closedIssues,
    profile: enrichedProfile,
    issues,
    pulls,
    attribution,
    ci,
    delivery,
    openGateIssues,
    openGatePrs,
  };
}
