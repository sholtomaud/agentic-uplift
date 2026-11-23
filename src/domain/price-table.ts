/**
 * Dated, sourced LLM / coding-agent price table (#3).
 * Bump `PRICE_TABLE_VERSION` and each entry's `effective` date whenever a
 * price is re-read from its source. Negotiated or enterprise rates belong in
 * `uplift.config.json` → `costs.priceOverrides`, never here.
 * Layer 1 (`src/domain/`): pure, zero Node/DOM imports.
 */
import type {
  CostAssumptions,
  PriceEntry,
  PriceTable,
  SeatPriceEntry,
  TokenPriceEntry,
  TokenUsage,
} from '../shared/economics-types.ts';

export const PRICE_TABLE_VERSION = '2026-11-23';

const ANTHROPIC_SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing';
const GOOGLE_SOURCE = 'https://ai.google.dev/gemini-api/docs/pricing';
const COPILOT_SOURCE = 'https://docs.github.com/en/copilot/get-started/plans';

function anthropic(
  model: string,
  input: number,
  output: number,
  cacheRead: number | null
): TokenPriceEntry {
  return {
    model,
    provider: 'anthropic',
    kind: 'per-token',
    input_per_mtok: input,
    output_per_mtok: output,
    cache_read_per_mtok: cacheRead,
    source: ANTHROPIC_SOURCE,
    effective: '2026-11-03',
  };
}

function gemini(
  model: string,
  input: number,
  output: number,
  cacheRead: number
): TokenPriceEntry {
  return {
    model,
    provider: 'google',
    kind: 'per-token',
    input_per_mtok: input,
    output_per_mtok: output,
    cache_read_per_mtok: cacheRead,
    source: GOOGLE_SOURCE,
    effective: '2026-11-23',
  };
}

function copilot(model: string, seat: number, credits: number): SeatPriceEntry {
  return {
    model,
    provider: 'github',
    kind: 'per-seat',
    seat_per_month: seat,
    included_credits_per_seat: credits,
    credit_usd: 0.01,
    source: COPILOT_SOURCE,
    effective: '2026-11-23',
  };
}

/**
 * Standard first-party list prices. Gemini figures are the ≤200k-token prompt
 * tier; Copilot is per-seat with included AI credits ($0.01 each beyond).
 */
export const DEFAULT_PRICE_TABLE: PriceTable = {
  version: PRICE_TABLE_VERSION,
  entries: [
    anthropic('claude-fable-5-2', 8, 40, 0.2),
    anthropic('claude-opus-5-5', 4, 20, 0.2),
    anthropic('claude-opus-5', 5, 25, null),
    anthropic('claude-sonnet-5-5', 2, 10, 0.1),
    anthropic('claude-sonnet-5', 2, 10, null),
    anthropic('claude-haiku-5-5', 0.1, 0.5, null),
    gemini('gemini-3.5-flash', 1.5, 9, 0.15),
    gemini('gemini-3.1-pro-preview', 2, 12, 0.2),
    gemini('gemini-3-flash-preview', 0.5, 3, 0.05),
    gemini('gemini-2.5-pro', 1.25, 10, 0.125),
    gemini('gemini-2.5-flash', 0.3, 2.5, 0.03),
    copilot('copilot-pro', 10, 1500),
    copilot('copilot-pro-plus', 39, 7000),
    copilot('copilot-business', 19, 1900),
    copilot('copilot-enterprise', 39, 3900),
  ],
};

/** Applies negotiated overrides on top of list prices (overrides win field by field). */
export function applyPriceOverrides(
  table: PriceTable,
  overrides: CostAssumptions['price_overrides']
): PriceTable {
  return {
    version: table.version,
    entries: table.entries.map((entry): PriceEntry => {
      const o = overrides[entry.model];
      if (!o || entry.kind !== 'per-token') return entry;
      return {
        ...entry,
        input_per_mtok: o.input_per_mtok ?? entry.input_per_mtok,
        output_per_mtok: o.output_per_mtok ?? entry.output_per_mtok,
        cache_read_per_mtok: o.cache_read_per_mtok ?? entry.cache_read_per_mtok,
        source: `${entry.source} (overridden in uplift.config.json)`,
      };
    }),
  };
}

export function findTokenPrice(
  table: PriceTable,
  model: string
): TokenPriceEntry | null {
  const normalized = model.trim().toLowerCase();
  for (const entry of table.entries) {
    if (entry.kind === 'per-token' && entry.model === normalized) return entry;
  }
  return null;
}

export function findSeatPrice(
  table: PriceTable,
  plan: string
): SeatPriceEntry | null {
  for (const entry of table.entries) {
    if (entry.kind === 'per-seat' && entry.model === plan) return entry;
  }
  return null;
}

/** USD for a token usage at a per-token price; cache reads fall back to input price. */
export function tokenCostUsd(price: TokenPriceEntry, usage: TokenUsage): number {
  const cacheRate = price.cache_read_per_mtok ?? price.input_per_mtok;
  return (
    (usage.input_tokens * price.input_per_mtok +
      usage.output_tokens * price.output_per_mtok +
      usage.cache_read_tokens * cacheRate) /
    1_000_000
  );
}

/** Formal invariants for any price table. */
export function checkPriceTableInvariants(table: PriceTable): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(table.version)) {
    errors.push(`Price table version is not an ISO date: ${table.version}`);
  }
  for (const e of table.entries) {
    if (seen.has(e.model)) errors.push(`Duplicate price entry: ${e.model}`);
    seen.add(e.model);
    if (!/^https:\/\//.test(e.source)) errors.push(`${e.model}: source must be an https URL`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.effective)) errors.push(`${e.model}: effective date missing`);
    if (e.kind === 'per-token') {
      if (e.input_per_mtok < 0 || e.output_per_mtok < 0) errors.push(`${e.model}: negative price`);
      if (e.cache_read_per_mtok !== null && e.cache_read_per_mtok > e.input_per_mtok) {
        errors.push(`${e.model}: cache reads priced above uncached input`);
      }
    } else if (e.seat_per_month < 0 || e.credit_usd < 0 || e.included_credits_per_seat < 0) {
      errors.push(`${e.model}: negative seat pricing`);
    }
  }
  return errors;
}
