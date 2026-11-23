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

/**
 * Agent names matched as whole login / trailer tokens (never as substrings),
 * so human logins such as `claudeshannon` are not counted as agents.
 */
const AGENT_NAME_TOKENS = new Set([
  'copilot',
  'claude',
  'anthropic',
  'codex',
  'openai',
  'devin',
  'antigravity',
  'gemini',
  'jules',
  'cursor',
  'sweep',
  'aider',
  'amp',
  'roo',
  'roocode',
  'openhands',
  'codegen',
  'windsurf',
]);

/** Multi-token agent names, matched as consecutive tokens. */
const AGENT_NAME_PHRASES: readonly (readonly string[])[] = [
  ['roo', 'code'],
  ['open', 'hands'],
  ['claude', 'code'],
];

/** Commit-author / trailer emails that only coding agents use. */
const AGENT_EMAIL_PATTERN =
  /(?:@anthropic\.com|@openai\.com|@cursor\.(?:com|sh)|@devin\.ai|@cognition(?:-labs)?\.(?:ai|com)|\[bot\]@users\.noreply\.github\.com|\b(?:\d+\+)?(?:copilot|claude|devin|jules|antigravity|cursoragent|gemini-code-assist)[\w.-]*@users\.noreply\.github\.com)/i;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/** True when `text` contains a known agent name as a whole token or phrase. */
export function mentionsAgentName(text: string): boolean {
  const tokens = tokenize(text);
  if (tokens.some((t) => AGENT_NAME_TOKENS.has(t))) return true;
  return AGENT_NAME_PHRASES.some((phrase) =>
    tokens.some((_, i) => phrase.every((p, j) => tokens[i + j] === p))
  );
}

const TRAILER_PATTERN =
  /^\s*(?:co-authored-by|assisted-by|generated-by)\s*:\s*(.+)$/gim;

const AGENT_SIGNATURE_PATTERN =
  /\b(?:generated|created|written|authored)\s+(?:with|by|using)\s+\[?([^\]\n(]{1,40})/gi;

/** Opener disclosure such as `_Raised by Antigravity (an AI agent)._` */
const OPENER_DISCLOSURE_PATTERN = /(?<![a-z])(?:raised|filed|opened|reported)\s+by\s+[^\n]{1,60}?\(an\s+ai\s+agent\)/i;

export const AGENT_FILED_LABEL = 'agent-filed';

export function isAgentLogin(
  login: string,
  extraLogins: readonly string[] = []
): boolean {
  const normalized = login.trim().toLowerCase();
  if (!normalized || DEPENDENCY_BOTS.has(normalized)) return false;
  if (extraLogins.some((extra) => extra.trim().toLowerCase() === normalized)) {
    return true;
  }
  if (/\[bot\]$/.test(normalized)) return true;
  return mentionsAgentName(normalized);
}

/**
 * True when a person-shaped identity (`Name <email>`) is a coding agent:
 * an agent-only email, or an agent name with no email / a GitHub noreply
 * email. `Claude Shannon <claude@example.com>` is a human.
 */
export function isAgentIdentity(name: string, email: string): boolean {
  if (AGENT_EMAIL_PATTERN.test(email)) return true;
  const normalized = name.trim().toLowerCase();
  if (!normalized || DEPENDENCY_BOTS.has(normalized)) return false;
  if (/\[bot\]$/.test(normalized)) return true;
  const emailOk = email.trim() === '' || /@users\.noreply\.github\.com$/i.test(email.trim());
  return emailOk && mentionsAgentName(normalized);
}

function parseIdentity(value: string): { name: string; email: string } {
  const match = value.match(/^\s*(.*?)\s*<([^>]*)>\s*$/);
  return match ? { name: match[1], email: match[2] } : { name: value.trim(), email: '' };
}

/** Co-Authored-By / Assisted-by / Generated-by trailers or "Generated with <agent>" signatures. */
export function hasAgentAttribution(text: string): boolean {
  for (const match of text.matchAll(TRAILER_PATTERN)) {
    const { name, email } = parseIdentity(match[1]);
    if (isAgentIdentity(name, email)) return true;
  }
  for (const match of text.matchAll(AGENT_SIGNATURE_PATTERN)) {
    if (mentionsAgentName(match[1])) return true;
  }
  return false;
}

/** Issue opened under a human account but disclosed as agent-filed (body disclosure or label). */
export function hasAgentOpenerDisclosure(
  body: string,
  labels: readonly string[]
): boolean {
  return (
    labels.some((l) => l.trim().toLowerCase() === AGENT_FILED_LABEL) ||
    OPENER_DISCLOSURE_PATTERN.test(body)
  );
}

/** Issue numbers a PR body or commit message closes (`Fixes #12`, `closes #3, resolves #4`). */
export function extractClosingIssueNumbers(text: string): number[] {
  const found = new Set<number>();
  for (const match of text.matchAll(
    /\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s*:?\s+((?:[\w.-]+\/[\w.-]+)?#\d+)/gi
  )) {
    if (match[1].includes('/')) continue; // cross-repository reference
    found.add(Number(match[1].slice(1)));
  }
  return [...found].sort((a, b) => a - b);
}

/** How a closed issue's resolution is attributed. */
export type ClosureOrigin = 'agent' | 'agent-assisted' | 'human';

/**
 * Resolves closure origin: an agent closer or a merged agent-authored
 * PR/commit is `agent`; a human closer whose closing PR/commit carries agent
 * trailers is `agent-assisted` (human-directed agent work); otherwise `human`.
 */
export function resolveClosureOrigin(
  closedByAgentLogin: boolean,
  closingWork: readonly ('agent' | 'assisted' | 'human')[]
): ClosureOrigin {
  if (closedByAgentLogin || closingWork.includes('agent')) return 'agent';
  if (closingWork.includes('assisted')) return 'agent-assisted';
  return 'human';
}

export interface RawIssueSample {
  readonly state: 'open' | 'closed';
  readonly createdAt: string;
  readonly closedAt: string | null;
  /** Closed directly by an agent, or via merged agent-authored work. */
  readonly closedByAgent: boolean;
  /** Human closer, but the closing PR/commit carries agent attribution. */
  readonly closedAgentAssisted?: boolean;
  /** Opened by an agent account or disclosed as agent-filed. */
  readonly openedByAgent?: boolean;
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
  let closedAgentAssisted = 0;
  let openedByAgent = 0;
  let fixReferenced = 0;

  const sevenDaysAgo = nowMs - 7 * 24 * 60 * 60 * 1000;
  let opened7d = 0;
  let closed7d = 0;

  for (const issue of issues) {
    const createdMs = Date.parse(issue.createdAt);
    if (Number.isFinite(createdMs) && createdMs >= sevenDaysAgo) {
      opened7d += 1;
    }
    if (issue.openedByAgent === true) openedByAgent += 1;
    if (issue.state === 'open') {
      open += 1;
    } else {
      closed += 1;
      if (issue.closedByAgent) closedByAgent += 1;
      else if (issue.closedAgentAssisted === true) closedAgentAssisted += 1;
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
    closed > 0
      ? Math.round(((closedByAgent + closedAgentAssisted) / closed) * 1000) / 1000
      : null;

  return {
    open,
    closed,
    closed_by_agent: closedByAgent,
    closed_by_human: closedByHuman,
    closed_agent_assisted: closedAgentAssisted,
    opened_by_agent: openedByAgent,
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
