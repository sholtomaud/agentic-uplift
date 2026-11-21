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
  hasAgentAttribution,
  isAgentLogin,
  type RawCiRunSample,
  type RawIssueSample,
  type RawPullSample,
} from '../domain/metrics.ts';
import type { RepoProfile } from '../shared/audit-types.ts';
import { isRecord } from '../shared/contracts.ts';
import type { GateIssue, GatePr } from '../shared/gate-types.ts';
import type {
  CiHealthMetrics,
  DeliveryMetrics,
  IssueMetrics,
  PullMetrics,
} from '../shared/status-types.ts';
import type { GitHubClient } from './github-client.ts';

export interface GitHubTelemetry {
  readonly profile: RepoProfile;
  readonly issues: IssueMetrics;
  readonly pulls: PullMetrics;
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

export async function collectGitHubTelemetry(
  client: GitHubClient,
  baseProfile: RepoProfile,
  repository: string,
  extraAgentLogins: readonly string[] = [],
  now = new Date()
): Promise<GitHubTelemetry> {
  const [rawIssues, rawPulls, rawRuns, rawReleases, protectionRes] =
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
    ]);

  const issueSamples: RawIssueSample[] = [];
  const openGateIssues: GateIssue[] = [];
  if (Array.isArray(rawIssues)) {
    for (const item of rawIssues) {
      if (!isRecord(item) || 'pull_request' in item) continue;
      const state = item.state === 'closed' ? 'closed' : 'open';
      const createdAt = readString(item, 'created_at');
      const closedAt =
        typeof item.closed_at === 'string' ? item.closed_at : null;
      const closedByLogin = readLogin(item, 'closed_by');
      const body = readString(item, 'body');
      issueSamples.push({
        state,
        createdAt,
        closedAt,
        closedByAgent: isAgentLogin(closedByLogin, extraAgentLogins),
        fixReferenced: /\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s+#\d+/i.test(
          body
        ),
      });
      if (state === 'open') {
        openGateIssues.push({
          number: readNumber(item, 'number'),
          title: readString(item, 'title'),
          labels: readLabels(item),
          createdAt,
        });
      }
    }
  }

  const pullSamples: RawPullSample[] = [];
  const openGatePrs: GatePr[] = [];
  if (Array.isArray(rawPulls)) {
    for (const item of rawPulls) {
      if (!isRecord(item)) continue;
      const state = item.state === 'open' ? 'open' : 'closed';
      const authorLogin = readLogin(item, 'user');
      const body = readString(item, 'body');
      const title = readString(item, 'title');
      pullSamples.push({
        state,
        createdAt: readString(item, 'created_at'),
        mergedAt: typeof item.merged_at === 'string' ? item.merged_at : null,
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
  const branchProtectionEnabled = protectionRes.ok
    ? true
    : protectionRes.status === 404
      ? false
      : null;

  const hasActivity = pulls.merged + issues.closed > 0;
  const agentAttributionCount = hasActivity
    ? pulls.merged_agent_prs +
      pulls.merged_assisted_prs +
      issues.closed_by_agent
    : null;

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
    profile: enrichedProfile,
    issues,
    pulls,
    ci,
    delivery,
    openGateIssues,
    openGatePrs,
  };
}
