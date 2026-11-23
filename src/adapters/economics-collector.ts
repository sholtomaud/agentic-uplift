/**
 * Collects measured people-vs-agents samples from GitHub REST for the
 * economics report: review rounds, reverts, reopens, PR CI minutes, CI green
 * on first push, test-file changes, and agent-reported token usage.
 * Only counts, timestamps and booleans leave this module, never issue text.
 * Layer 3 (`src/adapters/`).
 */
import { classifyIssue, isConventionalTitle, parseReportedUsage } from '../domain/economics.ts';
import { hasAgentAttribution } from '../domain/metrics.ts';
import { isRecord } from '../shared/contracts.ts';
import type {
  PullComplianceSample,
  ResolvedIssueSample,
} from '../shared/economics-types.ts';
import type { GitHubClient } from './github-client.ts';
import type { ClosedIssueRecord, MergedPullRecord } from './github-collector.ts';

/** Per-PR detail calls (reviews, files) are capped to bound API usage. */
export const MAX_DETAILED_PULLS = 30;

export interface EconomicsSamples {
  readonly issues: readonly ResolvedIssueSample[];
  readonly pulls: readonly PullComplianceSample[];
  readonly windowDays: number;
}

interface RunInfo {
  readonly headSha: string;
  readonly startedMs: number;
  readonly minutes: number;
  readonly success: boolean;
}

function str(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === 'string' ? v : '';
}

function hoursBetween(from: string, to: string): number | null {
  const a = Date.parse(from);
  const b = Date.parse(to);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, (b - a) / 3_600_000) : null;
}

const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|spec|e2e)\/|[._-](?:test|spec)\.[a-z]+$|_test\.(?:go|py|rs)$/i;

/** Reverted PR numbers from `Revert "…"` PRs (`Reverts owner/repo#12` / `Reverts #12`). */
export function revertedPullNumbers(pulls: readonly MergedPullRecord[]): Set<number> {
  const reverted = new Set<number>();
  for (const pr of pulls) {
    if (!/^revert\b/i.test(pr.title)) continue;
    for (const m of pr.text.matchAll(/\breverts?\s+(?:[\w.-]+\/[\w.-]+)?#(\d+)/gi)) {
      reverted.add(Number(m[1]));
    }
  }
  return reverted;
}

export async function collectEconomicsSamples(
  client: GitHubClient,
  repository: string,
  mergedPulls: readonly MergedPullRecord[],
  closedIssues: readonly ClosedIssueRecord[]
): Promise<EconomicsSamples> {
  const [rawPrRuns, rawEvents] = await Promise.all([
    client.rest(`/repos/${repository}/actions/runs?event=pull_request&per_page=100`),
    client.rest(`/repos/${repository}/issues/events?per_page=100`),
  ]);

  const runsByPr = new Map<number, RunInfo[]>();
  if (isRecord(rawPrRuns) && Array.isArray(rawPrRuns.workflow_runs)) {
    for (const run of rawPrRuns.workflow_runs) {
      if (!isRecord(run) || !Array.isArray(run.pull_requests)) continue;
      const started = Date.parse(str(run, 'run_started_at') || str(run, 'created_at'));
      const updated = Date.parse(str(run, 'updated_at'));
      const minutes =
        Number.isFinite(started) && Number.isFinite(updated) ? Math.max(0, (updated - started) / 60_000) : 0;
      const info: RunInfo = {
        headSha: str(run, 'head_sha'),
        startedMs: Number.isFinite(started) ? started : 0,
        minutes,
        success: run.conclusion === 'success' || run.conclusion === 'skipped' || run.conclusion === 'neutral',
      };
      for (const pr of run.pull_requests) {
        if (!isRecord(pr) || typeof pr.number !== 'number') continue;
        const list = runsByPr.get(pr.number) ?? [];
        list.push(info);
        runsByPr.set(pr.number, list);
      }
    }
  }

  const reopened = new Set<number>();
  if (Array.isArray(rawEvents)) {
    for (const ev of rawEvents) {
      if (!isRecord(ev) || ev.event !== 'reopened' || !isRecord(ev.issue)) continue;
      if (typeof ev.issue.number === 'number') reopened.add(ev.issue.number);
    }
  }

  const reverted = revertedPullNumbers(mergedPulls);
  const detailed = [...mergedPulls]
    .sort((a, b) => b.mergedAt.localeCompare(a.mergedAt))
    .slice(0, MAX_DETAILED_PULLS);

  const details = new Map<number, { reviews: number; touchesTests: boolean | null }>();
  await Promise.all(
    detailed.map(async (pr) => {
      const [rawReviews, rawFiles] = await Promise.all([
        client.rest(`/repos/${repository}/pulls/${pr.number}/reviews?per_page=100`),
        client.rest(`/repos/${repository}/pulls/${pr.number}/files?per_page=100`),
      ]);
      const reviews = Array.isArray(rawReviews)
        ? rawReviews.filter(
            (r) => isRecord(r) && (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED' || r.state === 'COMMENTED')
          ).length
        : 0;
      const files = Array.isArray(rawFiles)
        ? rawFiles.flatMap((f) => (isRecord(f) && typeof f.filename === 'string' ? [f.filename] : []))
        : [];
      details.set(pr.number, {
        reviews,
        touchesTests: Array.isArray(rawFiles) && files.length > 0 ? files.some((f) => TEST_PATH.test(f)) : null,
      });
    })
  );

  const ciOf = (pr: number): { minutes: number; greenFirst: boolean | null } => {
    const runs = runsByPr.get(pr) ?? [];
    if (runs.length === 0) return { minutes: 0, greenFirst: null };
    const minutes = runs.reduce((sum, r) => sum + r.minutes, 0);
    const first = runs.reduce((a, b) => (b.startedMs < a.startedMs ? b : a));
    const firstPush = runs.filter((r) => r.headSha === first.headSha);
    return { minutes: Math.round(minutes * 10) / 10, greenFirst: firstPush.every((r) => r.success) };
  };

  const pullByIssue = new Map<number, MergedPullRecord[]>();
  for (const pr of mergedPulls) {
    for (const n of pr.closes) {
      const list = pullByIssue.get(n) ?? [];
      list.push(pr);
      pullByIssue.set(n, list);
    }
  }

  const issues: ResolvedIssueSample[] = [];
  let oldest = Number.POSITIVE_INFINITY;
  let newest = 0;
  for (const issue of closedIssues) {
    if (issue.stateReason === 'not_planned' || issue.stateReason === 'duplicate') continue;
    const prs = pullByIssue.get(issue.number) ?? [];
    const firstPr = prs.reduce<MergedPullRecord | null>(
      (a, b) => (a === null || b.createdAt < a.createdAt ? b : a),
      null
    );
    const usage = prs.map((p) => parseReportedUsage(p.text)).find((u) => u !== null) ?? null;
    const ci = prs.reduce((sum, p) => sum + ciOf(p.number).minutes, 0);
    const closedMs = Date.parse(issue.closedAt);
    if (Number.isFinite(closedMs)) {
      oldest = Math.min(oldest, closedMs);
      newest = Math.max(newest, closedMs);
    }
    issues.push({
      number: issue.number,
      issue_class: classifyIssue(issue.labels),
      origin: issue.origin === 'human' ? 'human' : 'agent',
      opened_at: issue.createdAt,
      closed_at: issue.closedAt,
      hours_to_first_pr: firstPr ? hoursBetween(issue.createdAt, firstPr.createdAt) : null,
      hours_to_merge: firstPr ? hoursBetween(firstPr.createdAt, firstPr.mergedAt) : null,
      review_rounds: prs.reduce((sum, p) => sum + (details.get(p.number)?.reviews ?? 0), 0),
      reverted: prs.some((p) => reverted.has(p.number)),
      reopened: reopened.has(issue.number),
      linked_fix: prs.length > 0,
      ci_minutes: Math.round(ci * 10) / 10,
      agent_run_minutes: usage?.run_minutes ?? null,
      reported_usage: usage
        ? {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cache_read_tokens: usage.cache_read_tokens,
            model: usage.model,
          }
        : null,
    });
  }

  const pulls: PullComplianceSample[] = mergedPulls.map((pr) => {
    const ci = ciOf(pr.number);
    return {
      origin: pr.origin === 'human' ? 'human' : 'agent',
      conventional_title: isConventionalTitle(pr.title),
      links_issue: pr.closes.length > 0,
      // Agent-account PRs must still carry a Co-Authored-By / Assisted-by trailer.
      attributed: pr.origin === 'assisted' || hasAgentAttribution(pr.text),
      touches_tests: details.get(pr.number)?.touchesTests ?? null,
      ci_green_first_push: ci.greenFirst,
    };
  });

  const windowDays =
    Number.isFinite(oldest) && newest > 0 ? Math.max(1, Math.ceil((newest - oldest) / 86_400_000)) : 0;
  return { issues, pulls, windowDays };
}
