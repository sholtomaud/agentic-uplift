/**
 * Pure runtime type guards and JSON value contracts.
 * Layer 0 (`src/shared/`): zero imports outside `src/shared/`, zero Node/DOM globals.
 */

export const SCHEMA_VERSION = 1 as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}
export type JsonArray = readonly JsonValue[];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

export function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export interface UpliftConfig {
  readonly schemaVersion: 1;
  readonly projectName: string;
  readonly proofLock: {
    readonly harnessPaths: readonly string[];
    readonly testRoots: readonly string[];
    readonly testFilePatterns: readonly string[];
  };
  readonly limits: {
    readonly securityDays: number;
    readonly bugDays: number;
    readonly featureDays: number;
  };
  readonly gate: {
    readonly maxOpenAgentPrs: number;
    readonly requireProofSeal: boolean;
  };
}

export function isUpliftConfig(value: unknown): value is UpliftConfig {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== 1 || !isString(value.projectName)) return false;
  if (!isRecord(value.proofLock)) return false;
  if (
    !isStringArray(value.proofLock.harnessPaths) ||
    !isStringArray(value.proofLock.testRoots) ||
    !isStringArray(value.proofLock.testFilePatterns)
  ) {
    return false;
  }
  if (!isRecord(value.limits)) return false;
  if (
    !isFiniteNumber(value.limits.securityDays) ||
    !isFiniteNumber(value.limits.bugDays) ||
    !isFiniteNumber(value.limits.featureDays)
  ) {
    return false;
  }
  if (!isRecord(value.gate)) return false;
  if (
    !isFiniteNumber(value.gate.maxOpenAgentPrs) ||
    !isBoolean(value.gate.requireProofSeal)
  ) {
    return false;
  }
  return true;
}
