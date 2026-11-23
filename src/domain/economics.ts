/**
 * People-vs-agents economics (#2–#5): per-issue time and $ estimates, separate
 * human and agentic budgets, quality and AGENTS.md compliance shares, savings
 * against an all-human counterfactual, and uplift pay-off over time.
 *
 * Measured figures come straight from GitHub records. Modeled figures come
 * from stated assumptions and are always ranges. Nothing here sees issue text.
 * Layer 1 (`src/domain/`): pure, zero Node/DOM imports.
 */
import type {
  BudgetFigures,
  ComplianceFigures,
  CostAssumptions,
  EconomicsReport,
  IssueClass,
  OriginFigures,
  PayoffPoint,
  PriceTable,
  PullComplianceSample,
  QualityFigures,
  Range,
  ResolvedIssueSample,
  TokenUsage,
} from '../shared/economics-types.ts';
import {
  applyPriceOverrides,
  DEFAULT_PRICE_TABLE,
  findSeatPrice,
  findTokenPrice,
  tokenCostUsd,
} from './price-table.ts';

/**
 * Documented defaults. Every one is an assumption a maintainer should tune in
 * uplift.config.json → `costs`; the report labels all figures derived from
 * them as modeled.
 */
export const DEFAULT_COST_ASSUMPTIONS: CostAssumptions = {
  human_hourly_rate: 100,
  hands_on_hours: {
    security: { low: 4, high: 16 },
    bug: { low: 2, high: 8 },
    other: { low: 1, high: 6 },
  },
  review_hours_per_round: { low: 0.25, high: 1 },
  revert_hours: { low: 1, high: 4 },
  ci_minute_usd: 0.006,
  agent_model: 'claude-opus-5-5',
  assumed_tokens_per_issue: {
    input: { low: 300_000, high: 3_000_000 },
    output: { low: 20_000, high: 200_000 },
  },
  copilot_seats: 0,
  copilot_plan: 'copilot-business',
  monthly_human_budget: null,
  monthly_agentic_budget: null,
  price_overrides: {},
};

export const BEST_IN_CLASS: QualityFigures = {
  linked_fix_share: 0.95,
  revert_rate: 0.02,
  reopen_rate: 0.05,
  change_failure_rate: 0.05,
  median_hours_to_first_pr: 24,
  median_review_rounds: 1,
};

export const ECONOMICS_CAVEAT =
  'Measured figures are lower-bound observations from the most recent GitHub records. Modeled figures ($, hands-on hours, budgets, savings) are ranges derived from the stated assumptions and price table; tune them in uplift.config.json → costs.';

export function resolveCostAssumptions(
  ...layers: readonly Partial<CostAssumptions>[]
): CostAssumptions {
  let merged: CostAssumptions = DEFAULT_COST_ASSUMPTIONS;
  for (const layer of layers) merged = { ...merged, ...layer };
  return merged;
}

const ZERO: Range = { low: 0, high: 0 };

export function addRanges(...ranges: readonly Range[]): Range {
  return ranges.reduce((acc, r) => ({ low: acc.low + r.low, high: acc.high + r.high }), ZERO);
}

export function scaleRange(r: Range, factor: number): Range {
  return factor >= 0
    ? { low: r.low * factor, high: r.high * factor }
    : { low: r.high * factor, high: r.low * factor };
}

function subtractRanges(a: Range, b: Range): Range {
  return { low: a.low - b.high, high: a.high - b.low };
}

function roundRange(r: Range, digits = 2): Range {
  const f = 10 ** digits;
  return { low: Math.round(r.low * f) / f, high: Math.round(r.high * f) / f };
}

function meanRange(ranges: readonly Range[]): Range | null {
  if (ranges.length === 0) return null;
  return scaleRange(addRanges(...ranges), 1 / ranges.length);
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function share(count: number, total: number): number | null {
  return total > 0 ? Math.round((count / total) * 1000) / 1000 : null;
}

function round1(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10) / 10;
}

export function classifyIssue(labels: readonly string[]): IssueClass {
  const lower = labels.map((l) => l.toLowerCase());
  if (lower.some((l) => /\bsecurity\b|\bvulnerab|\bcve\b/.test(l))) return 'security';
  if (lower.some((l) => /\bbug\b|\bdefect\b|\bregression\b/.test(l))) return 'bug';
  return 'other';
}

const CONVENTIONAL_TITLE =
  /^(?:feat|fix|docs|test|chore|refactor|perf|build|ci|style|revert)(?:\([\w./-]+\))?!?:\s\S/;

export function isConventionalTitle(title: string): boolean {
  return CONVENTIONAL_TITLE.test(title.trim());
}

export interface ReportedUsage extends TokenUsage {
  readonly model: string | null;
  readonly run_minutes: number | null;
}

/**
 * Parses a structured usage line an agent writes into its PR description or
 * commit message, e.g.
 * `Agent-Usage: model=claude-opus-5-5 input_tokens=1200000 output_tokens=45000 cache_read_tokens=800000 run_minutes=18`
 * Multiple lines are summed (one per agent run).
 */
export function parseReportedUsage(text: string): ReportedUsage | null {
  let found = false;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let minutes: number | null = null;
  let model: string | null = null;
  for (const line of text.matchAll(/^\s*agent-usage\s*:\s*(.+)$/gim)) {
    const fields = new Map<string, string>();
    for (const m of line[1].matchAll(/([a-z_]+)\s*=\s*([^\s,;]+)/gi)) {
      fields.set(m[1].toLowerCase(), m[2]);
    }
    const num = (key: string): number | null => {
      const raw = fields.get(key);
      if (raw === undefined) return null;
      const n = Number(raw.replace(/_/g, ''));
      return Number.isFinite(n) && n >= 0 ? n : null;
    };
    const i = num('input_tokens');
    const o = num('output_tokens');
    if (i === null && o === null) continue;
    found = true;
    input += i ?? 0;
    output += o ?? 0;
    cacheRead += num('cache_read_tokens') ?? 0;
    const rm = num('run_minutes');
    if (rm !== null) minutes = (minutes ?? 0) + rm;
    model = fields.get('model')?.toLowerCase() ?? model;
  }
  return found
    ? { input_tokens: input, output_tokens: output, cache_read_tokens: cacheRead, model, run_minutes: minutes }
    : null;
}

export interface HumanIssueEstimate {
  readonly hours: Range;
  readonly usd: Range;
}

export function estimateHumanIssue(
  issueClass: IssueClass,
  a: CostAssumptions
): HumanIssueEstimate {
  const hours = a.hands_on_hours[issueClass];
  return { hours, usd: scaleRange(hours, a.human_hourly_rate) };
}

export interface AgentIssueEstimate {
  /** LLM tokens + CI minutes + amortized seats. */
  readonly agentic_usd: Range;
  /** Reported-usage token $ + CI minutes $ (measured records only). */
  readonly measured_usd: number;
  /** Human review / revert time required by the agent work. */
  readonly human_hours: Range;
  readonly human_usd: Range;
  readonly total_usd: Range;
  readonly reported_usage: boolean;
}

export function estimateAgentIssue(
  sample: ResolvedIssueSample,
  a: CostAssumptions,
  table: PriceTable,
  seatUsdPerIssue: number
): AgentIssueEstimate {
  const usage = sample.reported_usage;
  const price =
    findTokenPrice(table, usage?.model ?? a.agent_model) ?? findTokenPrice(table, a.agent_model);
  let llm: Range = ZERO;
  let measuredLlm = 0;
  if (price) {
    if (usage) {
      const usd = tokenCostUsd(price, usage);
      measuredLlm = usd;
      llm = { low: usd, high: usd };
    } else {
      const t = a.assumed_tokens_per_issue;
      llm = {
        low: tokenCostUsd(price, { input_tokens: t.input.low, output_tokens: t.output.low, cache_read_tokens: 0 }),
        high: tokenCostUsd(price, { input_tokens: t.input.high, output_tokens: t.output.high, cache_read_tokens: 0 }),
      };
    }
  }
  const ci = sample.ci_minutes * a.ci_minute_usd;
  const agentic = addRanges(llm, { low: ci + seatUsdPerIssue, high: ci + seatUsdPerIssue });
  const humanHours = addRanges(
    scaleRange(a.review_hours_per_round, Math.max(1, sample.review_rounds)),
    sample.reverted ? a.revert_hours : ZERO
  );
  const humanUsd = scaleRange(humanHours, a.human_hourly_rate);
  return {
    agentic_usd: agentic,
    measured_usd: measuredLlm + ci,
    human_hours: humanHours,
    human_usd: humanUsd,
    total_usd: addRanges(agentic, humanUsd),
    reported_usage: usage !== null,
  };
}

function hoursBetween(from: string, to: string): number | null {
  const a = Date.parse(from);
  const b = Date.parse(to);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, (b - a) / 3_600_000) : null;
}

function qualityOf(samples: readonly ResolvedIssueSample[]): QualityFigures {
  const withPr = samples.filter((s) => s.hours_to_merge !== null);
  return {
    linked_fix_share: share(samples.filter((s) => s.linked_fix).length, samples.length),
    revert_rate: share(samples.filter((s) => s.reverted).length, samples.length),
    reopen_rate: share(samples.filter((s) => s.reopened).length, samples.length),
    change_failure_rate: share(withPr.filter((s) => s.reverted).length, withPr.length),
    median_hours_to_first_pr: round1(
      median(samples.flatMap((s) => (s.hours_to_first_pr === null ? [] : [s.hours_to_first_pr])))
    ),
    median_review_rounds: median(withPr.map((s) => s.review_rounds)),
  };
}

function complianceOf(prs: readonly PullComplianceSample[]): ComplianceFigures {
  const known = (pick: (p: PullComplianceSample) => boolean | null): number | null => {
    const values = prs.flatMap((p) => {
      const v = pick(p);
      return v === null ? [] : [v];
    });
    return share(values.filter(Boolean).length, values.length);
  };
  return {
    prs: prs.length,
    conventional_title: known((p) => p.conventional_title),
    links_issue: known((p) => p.links_issue),
    attributed: known((p) => (p.origin === 'agent' ? p.attributed : null)),
    touches_tests: known((p) => p.touches_tests),
    ci_green_first_push: known((p) => p.ci_green_first_push),
  };
}

function budgetOf(
  budget: number | null,
  spent: Range,
  now: Date,
  measuredSpent: number | null = null
): BudgetFigures {
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const daysElapsed = Math.max(1, now.getUTCDate());
  const pace = scaleRange(spent, 1 / daysElapsed);
  return {
    budget,
    spent: roundRange(spent),
    measured_spent: measuredSpent === null ? null : Math.round(measuredSpent * 100) / 100,
    pace_per_day: roundRange(pace),
    projected_month_end: roundRange(scaleRange(pace, daysInMonth)),
    days_elapsed: daysElapsed,
    days_in_month: daysInMonth,
  };
}

export interface EconomicsInput {
  readonly repository: string;
  readonly mode: 'local' | 'github';
  readonly now: Date;
  readonly windowDays: number;
  readonly issues: readonly ResolvedIssueSample[];
  readonly pulls: readonly PullComplianceSample[];
  readonly assumptions: CostAssumptions;
  readonly readinessScore: number;
  readonly history: readonly PayoffPoint[];
  readonly priceTable?: PriceTable;
}

function inMonth(iso: string, now: Date): boolean {
  const d = new Date(iso);
  return (
    Number.isFinite(d.getTime()) &&
    d.getUTCFullYear() === now.getUTCFullYear() &&
    d.getUTCMonth() === now.getUTCMonth()
  );
}

export function buildEconomicsReport(input: EconomicsInput): EconomicsReport {
  const a = input.assumptions;
  const table = applyPriceOverrides(input.priceTable ?? DEFAULT_PRICE_TABLE, a.price_overrides);
  const people = input.issues.filter((s) => s.origin === 'human');
  const agents = input.issues.filter((s) => s.origin === 'agent');
  const agentsThisMonth = agents.filter((s) => inMonth(s.closed_at, input.now));

  const seat = findSeatPrice(table, a.copilot_plan);
  const seatMonthly = seat ? seat.seat_per_month * a.copilot_seats : 0;
  const seatPerIssue = seatMonthly > 0 ? seatMonthly / Math.max(1, agentsThisMonth.length) : 0;

  const humanEst = new Map(people.map((s) => [s.number, estimateHumanIssue(s.issue_class, a)]));
  const agentEst = new Map(agents.map((s) => [s.number, estimateAgentIssue(s, a, table, seatPerIssue)]));

  const elapsed = (list: readonly ResolvedIssueSample[]): number | null =>
    round1(median(list.flatMap((s) => {
      const h = hoursBetween(s.opened_at, s.closed_at);
      return h === null ? [] : [h];
    })));

  const peopleHours = meanRange([...humanEst.values()].map((e) => e.hours));
  const peopleUsd = meanRange([...humanEst.values()].map((e) => e.usd));
  const agentHours = meanRange([...agentEst.values()].map((e) => e.human_hours));
  const agentUsd = meanRange([...agentEst.values()].map((e) => e.total_usd));

  const peopleFigures: OriginFigures = {
    resolved: people.length,
    median_elapsed_hours: elapsed(people),
    hands_on_hours: peopleHours && roundRange(peopleHours),
    usd_per_issue: peopleUsd && roundRange(peopleUsd),
    reported_usage_share: null,
    agent_run_minutes_median: null,
  };
  const agentFigures: OriginFigures = {
    resolved: agents.length,
    median_elapsed_hours: elapsed(agents),
    hands_on_hours: agentHours && roundRange(agentHours),
    usd_per_issue: agentUsd && roundRange(agentUsd),
    reported_usage_share: share([...agentEst.values()].filter((e) => e.reported_usage).length, agents.length),
    agent_run_minutes_median: round1(
      median(agents.flatMap((s) => (s.agent_run_minutes === null ? [] : [s.agent_run_minutes])))
    ),
  };

  // Budgets: human time (people's work + human time agent work required) vs agentic $.
  const monthPeople = people.filter((s) => inMonth(s.closed_at, input.now));
  const humanSpent = addRanges(
    ...monthPeople.map((s) => humanEst.get(s.number)?.usd ?? ZERO),
    ...agentsThisMonth.map((s) => agentEst.get(s.number)?.human_usd ?? ZERO)
  );
  const agenticSpent = addRanges(
    ...agentsThisMonth.map((s) => agentEst.get(s.number)?.agentic_usd ?? ZERO),
    agentsThisMonth.length === 0 && seatMonthly > 0 ? { low: seatMonthly, high: seatMonthly } : ZERO
  );

  const actual = addRanges(humanSpent, agenticSpent);
  const counterfactual = addRanges(
    ...[...monthPeople, ...agentsThisMonth].map((s) => estimateHumanIssue(s.issue_class, a).usd)
  );
  // People's own work appears identically on both sides and cancels exactly;
  // only agent-resolved issues can save (or cost) money. Interval subtraction
  // keeps the worst case: cheap people vs. expensive agents.
  const agentCounterfactual = addRanges(
    ...agentsThisMonth.map((s) => estimateHumanIssue(s.issue_class, a).usd)
  );
  const agentActual = addRanges(
    ...agentsThisMonth.map((s) => agentEst.get(s.number)?.total_usd ?? ZERO),
    agentsThisMonth.length === 0 && seatMonthly > 0 ? { low: seatMonthly, high: seatMonthly } : ZERO
  );
  const savings = subtractRanges(agentCounterfactual, agentActual);

  const point: PayoffPoint = {
    date: input.now.toISOString().slice(0, 10),
    readiness_score: input.readinessScore,
    monthly_savings: roundRange(savings),
    agent_change_failure_rate: qualityOf(agents).change_failure_rate,
  };

  return {
    schema_version: 1,
    generated_at: input.now.toISOString().replace(/\.\d+Z$/, 'Z'),
    repository: input.repository,
    mode: input.mode,
    price_table: table,
    assumptions: a,
    provenance: {
      measured: [
        'resolved counts by origin',
        'elapsed hours open to close',
        'hours to first linked PR',
        'review rounds',
        'reverts and reopens',
        'linked fixes',
        'CI minutes',
        'reported agent token usage and run time',
        'AGENTS.md compliance shares',
      ],
      modeled: [
        'hands-on human hours',
        '$ per resolved issue',
        'monthly budget spend, pace, and projection',
        'all-human counterfactual and savings',
        'agent token cost when usage is not reported',
      ],
      caveat: ECONOMICS_CAVEAT,
    },
    sample: { resolved_issues: input.issues.length, window_days: input.windowDays },
    people: peopleFigures,
    agents: agentFigures,
    quality: { people: qualityOf(people), agents: qualityOf(agents), best_in_class: BEST_IN_CLASS },
    compliance: {
      people: complianceOf(input.pulls.filter((p) => p.origin === 'human')),
      agents: complianceOf(input.pulls.filter((p) => p.origin === 'agent')),
    },
    budgets: {
      human: budgetOf(a.monthly_human_budget, humanSpent, input.now),
      agentic: budgetOf(
        a.monthly_agentic_budget,
        agenticSpent,
        input.now,
        agentsThisMonth.reduce((sum, s) => sum + (agentEst.get(s.number)?.measured_usd ?? 0), 0)
      ),
    },
    savings: {
      actual_monthly: roundRange(actual),
      all_human_counterfactual: roundRange(counterfactual),
      monthly_savings: roundRange(savings),
    },
    payoff: appendPayoffPoint(input.history, point),
  };
}

/** Appends today's pay-off point (replacing an existing point for the same date). */
export function appendPayoffPoint(
  history: readonly PayoffPoint[],
  point: PayoffPoint,
  maxPoints = 366
): PayoffPoint[] {
  const kept = history.filter((p) => p.date !== point.date);
  return [...kept, point].sort((x, y) => x.date.localeCompare(y.date)).slice(-maxPoints);
}

function rangeErrors(label: string, r: Range | null, allowNegative = false): string[] {
  if (r === null) return [];
  const errors: string[] = [];
  if (!(r.low <= r.high)) errors.push(`${label}: range low ${r.low} > high ${r.high}`);
  if (!allowNegative && r.low < 0) errors.push(`${label}: negative ${r.low}`);
  return errors;
}

function shareErrors(label: string, q: object): string[] {
  const errors: string[] = [];
  for (const [k, v] of Object.entries(q)) {
    if (typeof v === 'number' && /share|rate|title|links|attributed|touches|green/.test(k) && (v < 0 || v > 1)) {
      errors.push(`${label}.${k} out of [0,1]: ${v}`);
    }
  }
  return errors;
}

/** Formal invariants for an EconomicsReport. */
export function checkEconomicsInvariants(r: EconomicsReport): string[] {
  const errors: string[] = [
    ...rangeErrors('people.usd_per_issue', r.people.usd_per_issue),
    ...rangeErrors('agents.usd_per_issue', r.agents.usd_per_issue),
    ...rangeErrors('people.hands_on_hours', r.people.hands_on_hours),
    ...rangeErrors('agents.hands_on_hours', r.agents.hands_on_hours),
    ...rangeErrors('budgets.human.spent', r.budgets.human.spent),
    ...rangeErrors('budgets.agentic.spent', r.budgets.agentic.spent),
    ...rangeErrors('budgets.human.projected', r.budgets.human.projected_month_end),
    ...rangeErrors('budgets.agentic.projected', r.budgets.agentic.projected_month_end),
    ...rangeErrors('savings.actual', r.savings.actual_monthly),
    ...rangeErrors('savings.counterfactual', r.savings.all_human_counterfactual),
    ...rangeErrors('savings.monthly', r.savings.monthly_savings, true),
    ...shareErrors('quality.people', r.quality.people),
    ...shareErrors('quality.agents', r.quality.agents),
    ...shareErrors('compliance.people', r.compliance.people),
    ...shareErrors('compliance.agents', r.compliance.agents),
  ];
  if (r.people.resolved + r.agents.resolved !== r.sample.resolved_issues) {
    errors.push('people + agents resolved does not equal sampled resolved issues');
  }
  for (const b of [r.budgets.human, r.budgets.agentic]) {
    if (b.projected_month_end.low + 1e-9 < b.spent.low) {
      errors.push('projected month-end spend below month-to-date spend');
    }
  }
  const s = r.savings;
  // Savings are the agent-only difference, so they must lie within the
  // interval difference of the totals (people's own work cancels).
  if (
    s.monthly_savings.low < s.all_human_counterfactual.low - s.actual_monthly.high - 0.02 ||
    s.monthly_savings.high > s.all_human_counterfactual.high - s.actual_monthly.low + 0.02
  ) {
    errors.push('savings do not equal counterfactual minus actual spend');
  }
  for (let i = 1; i < r.payoff.length; i += 1) {
    if (r.payoff[i - 1].date >= r.payoff[i].date) errors.push('payoff history not strictly ordered by date');
  }
  return errors;
}
