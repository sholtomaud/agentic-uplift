/**
 * Unified SRE + Proof + Uplift Status Report & Agent Query contracts.
 * Layer 0 (`src/shared/`).
 */
import type { AutonomyLevel, ReadinessSummary } from './audit-types.ts';
import type { JsonValue } from './contracts.ts';
import type { ResolveGateDecision } from './gate-types.ts';

export type DoraBand = 'elite' | 'high' | 'medium' | 'low' | 'insufficient';

export interface IssueMetrics {
  readonly open: number;
  readonly closed: number;
  readonly closed_by_agent: number;
  readonly closed_by_human: number;
  /** Human-closed issues whose closing PR/commit carries agent attribution. */
  readonly closed_agent_assisted: number;
  /** Issues opened by an agent account or disclosed as agent-filed. */
  readonly opened_by_agent: number;
  readonly fix_referenced: number;
  readonly doom_loop_ratio_7d: number | null;
  readonly agent_resolution_share: number | null;
}

export interface PullMetrics {
  readonly open: number;
  readonly merged: number;
  readonly open_agent_prs: number;
  readonly merged_agent_prs: number;
  readonly merged_assisted_prs: number;
  readonly merged_human_prs: number;
  readonly median_hours_to_merge: number | null;
}

/**
 * How people-vs-agents attribution was measured. Every figure derived from it
 * is an observed lower bound from GitHub records, never a modeled estimate.
 */
export interface AttributionCoverage {
  readonly basis: 'measured';
  readonly lower_bound: true;
  readonly sources: readonly string[];
  readonly issues_sampled: number;
  readonly pulls_sampled: number;
  readonly commits_sampled: number;
  readonly caveat: string;
}

export interface CiHealthMetrics {
  readonly total_runs: number;
  readonly passing_runs: number;
  readonly pass_rate: number | null;
  readonly failing_workflows: readonly string[];
}

export interface DeliveryMetrics {
  readonly releases_30d: number;
  readonly deployment_frequency_band: DoraBand;
  readonly median_lead_time_hours: number | null;
  readonly lead_time_band: DoraBand;
}

export interface StatusReport {
  readonly schema_version: 1;
  readonly generated_at: string;
  readonly repository: string;
  readonly mode: 'local' | 'github';
  readonly run_url: string | null;
  readonly summary: {
    readonly autonomy: AutonomyLevel;
    readonly readiness_score: number;
    readonly proof_seal_ok: boolean;
    readonly blockers_count: number;
    readonly gate_proceed: boolean;
    readonly gate_reason: ResolveGateDecision['reason'];
  };
  readonly repo: {
    readonly default_branch: string;
    readonly ecosystems: readonly string[];
    readonly languages: readonly string[];
    readonly file_count: number;
    readonly test_file_count: number;
    readonly zero_runtime_deps: boolean | null;
  };
  readonly issues: IssueMetrics | null;
  readonly pulls: PullMetrics | null;
  /** Present in github mode; null offline. */
  readonly attribution?: AttributionCoverage | null;
  readonly ci: CiHealthMetrics | null;
  readonly delivery: DeliveryMetrics | null;
  readonly readiness: ReadinessSummary;
  readonly proof: {
    readonly ok: boolean;
    readonly root_sha256: string | null;
    readonly locked_files: number;
    readonly violations_count: number;
    readonly changelog_valid: boolean;
    readonly changelog_entries: number;
  };
  readonly endpoints: {
    readonly status: string;
    readonly audit: string;
    readonly proof: string;
    readonly gate: string;
    readonly schemas: {
      readonly status: string;
      readonly audit: string;
      readonly proof: string;
      readonly gate: string;
    };
  };
}

export interface VerificationTierResult {
  readonly tier: number;
  readonly id: 'proof-lock' | 'static-rules' | 'arch-boundaries' | 'tests-and-properties';
  readonly title: string;
  readonly ok: boolean;
  readonly duration_ms: number;
  readonly summary: string;
  readonly details: readonly string[];
}

export interface VerifyReport {
  readonly schema_version: 1;
  readonly verified_at: string;
  readonly ok: boolean;
  readonly fast: boolean;
  readonly tiers: readonly VerificationTierResult[];
  readonly metrics: {
    readonly unit_tests: number;
    readonly property_tests: number;
    readonly arch_rules: number;
    readonly skipped_tests: number;
  };
}

export interface AgentQueryResult {
  readonly schema_version: 1;
  readonly query: string;
  readonly found: boolean;
  readonly value: JsonValue;
}
