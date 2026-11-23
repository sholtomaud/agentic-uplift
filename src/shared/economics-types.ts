/**
 * People-vs-agents economics contracts: dated LLM price table, cost
 * assumptions, per-issue time/$ estimates, budgets, quality, compliance,
 * savings, and uplift pay-off.
 *
 * Every figure is tagged either `measured` (observed in GitHub records) or
 * `modeled` (derived from stated assumptions, always reported as a range).
 * The published JSON carries counts, rates, and $ only, never issue text.
 * Layer 0 (`src/shared/`).
 */
import { isFiniteNumber, isRecord, isString } from './contracts.ts';

/** Closed interval [low, high] used for every modeled figure. */
export interface Range {
  readonly low: number;
  readonly high: number;
}

export type IssueClass = 'security' | 'bug' | 'other';
export const ISSUE_CLASSES: readonly IssueClass[] = ['security', 'bug', 'other'];

export type ResolutionOrigin = 'human' | 'agent';

interface PriceEntryBase {
  readonly model: string;
  readonly provider: 'anthropic' | 'google' | 'github';
  /** Where the price was published. */
  readonly source: string;
  /** ISO date the price was read from the source. */
  readonly effective: string;
}

/** Pay-per-token API pricing (USD per million tokens). */
export interface TokenPriceEntry extends PriceEntryBase {
  readonly kind: 'per-token';
  readonly input_per_mtok: number;
  readonly output_per_mtok: number;
  readonly cache_read_per_mtok: number | null;
}

/** Per-seat subscription with included usage credits (e.g. GitHub Copilot). */
export interface SeatPriceEntry extends PriceEntryBase {
  readonly kind: 'per-seat';
  readonly seat_per_month: number;
  readonly included_credits_per_seat: number;
  readonly credit_usd: number;
}

export type PriceEntry = TokenPriceEntry | SeatPriceEntry;

export interface PriceTable {
  readonly version: string;
  readonly entries: readonly PriceEntry[];
}

/** Token usage for one agent-resolved issue. */
export interface TokenUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_tokens: number;
}

/** User-configurable cost assumptions (all optional; defaults are documented). */
export interface CostAssumptions {
  readonly human_hourly_rate: number;
  /** Hands-on hours a person spends resolving one issue, by class. */
  readonly hands_on_hours: Readonly<Record<IssueClass, Range>>;
  /** Human hours per review round on agent work. */
  readonly review_hours_per_round: Range;
  /** Human hours to handle one revert of agent work. */
  readonly revert_hours: Range;
  readonly ci_minute_usd: number;
  /** Model used by coding agents when a PR reports no usage. */
  readonly agent_model: string;
  /** Per-issue token assumption when no usage is reported. */
  readonly assumed_tokens_per_issue: {
    readonly input: Range;
    readonly output: Range;
  };
  /** Copilot seats (per-seat pricing) amortized over agent-resolved issues. */
  readonly copilot_seats: number;
  readonly copilot_plan: string;
  readonly monthly_human_budget: number | null;
  readonly monthly_agentic_budget: number | null;
  /** Negotiated / enterprise rate overrides keyed by model id. */
  readonly price_overrides: Readonly<Record<string, Partial<TokenPriceEntry>>>;
}

/** Measured facts about one resolved issue (no issue text). */
export interface ResolvedIssueSample {
  readonly number: number;
  readonly issue_class: IssueClass;
  readonly origin: ResolutionOrigin;
  readonly opened_at: string;
  readonly closed_at: string;
  /** Hours from issue open to its first linked PR (time to first useful response). */
  readonly hours_to_first_pr: number | null;
  /** Hours from linked PR open to merge. */
  readonly hours_to_merge: number | null;
  readonly review_rounds: number;
  readonly reverted: boolean;
  readonly reopened: boolean;
  readonly linked_fix: boolean;
  readonly ci_minutes: number;
  /** Agent run time reported by the PR, in minutes (null when not reported). */
  readonly agent_run_minutes: number | null;
  /** Token usage reported by the PR (null when not reported). */
  readonly reported_usage: (TokenUsage & { readonly model: string | null }) | null;
}

export interface PullComplianceSample {
  readonly origin: ResolutionOrigin;
  readonly conventional_title: boolean;
  readonly links_issue: boolean;
  /** Agent PRs only: attribution trailer/account present. */
  readonly attributed: boolean;
  /** PR changes test files (proxy for test-first). */
  readonly touches_tests: boolean | null;
  readonly ci_green_first_push: boolean | null;
}

export interface OriginFigures {
  readonly resolved: number;
  /** Measured: median elapsed hours from open to close. */
  readonly median_elapsed_hours: number | null;
  /** Modeled: hands-on human hours per resolved issue (agents: human review/revert time). */
  readonly hands_on_hours: Range | null;
  /** Modeled: $ per resolved issue (agents include human review/revert time). */
  readonly usd_per_issue: Range | null;
  /** Measured share of per-issue agent $ backed by reported usage (agents only). */
  readonly reported_usage_share: number | null;
  readonly agent_run_minutes_median: number | null;
}

export interface QualityFigures {
  readonly linked_fix_share: number | null;
  readonly revert_rate: number | null;
  readonly reopen_rate: number | null;
  /** Change failure rate: reverted / merged. */
  readonly change_failure_rate: number | null;
  readonly median_hours_to_first_pr: number | null;
  readonly median_review_rounds: number | null;
}

export interface ComplianceFigures {
  readonly prs: number;
  readonly conventional_title: number | null;
  readonly links_issue: number | null;
  readonly attributed: number | null;
  readonly touches_tests: number | null;
  readonly ci_green_first_push: number | null;
}

export interface BudgetFigures {
  readonly budget: number | null;
  /** Modeled month-to-date spend. */
  readonly spent: Range;
  /**
   * Agentic only: month-to-date $ backed purely by measured records (reported
   * token usage + CI minutes). This, not the modeled range, feeds resolve-gate.
   */
  readonly measured_spent: number | null;
  /** Spend per elapsed day this month. */
  readonly pace_per_day: Range;
  readonly projected_month_end: Range;
  readonly days_elapsed: number;
  readonly days_in_month: number;
}

export interface PayoffPoint {
  readonly date: string;
  readonly readiness_score: number;
  readonly monthly_savings: Range;
  readonly agent_change_failure_rate: number | null;
}

export interface EconomicsReport {
  readonly schema_version: 1;
  readonly generated_at: string;
  readonly repository: string;
  readonly mode: 'local' | 'github';
  readonly price_table: PriceTable;
  readonly assumptions: CostAssumptions;
  /** Which figures are observed vs. derived from assumptions. */
  readonly provenance: {
    readonly measured: readonly string[];
    readonly modeled: readonly string[];
    readonly caveat: string;
  };
  readonly sample: { readonly resolved_issues: number; readonly window_days: number };
  readonly people: OriginFigures;
  readonly agents: OriginFigures;
  readonly quality: { readonly people: QualityFigures; readonly agents: QualityFigures; readonly best_in_class: QualityFigures };
  readonly compliance: { readonly people: ComplianceFigures; readonly agents: ComplianceFigures };
  readonly budgets: { readonly human: BudgetFigures; readonly agentic: BudgetFigures };
  readonly savings: {
    /** Modeled agentic + human-review spend this month. */
    readonly actual_monthly: Range;
    /** Modeled spend had people resolved every issue resolved this month. */
    readonly all_human_counterfactual: Range;
    readonly monthly_savings: Range;
  };
  readonly payoff: readonly PayoffPoint[];
}

function isRange(value: unknown): value is Range {
  return (
    isRecord(value) &&
    isFiniteNumber(value.low) &&
    isFiniteNumber(value.high) &&
    value.low <= value.high
  );
}

type Mutable<T> = { -readonly [K in keyof T]?: T[K] };

function nonNegative(value: unknown): number | null {
  return isFiniteNumber(value) && value >= 0 ? value : null;
}

/** Validates the optional `costs` block of uplift.config.json (partial overrides). */
export function readCostOverrides(value: unknown): Partial<CostAssumptions> {
  const out: Mutable<CostAssumptions> = {};
  if (!isRecord(value)) return out;
  const rate = nonNegative(value.humanHourlyRate);
  if (rate !== null) out.human_hourly_rate = rate;
  const ci = nonNegative(value.ciMinuteUsd);
  if (ci !== null) out.ci_minute_usd = ci;
  const seats = nonNegative(value.copilotSeats);
  if (seats !== null) out.copilot_seats = seats;
  const humanBudget = nonNegative(value.monthlyHumanBudget);
  if (humanBudget !== null) out.monthly_human_budget = humanBudget;
  const agenticBudget = nonNegative(value.monthlyAgenticBudget);
  if (agenticBudget !== null) out.monthly_agentic_budget = agenticBudget;
  if (isString(value.agentModel)) out.agent_model = value.agentModel;
  if (isString(value.copilotPlan)) out.copilot_plan = value.copilotPlan;
  if (isRecord(value.handsOnHours)) {
    const h = value.handsOnHours;
    if (isRange(h.security) && isRange(h.bug) && isRange(h.other)) {
      out.hands_on_hours = { security: h.security, bug: h.bug, other: h.other };
    }
  }
  if (isRange(value.reviewHoursPerRound)) out.review_hours_per_round = value.reviewHoursPerRound;
  if (isRange(value.revertHours)) out.revert_hours = value.revertHours;
  if (isRecord(value.assumedTokensPerIssue)) {
    const t = value.assumedTokensPerIssue;
    if (isRange(t.input) && isRange(t.output)) {
      out.assumed_tokens_per_issue = { input: t.input, output: t.output };
    }
  }
  if (isRecord(value.priceOverrides)) {
    const overrides: Record<string, Partial<TokenPriceEntry>> = {};
    for (const [model, raw] of Object.entries(value.priceOverrides)) {
      if (!isRecord(raw)) continue;
      const entry: Mutable<TokenPriceEntry> = {};
      const input = nonNegative(raw.inputPerMTok);
      const output = nonNegative(raw.outputPerMTok);
      const cacheRead = nonNegative(raw.cacheReadPerMTok);
      if (input !== null) entry.input_per_mtok = input;
      if (output !== null) entry.output_per_mtok = output;
      if (cacheRead !== null) entry.cache_read_per_mtok = cacheRead;
      if (Object.keys(entry).length > 0) overrides[model] = entry;
    }
    out.price_overrides = overrides;
  }
  return out;
}

export function isPayoffPoint(value: unknown): value is PayoffPoint {
  return (
    isRecord(value) &&
    isString(value.date) &&
    /^\d{4}-\d{2}-\d{2}$/.test(value.date) &&
    isFiniteNumber(value.readiness_score) &&
    isRange(value.monthly_savings) &&
    (value.agent_change_failure_rate === null || isFiniteNumber(value.agent_change_failure_rate))
  );
}

/** Extracts a valid pay-off history from a previously published economics.json. */
export function readPayoffHistory(value: unknown): PayoffPoint[] {
  if (!isRecord(value) || !Array.isArray(value.payoff)) return [];
  return value.payoff.filter(isPayoffPoint);
}
