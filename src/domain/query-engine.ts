/**
 * First-class zero-dependency JSON Query Engine for Agentic Clients.
 * Supports dot paths, numeric indexing, wildcard projection, predicate filters
 * (`[key=value,other!=val]`), and `.count` / `.length` aggregates.
 * Layer 1 (`src/domain/`): zero Node/DOM imports.
 */
import { isRecord, type JsonValue } from '../shared/contracts.ts';
import type { AgentQueryResult } from '../shared/status-types.ts';

interface Predicate {
  readonly key: string;
  readonly operator: '=' | '!=';
  readonly expected: string;
}

type PathSegment =
  | { readonly kind: 'prop'; readonly name: string }
  | { readonly kind: 'index'; readonly index: number }
  | { readonly kind: 'wildcard' }
  | { readonly kind: 'filter'; readonly predicates: readonly Predicate[] };

function parsePredicates(raw: string): Predicate[] {
  const parts = raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const predicates: Predicate[] = [];
  for (const part of parts) {
    const neqIdx = part.indexOf('!=');
    if (neqIdx !== -1) {
      predicates.push({
        key: part.slice(0, neqIdx).trim(),
        operator: '!=',
        expected: stripQuotes(part.slice(neqIdx + 2).trim()),
      });
      continue;
    }
    const eqIdx = part.indexOf('=');
    if (eqIdx !== -1) {
      predicates.push({
        key: part.slice(0, eqIdx).trim(),
        operator: '=',
        expected: stripQuotes(part.slice(eqIdx + 1).trim()),
      });
    }
  }
  return predicates;
}

function stripQuotes(text: string): string {
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

export function parseQueryPath(expr: string): PathSegment[] {
  const cleaned = expr.trim().replace(/^\$\.?/, '');
  if (!cleaned) return [];
  const segments: PathSegment[] = [];
  let i = 0;
  let token = '';

  const flushProp = (): void => {
    const name = token.trim();
    if (name) {
      segments.push({ kind: 'prop', name });
    }
    token = '';
  };

  while (i < cleaned.length) {
    const ch = cleaned[i];
    if (ch === '.') {
      flushProp();
      i += 1;
      continue;
    }
    if (ch === '[') {
      flushProp();
      const close = cleaned.indexOf(']', i + 1);
      if (close === -1) break;
      const inner = cleaned.slice(i + 1, close).trim();
      if (inner === '*') {
        segments.push({ kind: 'wildcard' });
      } else if (/^\d+$/.test(inner)) {
        segments.push({ kind: 'index', index: Number.parseInt(inner, 10) });
      } else {
        segments.push({ kind: 'filter', predicates: parsePredicates(inner) });
      }
      i = close + 1;
      continue;
    }
    token += ch;
    i += 1;
  }
  flushProp();
  return segments;
}

function valueToComparableString(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return String(value);
  }
  return JSON.stringify(value);
}

function matchesPredicates(
  item: unknown,
  predicates: readonly Predicate[]
): boolean {
  if (!isRecord(item)) return false;
  for (const pred of predicates) {
    const actual = valueToComparableString(item[pred.key]);
    if (pred.operator === '=' && actual !== pred.expected) return false;
    if (pred.operator === '!=' && actual === pred.expected) return false;
  }
  return true;
}

function toJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(toJsonValue);
  }
  if (isRecord(value)) {
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) {
        out[k] = toJsonValue(v);
      }
    }
    return out;
  }
  return null;
}

function applySegment(
  current: unknown,
  segment: PathSegment
): { readonly found: boolean; readonly value: unknown } {
  if (current === undefined || current === null) {
    return { found: false, value: null };
  }

  if (segment.kind === 'prop') {
    if (
      Array.isArray(current) &&
      (segment.name === 'length' || segment.name === 'count')
    ) {
      return { found: true, value: current.length };
    }
    if (Array.isArray(current)) {
      // Auto-project property across arrays for ergonomic agentic queries
      // e.g., `audit.checks[status=missing].id`
      const projected = current
        .map((item) => (isRecord(item) ? item[segment.name] : undefined))
        .filter((v) => v !== undefined);
      return { found: projected.length > 0, value: projected };
    }
    if (isRecord(current) && segment.name in current) {
      return { found: true, value: current[segment.name] };
    }
    return { found: false, value: null };
  }

  if (segment.kind === 'index') {
    if (Array.isArray(current) && segment.index < current.length) {
      return { found: true, value: current[segment.index] };
    }
    return { found: false, value: null };
  }

  if (segment.kind === 'wildcard') {
    if (Array.isArray(current)) {
      return { found: true, value: current };
    }
    if (isRecord(current)) {
      return { found: true, value: Object.values(current) };
    }
    return { found: false, value: null };
  }

  if (segment.kind === 'filter') {
    if (!Array.isArray(current)) {
      return { found: false, value: null };
    }
    const filtered = current.filter((item) =>
      matchesPredicates(item, segment.predicates)
    );
    return { found: true, value: filtered };
  }

  return { found: false, value: null };
}

/**
 * Evaluates a structured query expression against any JSON-serializable state
 * bundle (e.g., `{ status, audit, proof, gate }`).
 */
export function runAgentQuery(
  data: unknown,
  expression: string
): AgentQueryResult {
  const segments = parseQueryPath(expression);
  if (segments.length === 0) {
    return {
      schema_version: 1,
      query: expression,
      found: data !== undefined,
      value: toJsonValue(data),
    };
  }

  let current: unknown = data;
  for (const segment of segments) {
    const step = applySegment(current, segment);
    if (!step.found) {
      return {
        schema_version: 1,
        query: expression,
        found: false,
        value: null,
      };
    }
    current = step.value;
  }

  return {
    schema_version: 1,
    query: expression,
    found: true,
    value: toJsonValue(current),
  };
}

/** Explicit invariant checker for AgentQueryResult. */
export function checkQueryInvariants(result: AgentQueryResult): string[] {
  const errors: string[] = [];
  if (result.schema_version !== 1) {
    errors.push('Query result schema_version must be 1');
  }
  if (!result.found && result.value !== null) {
    errors.push('When found=false, value must be null');
  }
  return errors;
}
