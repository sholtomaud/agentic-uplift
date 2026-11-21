/**
 * Cryptographic Proof-Lock, Changelog Attestation, and Verification Report contracts.
 * Layer 0 (`src/shared/`).
 */
import { isBoolean, isFiniteNumber, isRecord, isString } from './contracts.ts';

export type ProofLockZone = 'harness' | 'tests';

export interface LockedFileEntry {
  readonly path: string;
  readonly zone: ProofLockZone;
  readonly sha256: string;
}

export interface MetricFloors {
  readonly minUnitTests: number;
  readonly minPropertyTests: number;
  readonly minArchRules: number;
  readonly maxSkippedTests: number;
}

export interface ProofLockfile {
  readonly schemaVersion: 1;
  readonly rootSha256: string;
  readonly metricFloors: MetricFloors;
  readonly files: readonly LockedFileEntry[];
}

export type TamperViolationCode =
  | 'invalid-lockfile'
  | 'missing-lockfile'
  | 'root-hash-mismatch'
  | 'modified-harness-file'
  | 'deleted-harness-file'
  | 'modified-test-file'
  | 'deleted-test-file'
  | 'weakened-test-directive'
  | 'metric-floor-regression'
  | 'skip-ceiling-exceeded'
  | 'broken-changelog-chain';

export interface TamperViolation {
  readonly code: TamperViolationCode;
  readonly path: string;
  readonly message: string;
}

export interface ObservedMetrics {
  readonly unitTests: number;
  readonly propertyTests: number;
  readonly archRules: number;
  readonly skippedTests: number;
}

export interface ProofChangelogEntry {
  readonly commit: string;
  readonly timestamp: string;
  readonly rootSha256: string;
  readonly summary: string;
  readonly verdict: string;
  readonly previousAttestation: string;
  readonly attestationSha256: string;
}

export interface ChangelogVerificationResult {
  readonly valid: boolean;
  readonly entries: readonly ProofChangelogEntry[];
  readonly headAttestation: string | null;
  readonly errors: readonly string[];
}

export interface ProofVerificationReport {
  readonly schema_version: 1;
  readonly checked_at: string;
  readonly ok: boolean;
  readonly source: string;
  readonly root_sha256: string | null;
  readonly locked_files: number;
  readonly harness_files: number;
  readonly test_files: number;
  readonly metric_floors: MetricFloors | null;
  readonly added_test_files: readonly string[];
  readonly authorized_changes: readonly string[];
  readonly violations: readonly TamperViolation[];
  readonly changelog: {
    readonly valid: boolean;
    readonly count: number;
    readonly head_attestation: string | null;
    readonly errors: readonly string[];
  };
}

export function isLockedFileEntry(value: unknown): value is LockedFileEntry {
  if (!isRecord(value)) return false;
  return (
    isString(value.path) &&
    (value.zone === 'harness' || value.zone === 'tests') &&
    isString(value.sha256) &&
    value.sha256.length === 64
  );
}

export function isMetricFloors(value: unknown): value is MetricFloors {
  if (!isRecord(value)) return false;
  return (
    isFiniteNumber(value.minUnitTests) &&
    isFiniteNumber(value.minPropertyTests) &&
    isFiniteNumber(value.minArchRules) &&
    isFiniteNumber(value.maxSkippedTests)
  );
}

export function isProofLockfile(value: unknown): value is ProofLockfile {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === 1 &&
    isString(value.rootSha256) &&
    value.rootSha256.length === 64 &&
    isMetricFloors(value.metricFloors) &&
    Array.isArray(value.files) &&
    value.files.every(isLockedFileEntry)
  );
}

export function isProofVerificationOk(value: unknown): boolean {
  return isRecord(value) && isBoolean(value.ok) && value.ok;
}
