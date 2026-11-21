/**
 * Proof-Aware Autonomous Resolution Circuit Breaker contracts.
 * Layer 0 (`src/shared/`).
 */

export interface GateIssue {
  readonly number: number;
  readonly title: string;
  readonly labels: readonly string[];
  readonly createdAt: string;
}

export interface GatePr {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly isAgent: boolean;
}

export interface ResolveGateInput {
  readonly issues: readonly GateIssue[];
  readonly openPrs: readonly GatePr[];
  readonly ciFailingNow: readonly string[];
  readonly proofSealOk: boolean;
  readonly requireProofSeal: boolean;
  readonly agenticMonthlySpend: number | null;
  readonly agenticMonthlyBudget: number | null;
  readonly requestedIssue: number | null;
  readonly maxOpenAgentPrs: number;
}

export type ResolveGateReason =
  | 'selected'
  | 'proof-seal-broken'
  | 'open-agent-pr-cap'
  | 'agentic-budget-exceeded'
  | 'ci-failing-on-main'
  | 'already-has-pr'
  | 'issue-not-found'
  | 'no-eligible-issues';

export interface ResolveGateDecision {
  readonly proceed: boolean;
  readonly reason: ResolveGateReason;
  readonly message: string;
  readonly issue: GateIssue | null;
}

export interface GateReport {
  readonly schema_version: 1;
  readonly evaluated_at: string;
  readonly repository: string;
  readonly decision: ResolveGateDecision;
  readonly constraints: {
    readonly proof_seal_ok: boolean;
    readonly require_proof_seal: boolean;
    readonly open_agent_prs: number;
    readonly max_open_agent_prs: number;
    readonly ci_failing_now: readonly string[];
    readonly agentic_monthly_spend: number | null;
    readonly agentic_monthly_budget: number | null;
  };
}
