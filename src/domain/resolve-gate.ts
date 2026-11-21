/**
 * Proof-Aware Autonomous Resolution Circuit Breaker.
 * Layer 1 (`src/domain/`): pure decision state machine + formal invariant checker.
 */
import type {
  GateIssue,
  GatePr,
  ResolveGateDecision,
  ResolveGateInput,
} from '../shared/gate-types.ts';

const CLOSING_LINK = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi;

/** Issue numbers already linked to an open pull request via a closing keyword. */
export function claimedIssues(openPrs: readonly GatePr[]): Set<number> {
  const claimed = new Set<number>();
  for (const pr of openPrs) {
    const text = `${pr.title}\n${pr.body}`;
    for (const match of text.matchAll(CLOSING_LINK)) {
      claimed.add(Number(match[1]));
    }
  }
  return claimed;
}

function hasLabel(issue: GateIssue, name: string): boolean {
  return issue.labels.some((label) => label.toLowerCase() === name);
}

export function isEligibleIssue(issue: GateIssue): boolean {
  return (
    hasLabel(issue, 'agentic-uplift') ||
    hasLabel(issue, 'repo-sre-audit') ||
    hasLabel(issue, 'agent-ready')
  );
}

export function isRecoveryIssue(issue: GateIssue): boolean {
  return (
    hasLabel(issue, 'incident') ||
    hasLabel(issue, 'security') ||
    ((hasLabel(issue, 'agentic-uplift') || hasLabel(issue, 'repo-sre-audit')) &&
      /\b(?:ci|proof)\b/i.test(issue.title))
  );
}

function priorityTier(issue: GateIssue): number {
  if (hasLabel(issue, 'security') || hasLabel(issue, 'incident')) return 0;
  if (hasLabel(issue, 'agentic-uplift') || hasLabel(issue, 'repo-sre-audit'))
    return 1;
  if (hasLabel(issue, 'bug')) return 2;
  return 3;
}

/**
 * Evaluates all safety circuit breakers and selects at most one issue for an
 * autonomous agent to work on.
 *
 * Hard gates (in strict order):
 *   1. Cryptographic proof seal must be intact when `requireProofSeal` is enabled.
 *   2. Open agent PR count must stay strictly below `maxOpenAgentPrs`.
 *   3. Monthly agentic spend must stay strictly below `agenticMonthlyBudget`.
 *   4. Default-branch CI must be green (except for incident/security/CI recovery issues).
 */
export function evaluateResolveGate(
  input: ResolveGateInput
): ResolveGateDecision {
  if (input.requireProofSeal && !input.proofSealOk) {
    return {
      proceed: false,
      reason: 'proof-seal-broken',
      message:
        'Paused: cryptographic proof-lock seal is missing or tampered. Autonomous edits are blocked until a maintainer restores integrity.',
      issue: null,
    };
  }

  const openAgentPrs = input.openPrs.filter((pr) => pr.isAgent).length;
  if (openAgentPrs >= input.maxOpenAgentPrs) {
    return {
      proceed: false,
      reason: 'open-agent-pr-cap',
      message: `Paused: ${openAgentPrs} open agent PR(s) reached cap of ${input.maxOpenAgentPrs}.`,
      issue: null,
    };
  }

  if (
    input.agenticMonthlyBudget !== null &&
    input.agenticMonthlySpend !== null &&
    input.agenticMonthlySpend >= input.agenticMonthlyBudget
  ) {
    return {
      proceed: false,
      reason: 'agentic-budget-exceeded',
      message: `Paused: monthly agentic spend (${input.agenticMonthlySpend}) reached or exceeded budget (${input.agenticMonthlyBudget}).`,
      issue: null,
    };
  }

  const claimed = claimedIssues(input.openPrs);
  const ciRed = input.ciFailingNow.length > 0;

  if (input.requestedIssue !== null) {
    const target =
      input.issues.find((issue) => issue.number === input.requestedIssue) ??
      null;
    if (!target) {
      return {
        proceed: false,
        reason: 'issue-not-found',
        message: `Requested issue #${input.requestedIssue} is not open.`,
        issue: null,
      };
    }
    if (claimed.has(target.number)) {
      return {
        proceed: false,
        reason: 'already-has-pr',
        message: `Issue #${target.number} already has an open pull request.`,
        issue: null,
      };
    }
    if (ciRed && !isRecoveryIssue(target)) {
      return {
        proceed: false,
        reason: 'ci-failing-on-main',
        message: `Paused: default-branch CI is failing (${input.ciFailingNow.join(', ')}) and #${target.number} is not a recovery issue.`,
        issue: null,
      };
    }
    return {
      proceed: true,
      reason: 'selected',
      message: `Selected requested issue #${target.number}: ${target.title}`,
      issue: target,
    };
  }

  const eligible = input.issues.filter(
    (issue) => isEligibleIssue(issue) && !claimed.has(issue.number)
  );
  if (eligible.length === 0) {
    return {
      proceed: false,
      reason: 'no-eligible-issues',
      message: 'No unclaimed eligible issues found.',
      issue: null,
    };
  }

  const candidates = ciRed ? eligible.filter(isRecoveryIssue) : eligible;
  if (candidates.length === 0) {
    return {
      proceed: false,
      reason: 'ci-failing-on-main',
      message: `Paused: default-branch CI is failing (${input.ciFailingNow.join(', ')}) and no recovery issue is queued.`,
      issue: null,
    };
  }

  const sorted = [...candidates].sort((a, b) => {
    const tierDiff = priorityTier(a) - priorityTier(b);
    if (tierDiff !== 0) return tierDiff;
    const dateDiff = a.createdAt.localeCompare(b.createdAt);
    if (dateDiff !== 0) return dateDiff;
    return a.number - b.number;
  });

  const selected = sorted[0];
  return {
    proceed: true,
    reason: 'selected',
    message: `Selected issue #${selected.number}: ${selected.title}`,
    issue: selected,
  };
}

/** Explicit formal invariant checker for every circuit-breaker decision. */
export function checkResolveGateInvariants(
  input: ResolveGateInput,
  decision: ResolveGateDecision
): string[] {
  const errors: string[] = [];

  if (decision.proceed && decision.issue === null) {
    errors.push('proceed=true must always select a non-null issue');
  }
  if (!decision.proceed && decision.issue !== null) {
    errors.push('proceed=false must never return a selected issue');
  }
  if (decision.proceed && decision.reason !== 'selected') {
    errors.push(`proceed=true must have reason="selected", got ${decision.reason}`);
  }
  if (input.requireProofSeal && !input.proofSealOk && decision.proceed) {
    errors.push(
      'Invariant violation: gate proceeded despite broken proof seal'
    );
  }
  const openAgentPrs = input.openPrs.filter((pr) => pr.isAgent).length;
  if (openAgentPrs >= input.maxOpenAgentPrs && decision.proceed) {
    errors.push(
      'Invariant violation: gate proceeded despite open agent PR cap reached'
    );
  }
  if (
    input.agenticMonthlyBudget !== null &&
    input.agenticMonthlySpend !== null &&
    input.agenticMonthlySpend >= input.agenticMonthlyBudget &&
    decision.proceed
  ) {
    errors.push(
      'Invariant violation: gate proceeded despite exceeded agentic monthly budget'
    );
  }
  if (decision.issue !== null) {
    const claimed = claimedIssues(input.openPrs);
    if (claimed.has(decision.issue.number)) {
      errors.push(
        `Invariant violation: selected issue #${decision.issue.number} already has an open PR`
      );
    }
    if (input.ciFailingNow.length > 0 && !isRecoveryIssue(decision.issue)) {
      errors.push(
        `Invariant violation: selected non-recovery issue #${decision.issue.number} while CI is red`
      );
    }
  }

  return errors;
}
