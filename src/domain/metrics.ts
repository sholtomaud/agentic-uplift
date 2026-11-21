/**
 * Pure SRE observability & agent-attribution calculators.
 * Layer 1 (`src/domain/`): zero Node/DOM imports.
 */
import type {
  CiHealthMetrics,
  DeliveryMetrics,
  DoraBand,
  IssueMetrics,
  PullMetrics,
} from '../shared/status-types.ts';

const DEPENDENCY_BOTS = new Set([
  'dependabot[bot]',
  'renovate[bot]',
  'github-actions[bot]',
  'release-please[bot]',
]);

const KNOWN_AGENT_PATTERNS = [
  /copilot/i,
  /claude/i,
  /codex/i,
  /devin/i,
  /antigravity/i,
  /cursor/i,
  /sweep/i,
  /aider/i,
  /\[bot\]$/i,
];

const AGENT_TRAILER_PATTERN =
  /(?:co-authored-by|assisted-by)\s*:.*(?:claude|copilot|codex|devin|antigravity|cursor|anthropic|openai|gemini|bot)/i;

const AGENT_SIGNATURE_PATTERN =
  /generated (?:with|by)\s+(?:claude|copilot|codex|devin|antigravity|cursor)/i;

export function isAgentLogin(
  login: string,
  extraLogins: readonly string[] = []
): boolean {
  const normalized = login.trim().toLowerCase();
  if (!normalized || DEPENDENCY_BOTS.has(normalized)) return false;
  if (extraLogins.some((extra) => extra.trim().toLowerCase() === normalized)) {
    return true;
  }
  return KNOWN_AGENT_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function hasAgentAttribution(text: string): boolean {
  return AGENT_TRAILER_PATTERN.test(text) || AGENT_SIGNATURE_PATTERN.test(text);
}

export interface RawIssueSample {
  readonly state: 'open' | 'closed';
  readonly createdAt: string;
  readonly closedAt: string | null;
  readonly closedByAgent: boolean;
  readonly fixReferenced: boolean;
}

export interface RawPullSample {
  readonly state: 'open' | 'closed';
  readonly mergedAt: string | null;
  readonly createdAt: string;
  readonly authorLogin: string;
  readonly body: string;
}

export interface RawCiRunSample {
  readonly workflowName: string;
  readonly conclusion: string | null;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function computeIssueMetrics(
  issues: readonly RawIssueSample[],
  nowMs: number
): IssueMetrics {
  let open = 0;
  let closed = 0;
  let closedByAgent = 0;
  let closedByHuman = 0;
  let fixReferenced = 0;

  const sevenDaysAgo = nowMs - 7 * 24 * 60 * 60 * 1000;
  let opened7d = 0;
  let closed7d = 0;

  for (const issue of issues) {
    const createdMs = Date.parse(issue.createdAt);
    if (Number.isFinite(createdMs) && createdMs >= sevenDaysAgo) {
      opened7d += 1;
    }
    if (issue.state === 'open') {
      open += 1;
    } else {
      closed += 1;
      if (issue.closedByAgent) closedByAgent += 1;
      else closedByHuman += 1;
      if (issue.fixReferenced) fixReferenced += 1;
      if (issue.closedAt) {
        const closedMs = Date.parse(issue.closedAt);
        if (Number.isFinite(closedMs) && closedMs >= sevenDaysAgo) {
          closed7d += 1;
        }
      }
    }
  }

  const doomLoopRatio7d =
    closed7d > 0 ? Math.round((opened7d / closed7d) * 100) / 100 : null;
  const agentResolutionShare =
    closed > 0 ? Math.round((closedByAgent / closed) * 1000) / 1000 : null;

  return {
    open,
    closed,
    closed_by_agent: closedByAgent,
    closed_by_human: closedByHuman,
    fix_referenced: fixReferenced,
    doom_loop_ratio_7d: doomLoopRatio7d,
    agent_resolution_share: agentResolutionShare,
  };
}

export function computePullMetrics(
  pulls: readonly RawPullSample[],
  extraAgentLogins: readonly string[] = []
): PullMetrics {
  let open = 0;
  let merged = 0;
  let openAgentPrs = 0;
  let mergedAgentPrs = 0;
  let mergedAssistedPrs = 0;
  let mergedHumanPrs = 0;
  const mergeHours: number[] = [];

  for (const pr of pulls) {
    const byAgent = isAgentLogin(pr.authorLogin, extraAgentLogins);
    const assisted = !byAgent && hasAgentAttribution(pr.body);

    if (pr.state === 'open') {
      open += 1;
      if (byAgent || assisted) openAgentPrs += 1;
    } else if (pr.mergedAt) {
      merged += 1;
      if (byAgent) mergedAgentPrs += 1;
      else if (assisted) mergedAssistedPrs += 1;
      else mergedHumanPrs += 1;

      const createdMs = Date.parse(pr.createdAt);
      const mergedMs = Date.parse(pr.mergedAt);
      if (Number.isFinite(createdMs) && Number.isFinite(mergedMs)) {
        mergeHours.push(Math.max(0, (mergedMs - createdMs) / 3_600_000));
      }
    }
  }

  const med = median(mergeHours);
  return {
    open,
    merged,
    open_agent_prs: openAgentPrs,
    merged_agent_prs: mergedAgentPrs,
    merged_assisted_prs: mergedAssistedPrs,
    merged_human_prs: mergedHumanPrs,
    median_hours_to_merge: med === null ? null : Math.round(med * 10) / 10,
  };
}

export function computeCiHealth(runs: readonly RawCiRunSample[]): CiHealthMetrics {
  const completed = runs.filter((r) => r.conclusion !== null);
  const passing = completed.filter(
    (r) => r.conclusion === 'success' || r.conclusion === 'neutral'
  );
  const latestByWorkflow = new Map<string, string>();
  for (const run of completed) {
    if (!latestByWorkflow.has(run.workflowName) && run.conclusion !== null) {
      latestByWorkflow.set(run.workflowName, run.conclusion);
    }
  }
  const failingWorkflows = [...latestByWorkflow.entries()]
    .filter(([, conclusion]) => conclusion !== 'success' && conclusion !== 'neutral')
    .map(([name]) => name)
    .sort();

  return {
    total_runs: completed.length,
    passing_runs: passing.length,
    pass_rate:
      completed.length > 0
        ? Math.round((passing.length / completed.length) * 1000) / 1000
        : null,
    failing_workflows: failingWorkflows,
  };
}

export function bandDeploymentFrequency(releases30d: number): DoraBand {
  if (releases30d <= 0) return 'insufficient';
  if (releases30d >= 30) return 'elite';
  if (releases30d >= 4) return 'high';
  if (releases30d >= 1) return 'medium';
  return 'low';
}

export function bandLeadTime(hours: number | null): DoraBand {
  if (hours === null) return 'insufficient';
  if (hours <= 24) return 'elite';
  if (hours <= 168) return 'high';
  if (hours <= 720) return 'medium';
  return 'low';
}

export function computeDeliveryMetrics(
  releases30d: number,
  medianLeadTimeHours: number | null
): DeliveryMetrics {
  return {
    releases_30d: releases30d,
    deployment_frequency_band: bandDeploymentFrequency(releases30d),
    median_lead_time_hours: medianLeadTimeHours,
    lead_time_band: bandLeadTime(medianLeadTimeHours),
  };
}
