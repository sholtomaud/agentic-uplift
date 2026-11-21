/**
 * Pure cryptographic proof-lock, multi-language test-weakening, metric-floor,
 * and hash-chained changelog verification engine.
 * Layer 1 (`src/domain/`): zero Node/DOM imports; accepts `HashFn` via dependency injection.
 */
import type {
  ChangelogVerificationResult,
  LockedFileEntry,
  MetricFloors,
  ObservedMetrics,
  ProofChangelogEntry,
  ProofLockfile,
  TamperViolation,
} from '../shared/proof-types.ts';

export type HashFn = (text: string) => string;

export const GENESIS_ATTESTATION =
  '0000000000000000000000000000000000000000000000000000000000000000';

export interface FileSnapshot {
  readonly path: string;
  readonly content: string;
  readonly sha256: string;
}

export interface LockVerificationInput {
  readonly lock: ProofLockfile;
  readonly lockedFileHashes: ReadonlyMap<string, string | null>;
  readonly currentTestFiles: readonly {
    readonly path: string;
    readonly content: string;
  }[];
  readonly allowTestChange?: boolean;
  readonly allowHarnessChange?: boolean;
  readonly observedMetrics?: ObservedMetrics;
}

export interface LockVerificationResult {
  readonly ok: boolean;
  readonly rootSha256: string;
  readonly violations: readonly TamperViolation[];
  readonly addedTestFiles: readonly string[];
  readonly authorizedChanges: readonly string[];
}

export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

export function computeRootSha256(
  files: readonly LockedFileEntry[],
  metricFloors: MetricFloors,
  hashFn: HashFn
): string {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const payload = [
    ...sorted.map((f) => `${f.zone}:${f.path}:${f.sha256}`),
    `floors:${JSON.stringify({
      minUnitTests: metricFloors.minUnitTests,
      minPropertyTests: metricFloors.minPropertyTests,
      minArchRules: metricFloors.minArchRules,
      maxSkippedTests: metricFloors.maxSkippedTests,
    })}`,
  ].join('\n');
  return hashFn(normalizeLineEndings(payload));
}

export function buildProofLockfile(
  files: readonly LockedFileEntry[],
  metricFloors: MetricFloors,
  hashFn: HashFn
): ProofLockfile {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  return {
    schemaVersion: 1,
    rootSha256: computeRootSha256(sorted, metricFloors, hashFn),
    metricFloors,
    files: sorted,
  };
}

/**
 * Multi-language test-weakening directives (JS/TS, Python, Go, Rust).
 * Prevents agents from silencing tests via `.only`, `.skip`, `#[ignore]`, etc.
 */
const WEAKENING_PATTERNS: readonly {
  readonly name: string;
  readonly extensions: readonly string[];
  readonly regex: RegExp;
}[] = [
  {
    name: 'focused JS/TS test (.only)',
    extensions: ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.tsx', '.jsx'],
    regex: /\b(?:test|it|describe)\.only\s*\(/,
  },
  {
    name: 'skipped JS/TS test (.skip / xit / xdescribe)',
    extensions: ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.tsx', '.jsx'],
    regex:
      /(?:\b(?:test|it|describe)\.skip\s*\(\s*['"`]|\b(?:xit|xdescribe|xtest)\s*\()/,
  },
  {
    name: 'skipped Python test (@pytest.mark.skip / @unittest.skip)',
    extensions: ['.py'],
    regex: /@(?:pytest\.mark\.skip|unittest\.skip)\b/,
  },
  {
    name: 'skipped Go test (t.Skip)',
    extensions: ['.go'],
    regex: /\b[tb]\.Skip(?:f|Now)?\s*\(/,
  },
  {
    name: 'ignored Rust test (#[ignore])',
    extensions: ['.rs'],
    regex: /#\[\s*ignore(?:\s*=|\s*\])/,
  },
];

function matchesExtension(
  filePath: string,
  extensions: readonly string[]
): boolean {
  return extensions.some((ext) => filePath.endsWith(ext));
}

function stripLineComment(line: string, filePath: string): string {
  if (filePath.endsWith('.py')) {
    return line.replace(/#.*$/, '');
  }
  return line.replace(/(^|[^:\\])\/\/.*$/, '$1');
}

export function scanWeakeningDirectives(
  testFiles: readonly { readonly path: string; readonly content: string }[]
): TamperViolation[] {
  const violations: TamperViolation[] = [];
  for (const file of testFiles) {
    const applicable = WEAKENING_PATTERNS.filter((p) =>
      matchesExtension(file.path, p.extensions)
    );
    if (applicable.length === 0) continue;
    const lines = normalizeLineEndings(file.content).split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const code = stripLineComment(lines[i], file.path);
      for (const pattern of applicable) {
        if (pattern.regex.test(code)) {
          violations.push({
            code: 'weakened-test-directive',
            path: `${file.path}:${i + 1}`,
            message: `Detected ${pattern.name}. Unsupervised edits may not skip or focus tests to bypass verification.`,
          });
        }
      }
    }
  }
  return violations;
}

export function verifyMetricsAgainstFloors(
  metrics: ObservedMetrics,
  floors: MetricFloors
): TamperViolation[] {
  const violations: TamperViolation[] = [];
  if (metrics.unitTests < floors.minUnitTests) {
    violations.push({
      code: 'metric-floor-regression',
      path: 'metricFloors.minUnitTests',
      message: `Unit test count regressed: observed ${metrics.unitTests} < locked floor ${floors.minUnitTests}.`,
    });
  }
  if (metrics.propertyTests < floors.minPropertyTests) {
    violations.push({
      code: 'metric-floor-regression',
      path: 'metricFloors.minPropertyTests',
      message: `Property test count regressed: observed ${metrics.propertyTests} < locked floor ${floors.minPropertyTests}.`,
    });
  }
  if (metrics.archRules < floors.minArchRules) {
    violations.push({
      code: 'metric-floor-regression',
      path: 'metricFloors.minArchRules',
      message: `Architecture rule count regressed: observed ${metrics.archRules} < locked floor ${floors.minArchRules}.`,
    });
  }
  if (metrics.skippedTests > floors.maxSkippedTests) {
    violations.push({
      code: 'skip-ceiling-exceeded',
      path: 'metricFloors.maxSkippedTests',
      message: `Skipped tests exceeded ceiling: observed ${metrics.skippedTests} > locked max ${floors.maxSkippedTests}.`,
    });
  }
  return violations;
}

export function verifyFloorRatchet(
  baseFloors: MetricFloors,
  headFloors: MetricFloors
): TamperViolation[] {
  const violations: TamperViolation[] = [];
  if (headFloors.minUnitTests < baseFloors.minUnitTests) {
    violations.push({
      code: 'metric-floor-regression',
      path: 'proof-lock.json#metricFloors.minUnitTests',
      message: `PR lowered minUnitTests floor from ${baseFloors.minUnitTests} to ${headFloors.minUnitTests}.`,
    });
  }
  if (headFloors.minPropertyTests < baseFloors.minPropertyTests) {
    violations.push({
      code: 'metric-floor-regression',
      path: 'proof-lock.json#metricFloors.minPropertyTests',
      message: `PR lowered minPropertyTests floor from ${baseFloors.minPropertyTests} to ${headFloors.minPropertyTests}.`,
    });
  }
  if (headFloors.minArchRules < baseFloors.minArchRules) {
    violations.push({
      code: 'metric-floor-regression',
      path: 'proof-lock.json#metricFloors.minArchRules',
      message: `PR lowered minArchRules floor from ${baseFloors.minArchRules} to ${headFloors.minArchRules}.`,
    });
  }
  if (headFloors.maxSkippedTests > baseFloors.maxSkippedTests) {
    violations.push({
      code: 'skip-ceiling-exceeded',
      path: 'proof-lock.json#metricFloors.maxSkippedTests',
      message: `PR raised maxSkippedTests ceiling from ${baseFloors.maxSkippedTests} to ${headFloors.maxSkippedTests}.`,
    });
  }
  return violations;
}

export function verifySnapshotAgainstLock(
  input: LockVerificationInput,
  hashFn: HashFn
): LockVerificationResult {
  const violations: TamperViolation[] = [];
  const authorizedChanges: string[] = [];
  const { lock } = input;

  const expectedRoot = computeRootSha256(
    lock.files,
    lock.metricFloors,
    hashFn
  );
  if (expectedRoot !== lock.rootSha256) {
    violations.push({
      code: 'root-hash-mismatch',
      path: 'proof-lock.json',
      message: `Lockfile rootSha256 mismatch (expected ${expectedRoot}, found ${lock.rootSha256}).`,
    });
  }

  const lockedPaths = new Set<string>();
  for (const entry of lock.files) {
    lockedPaths.add(entry.path);
    const actualHash = input.lockedFileHashes.get(entry.path) ?? null;

    if (actualHash === null) {
      if (entry.zone === 'tests' && input.allowTestChange) {
        authorizedChanges.push(`deleted test (authorized): ${entry.path}`);
      } else if (entry.zone === 'harness' && input.allowHarnessChange) {
        authorizedChanges.push(`deleted harness (authorized): ${entry.path}`);
      } else {
        violations.push({
          code:
            entry.zone === 'harness'
              ? 'deleted-harness-file'
              : 'deleted-test-file',
          path: entry.path,
          message:
            entry.zone === 'harness'
              ? `Locked harness file "${entry.path}" was deleted. Requires maintainer review + "allow-harness-change" PR label.`
              : `Locked test file "${entry.path}" was deleted. Agents may not delete existing tests; requires "allow-test-change" PR label.`,
        });
      }
      continue;
    }

    if (actualHash !== entry.sha256) {
      if (entry.zone === 'tests' && input.allowTestChange) {
        authorizedChanges.push(`modified test (authorized): ${entry.path}`);
      } else if (entry.zone === 'harness' && input.allowHarnessChange) {
        authorizedChanges.push(`modified harness (authorized): ${entry.path}`);
      } else {
        violations.push({
          code:
            entry.zone === 'harness'
              ? 'modified-harness-file'
              : 'modified-test-file',
          path: entry.path,
          message:
            entry.zone === 'harness'
              ? `Locked harness file "${entry.path}" was modified (expected ${entry.sha256.slice(0, 12)}, got ${actualHash.slice(0, 12)}). Requires "allow-harness-change" PR label.`
              : `Locked test file "${entry.path}" was modified (expected ${entry.sha256.slice(0, 12)}, got ${actualHash.slice(0, 12)}). Fix the implementation or request "allow-test-change" PR label.`,
        });
      }
    }
  }

  const addedTestFiles = input.currentTestFiles
    .map((f) => f.path)
    .filter((p) => !lockedPaths.has(p))
    .sort();

  violations.push(...scanWeakeningDirectives(input.currentTestFiles));

  if (input.observedMetrics) {
    violations.push(
      ...verifyMetricsAgainstFloors(input.observedMetrics, lock.metricFloors)
    );
  }

  return {
    ok: violations.length === 0,
    rootSha256: lock.rootSha256,
    violations,
    addedTestFiles,
    authorizedChanges,
  };
}

export function computeAttestationSha256(
  fields: Omit<ProofChangelogEntry, 'attestationSha256'>,
  hashFn: HashFn
): string {
  const canonical = JSON.stringify({
    commit: fields.commit,
    timestamp: fields.timestamp,
    rootSha256: fields.rootSha256,
    summary: fields.summary,
    verdict: fields.verdict,
    previousAttestation: fields.previousAttestation,
  });
  return hashFn(canonical);
}

export function createChangelogEntry(
  fields: Omit<ProofChangelogEntry, 'attestationSha256'>,
  hashFn: HashFn
): ProofChangelogEntry {
  return {
    ...fields,
    attestationSha256: computeAttestationSha256(fields, hashFn),
  };
}

export function formatProofChangelogMarkdown(
  entries: readonly ProofChangelogEntry[]
): string {
  const lines: string[] = [
    '# Proof Attestation Changelog',
    '',
    'Append-only cryptographic proof ledger. Each entry chains its `attestationSha256` to the previous entry so editing or removing historical proof records breaks the chain.',
    '',
  ];
  for (const entry of entries) {
    lines.push(
      `## ${entry.timestamp} — \`${entry.commit}\` (${entry.verdict})`,
      '',
      `- **Commit:** \`${entry.commit}\``,
      `- **Timestamp:** \`${entry.timestamp}\``,
      `- **Proof Lock Root SHA-256:** \`${entry.rootSha256}\``,
      `- **Verdict:** \`${entry.verdict}\``,
      `- **Summary:** ${entry.summary}`,
      `- **Previous Attestation:** \`${entry.previousAttestation}\``,
      `- **Attestation SHA-256:** \`${entry.attestationSha256}\``,
      ''
    );
  }
  return lines.join('\n');
}

export function parseProofChangelogMarkdown(
  markdown: string
): ProofChangelogEntry[] {
  const sections = normalizeLineEndings(markdown)
    .split(/\n(?=## )/)
    .slice(1);
  const entries: ProofChangelogEntry[] = [];

  for (const section of sections) {
    const readCode = (label: string): string => {
      const match = section.match(
        new RegExp(`- \\*\\*${label}:\\*\\* \`([^\`]+)\``)
      );
      return match ? match[1].trim() : '';
    };
    const summaryMatch = section.match(/- \*\*Summary:\*\* (.+)/);
    const entry: ProofChangelogEntry = {
      commit: readCode('Commit'),
      timestamp: readCode('Timestamp'),
      rootSha256: readCode('Proof Lock Root SHA-256'),
      verdict: readCode('Verdict'),
      summary: summaryMatch ? summaryMatch[1].trim() : '',
      previousAttestation: readCode('Previous Attestation'),
      attestationSha256: readCode('Attestation SHA-256'),
    };
    if (entry.commit && entry.attestationSha256) {
      entries.push(entry);
    }
  }
  return entries;
}

export function verifyProofChangelogMarkdown(
  markdown: string,
  hashFn: HashFn
): ChangelogVerificationResult {
  const entries = parseProofChangelogMarkdown(markdown);
  const errors: string[] = [];

  let expectedPrevious = GENESIS_ATTESTATION;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry.previousAttestation !== expectedPrevious) {
      errors.push(
        `Entry #${i + 1} (${entry.commit}) broken chain: expected previousAttestation ${expectedPrevious}, found ${entry.previousAttestation}`
      );
    }
    const recomputed = computeAttestationSha256(
      {
        commit: entry.commit,
        timestamp: entry.timestamp,
        rootSha256: entry.rootSha256,
        summary: entry.summary,
        verdict: entry.verdict,
        previousAttestation: entry.previousAttestation,
      },
      hashFn
    );
    if (recomputed !== entry.attestationSha256) {
      errors.push(
        `Entry #${i + 1} (${entry.commit}) tampered attestationSha256: expected ${recomputed}, found ${entry.attestationSha256}`
      );
    }
    expectedPrevious = entry.attestationSha256;
  }

  return {
    valid: errors.length === 0,
    entries,
    headAttestation: entries.at(-1)?.attestationSha256 ?? null,
    errors,
  };
}

/** Explicit formal invariant checker for ProofLockfile objects. */
export function checkProofLockInvariants(
  lock: ProofLockfile,
  hashFn: HashFn
): string[] {
  const errors: string[] = [];
  if (lock.schemaVersion !== 1) {
    errors.push(`Invalid schemaVersion: ${String(lock.schemaVersion)}`);
  }
  const seen = new Set<string>();
  for (let i = 0; i < lock.files.length; i += 1) {
    const f = lock.files[i];
    if (seen.has(f.path)) {
      errors.push(`Duplicate locked path: ${f.path}`);
    }
    seen.add(f.path);
    if (i > 0 && lock.files[i - 1].path.localeCompare(f.path) > 0) {
      errors.push(`Locked files not sorted at ${f.path}`);
    }
  }
  const expectedRoot = computeRootSha256(lock.files, lock.metricFloors, hashFn);
  if (lock.rootSha256 !== expectedRoot) {
    errors.push('rootSha256 does not match computed payload digest');
  }
  if (
    lock.metricFloors.minUnitTests < 0 ||
    lock.metricFloors.minPropertyTests < 0 ||
    lock.metricFloors.minArchRules < 0 ||
    lock.metricFloors.maxSkippedTests < 0
  ) {
    errors.push('Metric floors must be non-negative');
  }
  return errors;
}
