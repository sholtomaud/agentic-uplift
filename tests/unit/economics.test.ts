import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { collectEconomicsSamples, revertedPullNumbers } from '../../src/adapters/economics-collector.ts';
import type { GitHubClient, GitHubRestResponse } from '../../src/adapters/github-client.ts';
import type { MergedPullRecord } from '../../src/adapters/github-collector.ts';
import { loadPayoffHistory } from '../../src/adapters/payoff-history.ts';
import { validateJsonSchema } from '../../src/core/json-schema.ts';
import {
  appendPayoffPoint,
  buildEconomicsReport,
  checkEconomicsInvariants,
  classifyIssue,
  DEFAULT_COST_ASSUMPTIONS,
  estimateAgentIssue,
  estimateHumanIssue,
  isConventionalTitle,
  parseReportedUsage,
  resolveCostAssumptions,
} from '../../src/domain/economics.ts';
import {
  applyPriceOverrides,
  checkPriceTableInvariants,
  DEFAULT_PRICE_TABLE,
  findSeatPrice,
  findTokenPrice,
  tokenCostUsd,
} from '../../src/domain/price-table.ts';
import { readCostOverrides, type ResolvedIssueSample } from '../../src/shared/economics-types.ts';

const NOW = new Date('2026-11-20T12:00:00Z');

function issue(overrides: Partial<ResolvedIssueSample> = {}): ResolvedIssueSample {
  return {
    number: 1,
    issue_class: 'bug',
    origin: 'human',
    opened_at: '2026-11-10T00:00:00Z',
    closed_at: '2026-11-12T00:00:00Z',
    hours_to_first_pr: 6,
    hours_to_merge: 4,
    review_rounds: 1,
    reverted: false,
    reopened: false,
    linked_fix: true,
    ci_minutes: 10,
    agent_run_minutes: null,
    reported_usage: null,
    ...overrides,
  };
}

// --- #3 price table ---

test('price table is dated, sourced, duplicate-free and internally consistent', () => {
  assert.deepEqual(checkPriceTableInvariants(DEFAULT_PRICE_TABLE), []);
  for (const provider of ['anthropic', 'google', 'github']) {
    assert.ok(DEFAULT_PRICE_TABLE.entries.some((e) => e.provider === provider), provider);
  }
  const opus = findTokenPrice(DEFAULT_PRICE_TABLE, 'claude-opus-5-5');
  assert.ok(opus);
  assert.equal(opus.input_per_mtok, 4);
  assert.equal(opus.output_per_mtok, 20);
  const business = findSeatPrice(DEFAULT_PRICE_TABLE, 'copilot-business');
  assert.ok(business);
  assert.equal(business.seat_per_month, 19);
  assert.equal(business.credit_usd, 0.01);
});

test('canary: price-table invariants reject undated, unsourced, or inconsistent entries', () => {
  const opus = findTokenPrice(DEFAULT_PRICE_TABLE, 'claude-opus-5-5');
  assert.ok(opus);
  const broken = {
    version: 'latest',
    entries: [opus, opus, { ...opus, model: 'x', source: 'memory', effective: '', cache_read_per_mtok: 99 }],
  };
  const errors = checkPriceTableInvariants(broken).join('\n');
  assert.match(errors, /ISO date/);
  assert.match(errors, /Duplicate/);
  assert.match(errors, /https URL/);
  assert.match(errors, /effective date/);
  assert.match(errors, /cache reads priced above/);
});

test('token cost uses per-MTok prices, cache-read rate, and negotiated overrides', () => {
  const opus = findTokenPrice(DEFAULT_PRICE_TABLE, 'claude-opus-5-5');
  assert.ok(opus);
  const usage = { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_tokens: 2_000_000 };
  assert.equal(tokenCostUsd(opus, usage), 4 + 2 + 0.4);
  const overridden = applyPriceOverrides(DEFAULT_PRICE_TABLE, { 'claude-opus-5-5': { input_per_mtok: 3 } });
  const o = findTokenPrice(overridden, 'claude-opus-5-5');
  assert.ok(o);
  assert.equal(o.input_per_mtok, 3);
  assert.equal(o.output_per_mtok, 20);
  assert.match(o.source, /overridden/);
});

test('parseReportedUsage reads and sums Agent-Usage lines; absent lines return null', () => {
  const u = parseReportedUsage(
    'Fixes #3\n\nAgent-Usage: model=claude-sonnet-5-5 input_tokens=1_200_000 output_tokens=40000 cache_read_tokens=500000 run_minutes=12\nagent-usage: input_tokens=100000 output_tokens=5000 run_minutes=3'
  );
  assert.deepEqual(u, {
    input_tokens: 1_300_000,
    output_tokens: 45_000,
    cache_read_tokens: 500_000,
    model: 'claude-sonnet-5-5',
    run_minutes: 15,
  });
  assert.equal(parseReportedUsage('no usage here'), null);
});

test('cost overrides from uplift.config.json are validated field by field', () => {
  const o = readCostOverrides({
    humanHourlyRate: 150,
    monthlyHumanBudget: 20000,
    handsOnHours: { security: { low: 2, high: 4 }, bug: { low: 1, high: 2 }, other: { low: 0.5, high: 1 } },
    reviewHoursPerRound: { low: 2, high: 1 }, // invalid: low > high, ignored
    priceOverrides: { 'claude-opus-5-5': { inputPerMTok: 3, outputPerMTok: -1 } },
    agentModel: 'claude-sonnet-5-5',
  });
  assert.equal(o.human_hourly_rate, 150);
  assert.equal(o.monthly_human_budget, 20000);
  assert.equal(o.hands_on_hours?.security.high, 4);
  assert.equal(o.review_hours_per_round, undefined);
  assert.deepEqual(o.price_overrides, { 'claude-opus-5-5': { input_per_mtok: 3 } });
  assert.equal(resolveCostAssumptions(o).agent_model, 'claude-sonnet-5-5');
  assert.deepEqual(readCostOverrides('nope'), {});
});

// --- #4 per-issue estimates ---

test('human estimate is class-aware hands-on hours × hourly rate', () => {
  const e = estimateHumanIssue('security', DEFAULT_COST_ASSUMPTIONS);
  assert.deepEqual(e.hours, { low: 4, high: 16 });
  assert.deepEqual(e.usd, { low: 400, high: 1600 });
  assert.equal(classifyIssue(['Security']), 'security');
  assert.equal(classifyIssue(['bug', 'p1']), 'bug');
  assert.equal(classifyIssue(['enhancement']), 'other');
});

test('agent estimate uses reported usage exactly, else an assumption range, and adds human review/revert time', () => {
  const a = DEFAULT_COST_ASSUMPTIONS;
  const reported = estimateAgentIssue(
    issue({ origin: 'agent', reported_usage: { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_tokens: 0, model: 'claude-opus-5-5' } }),
    a,
    DEFAULT_PRICE_TABLE,
    0
  );
  assert.equal(reported.reported_usage, true);
  assert.equal(reported.agentic_usd.low, reported.agentic_usd.high, 'measured usage is a point value');
  assert.equal(reported.measured_usd, 6 + 10 * a.ci_minute_usd);
  assert.deepEqual(reported.human_hours, a.review_hours_per_round);

  const assumed = estimateAgentIssue(issue({ origin: 'agent', review_rounds: 2, reverted: true }), a, DEFAULT_PRICE_TABLE, 0);
  assert.equal(assumed.reported_usage, false);
  assert.ok(assumed.agentic_usd.low < assumed.agentic_usd.high, 'modeled usage is a range');
  assert.equal(assumed.measured_usd, 10 * a.ci_minute_usd, 'no token $ counted as measured');
  assert.deepEqual(assumed.human_hours, { low: 0.5 + 1, high: 2 + 4 });
  assert.ok(assumed.total_usd.low >= assumed.agentic_usd.low + assumed.human_usd.low - 1e-9);
});

// --- #2 / #5 report ---

function report(issues: readonly ResolvedIssueSample[], extra: Partial<Parameters<typeof buildEconomicsReport>[0]> = {}) {
  return buildEconomicsReport({
    repository: 'o/r',
    mode: 'github',
    now: NOW,
    windowDays: 30,
    issues,
    pulls: [
      { origin: 'agent', conventional_title: true, links_issue: true, attributed: true, touches_tests: true, ci_green_first_push: true },
      { origin: 'agent', conventional_title: false, links_issue: true, attributed: false, touches_tests: false, ci_green_first_push: null },
      { origin: 'human', conventional_title: true, links_issue: false, attributed: false, touches_tests: null, ci_green_first_push: false },
    ],
    assumptions: resolveCostAssumptions({ monthly_human_budget: 5000, monthly_agentic_budget: 50 }),
    readinessScore: 90,
    history: [],
    ...extra,
  });
}

test('economics report separates budgets, compares origins, and satisfies its invariants', () => {
  const r = report([
    issue({ number: 1, origin: 'human', issue_class: 'bug' }),
    issue({ number: 2, origin: 'agent', issue_class: 'other', review_rounds: 2 }),
    issue({ number: 3, origin: 'agent', issue_class: 'security', reverted: true }),
    issue({ number: 4, origin: 'human', closed_at: '2026-10-01T00:00:00Z' }), // previous month
  ]);
  assert.deepEqual(checkEconomicsInvariants(r), []);
  assert.equal(r.people.resolved, 2);
  assert.equal(r.agents.resolved, 2);
  assert.equal(r.budgets.human.budget, 5000);
  assert.equal(r.budgets.agentic.budget, 50);
  assert.equal(r.budgets.agentic.days_in_month, 30);
  assert.equal(r.budgets.human.measured_spent, null);
  assert.ok(r.budgets.human.spent.high > r.budgets.agentic.spent.high, 'human time dominates');
  assert.equal(r.quality.agents.revert_rate, 0.5);
  assert.equal(r.compliance.agents.prs, 2);
  assert.equal(r.compliance.agents.conventional_title, 0.5);
  assert.equal(r.compliance.agents.touches_tests, 0.5);
  assert.equal(r.compliance.agents.ci_green_first_push, 1, 'unknown CI is excluded from the share');
  assert.equal(r.compliance.people.attributed, null, 'attribution only applies to agent PRs');
  // Counterfactual prices every issue resolved this month as human work.
  assert.deepEqual(r.savings.all_human_counterfactual, { low: 200 + 100 + 400, high: 800 + 600 + 1600 });
  assert.equal(r.payoff.length, 1);
  assert.equal(r.payoff[0].date, '2026-11-20');
  assert.match(r.provenance.caveat, /Modeled/);
});

test('people-only months save nothing: their own work cancels out of savings', () => {
  const r = report([issue({ number: 1 }), issue({ number: 2, issue_class: 'security' })]);
  assert.deepEqual(r.savings.monthly_savings, { low: 0, high: 0 });
  assert.ok(r.savings.all_human_counterfactual.high > 0);
  assert.deepEqual(checkEconomicsInvariants(r), []);
});

test('economics report is valid against schemas/economics-v1.json and leaks no issue text', () => {
  const r = report([issue({ number: 7 })]);
  const schema: unknown = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'schemas', 'economics-v1.json'), 'utf8'));
  assert.deepEqual(validateJsonSchema(r, schema), []);
  const empty = report([]);
  assert.deepEqual(validateJsonSchema(empty, schema), []);
  assert.deepEqual(checkEconomicsInvariants(empty), []);
  assert.equal(empty.people.usd_per_issue, null);
});

test('pay-off history appends one point per day in date order', () => {
  const p = (date: string) => ({ date, readiness_score: 50, monthly_savings: { low: 0, high: 1 }, agent_change_failure_rate: null });
  const h = appendPayoffPoint([p('2026-11-01'), p('2026-11-03')], { ...p('2026-11-03'), readiness_score: 99 });
  assert.deepEqual(h.map((x) => x.date), ['2026-11-01', '2026-11-03']);
  assert.equal(h[1].readiness_score, 99);
  assert.equal(appendPayoffPoint(Array.from({ length: 5 }, (_, i) => p(`2026-01-0${i + 1}`)), p('2026-02-01'), 3).length, 3);
});

test('canary: invariants catch inconsistent savings and out-of-range shares', () => {
  const r = report([issue({ origin: 'agent' })]);
  const broken = {
    ...r,
    savings: { ...r.savings, monthly_savings: { low: 1e9, high: 1e9 } },
    quality: { ...r.quality, agents: { ...r.quality.agents, revert_rate: 1.5 } },
  };
  const errors = checkEconomicsInvariants(broken).join('\n');
  assert.match(errors, /savings do not equal/);
  assert.match(errors, /revert_rate out of \[0,1\]/);
});

test('isConventionalTitle follows AGENTS.md commit conventions', () => {
  assert.equal(isConventionalTitle('feat: add dials'), true);
  assert.equal(isConventionalTitle('fix(cli)!: break'), true);
  assert.equal(isConventionalTitle('Update README'), false);
});

// --- adapters ---

function client(routes: Readonly<Record<string, unknown>>): GitHubClient {
  const restWithStatus = async (endpoint: string): Promise<GitHubRestResponse> => {
    const key = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((k) => endpoint.includes(k));
    return key ? { status: 200, ok: true, data: routes[key] } : { status: 404, ok: false, data: null };
  };
  return { restWithStatus, async rest(e: string) { return (await restWithStatus(e)).data; } };
}

const pr = (n: number, extra: Partial<MergedPullRecord> = {}): MergedPullRecord => ({
  number: n,
  origin: 'agent',
  title: `fix: thing ${n}`,
  text: `Fixes #${n * 10}\n\nAgent-Usage: model=claude-opus-5-5 input_tokens=100000 output_tokens=1000 run_minutes=7\nCo-Authored-By: Claude <noreply@anthropic.com>`,
  createdAt: '2026-11-10T06:00:00Z',
  mergedAt: '2026-11-10T10:00:00Z',
  closes: [n * 10],
  ...extra,
});

test('economics collector measures reviews, reverts, reopens, CI minutes, first-push CI, tests, and usage', async () => {
  const samples = await collectEconomicsSamples(
    client({
      '/actions/runs': {
        workflow_runs: [
          { head_sha: 'a', run_started_at: '2026-11-10T06:00:00Z', updated_at: '2026-11-10T06:10:00Z', conclusion: 'failure', pull_requests: [{ number: 1 }] },
          { head_sha: 'b', run_started_at: '2026-11-10T07:00:00Z', updated_at: '2026-11-10T07:05:00Z', conclusion: 'success', pull_requests: [{ number: 1 }] },
          { head_sha: 'c', run_started_at: '2026-11-10T06:00:00Z', updated_at: '2026-11-10T06:04:00Z', conclusion: 'success', pull_requests: [{ number: 2 }] },
        ],
      },
      '/issues/events': [{ event: 'reopened', issue: { number: 10 } }, { event: 'closed', issue: { number: 20 } }],
      '/pulls/1/reviews': [{ state: 'CHANGES_REQUESTED' }, { state: 'APPROVED' }, { state: 'PENDING' }],
      '/pulls/1/files': [{ filename: 'src/a.ts' }, { filename: 'tests/unit/a.test.ts' }],
      '/pulls/2/reviews': [{ state: 'APPROVED' }],
      '/pulls/2/files': [{ filename: 'README.md' }],
      '/pulls/3/reviews': [],
      '/pulls/3/files': [],
    }),
    'o/r',
    [
      pr(1),
      pr(2, { origin: 'human', title: 'Update docs', text: 'Fixes #20' }),
      pr(3, { title: 'Revert "fix: thing 1"', text: 'Reverts o/r#1', closes: [] }),
    ],
    [
      { number: 10, labels: ['bug'], createdAt: '2026-11-10T00:00:00Z', closedAt: '2026-11-10T12:00:00Z', stateReason: 'completed', origin: 'agent-assisted' },
      { number: 20, labels: [], createdAt: '2026-11-09T00:00:00Z', closedAt: '2026-11-11T00:00:00Z', stateReason: 'completed', origin: 'human' },
      { number: 30, labels: [], createdAt: '2026-11-09T00:00:00Z', closedAt: '2026-11-11T00:00:00Z', stateReason: 'not_planned', origin: 'human' },
    ]
  );
  assert.equal(samples.issues.length, 2, 'not-planned closures are not resolutions');
  const [i10, i20] = samples.issues;
  assert.equal(i10.origin, 'agent');
  assert.equal(i10.issue_class, 'bug');
  assert.equal(i10.review_rounds, 2);
  assert.equal(i10.reverted, true);
  assert.equal(i10.reopened, true);
  assert.equal(i10.ci_minutes, 15);
  assert.equal(i10.hours_to_first_pr, 6);
  assert.equal(i10.hours_to_merge, 4);
  assert.equal(i10.agent_run_minutes, 7);
  assert.equal(i10.reported_usage?.input_tokens, 100000);
  assert.equal(i20.origin, 'human');
  assert.equal(i20.reported_usage, null);

  const [p1, p2] = samples.pulls;
  assert.equal(p1.ci_green_first_push, false, 'first push failed even though a later push passed');
  assert.equal(p1.touches_tests, true);
  assert.equal(p1.attributed, true);
  assert.equal(p2.ci_green_first_push, true);
  assert.equal(p2.conventional_title, false);
  assert.equal(p2.touches_tests, false);
  assert.equal(JSON.stringify(samples).includes('Agent-Usage'), false, 'no PR text in samples');
});

test('revertedPullNumbers reads GitHub revert PRs', () => {
  assert.deepEqual([...revertedPullNumbers([pr(5, { title: 'Revert "x"', text: 'Reverts owner/repo#4\nReverts #2' })])], [4, 2]);
  assert.deepEqual([...revertedPullNumbers([pr(6, { text: 'Reverts #4' })])], [], 'only Revert PRs count');
});

test('pay-off history loads from the Pages site and tolerates missing or invalid data', async () => {
  const pages = client({ '/pages': { html_url: 'https://o.github.io/r/' } });
  const point = { date: '2026-11-01', readiness_score: 80, monthly_savings: { low: 1, high: 2 }, agent_change_failure_rate: 0 };
  const ok = await loadPayoffHistory(pages, 'o/r', async (url) => {
    assert.equal(String(url), 'https://o.github.io/r/data/economics.json');
    return new Response(JSON.stringify({ payoff: [point, { date: 'bad' }] }), { status: 200 });
  });
  assert.deepEqual(ok, [point]);
  assert.deepEqual(await loadPayoffHistory(pages, 'o/r', async () => new Response('', { status: 404 })), []);
  assert.deepEqual(await loadPayoffHistory(client({}), 'o/r'), []);
});
