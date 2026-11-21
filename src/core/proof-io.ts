/**
 * Filesystem and Git-Ref I/O adapter for Tier-0 Proof-Lock & Changelog Attestation.
 * Layer 2 (`src/core/`): injects `node:crypto` SHA-256 into pure `src/domain/proof-verifier.ts`.
 */
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildProofLockfile,
  createChangelogEntry,
  formatProofChangelogMarkdown,
  GENESIS_ATTESTATION,
  normalizeLineEndings,
  verifyFloorRatchet,
  verifyProofChangelogMarkdown,
  verifySnapshotAgainstLock,
} from '../domain/proof-verifier.ts';
import {
  isRecord,
  isUpliftConfig,
  type UpliftConfig,
} from '../shared/contracts.ts';
import {
  isProofLockfile,
  type ChangelogVerificationResult,
  type LockedFileEntry,
  type MetricFloors,
  type ObservedMetrics,
  type ProofChangelogEntry,
  type ProofLockfile,
  type ProofVerificationReport,
  type TamperViolation,
} from '../shared/proof-types.ts';

export function sha256Text(text: string): string {
  return crypto
    .createHash('sha256')
    .update(normalizeLineEndings(text), 'utf8')
    .digest('hex');
}

function toPosix(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

export const DEFAULT_HARNESS_PATHS: readonly string[] = [
  '.github/CODEOWNERS',
  '.github/workflows/verify.yml',
  '.githooks/pre-commit',
  '.githooks/pre-push',
  'package.json#scripts',
  'tsconfig.json',
  'uplift.config.json',
];

export const DEFAULT_TEST_ROOTS: readonly string[] = [
  'tests',
  'test',
  'src',
  'e2e',
];

export const DEFAULT_TEST_PATTERNS: readonly string[] = [
  '.test.ts',
  '.prop.test.ts',
  '.spec.ts',
  '.test.js',
  '_test.py',
  '_test.go',
  '_test.rs',
];

export function loadUpliftConfig(root: string): UpliftConfig | null {
  const cfgPath = path.join(root, 'uplift.config.json');
  if (!fs.existsSync(cfgPath)) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    return isUpliftConfig(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function hashVirtualOrFile(
  root: string,
  entryPath: string
): string | null {
  if (entryPath === 'package.json#scripts') {
    const pkgPath = path.join(root, 'package.json');
    if (!fs.existsSync(pkgPath)) return null;
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (!isRecord(raw) || !isRecord(raw.scripts)) return null;
      const sortedEntries = Object.entries(raw.scripts)
        .filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string'
        )
        .sort(([a], [b]) => a.localeCompare(b));
      return sha256Text(JSON.stringify(Object.fromEntries(sortedEntries)));
    } catch {
      return null;
    }
  }

  const fullPath = path.join(root, entryPath);
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) return null;
  return sha256Text(fs.readFileSync(fullPath, 'utf8'));
}

export function discoverTestFiles(
  root: string,
  config: UpliftConfig | null = loadUpliftConfig(root)
): string[] {
  const roots = config?.proofLock.testRoots ?? DEFAULT_TEST_ROOTS;
  const patterns = config?.proofLock.testFilePatterns ?? DEFAULT_TEST_PATTERNS;
  const found = new Set<string>();

  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (
        entry.name === 'node_modules' ||
        entry.name === '.git' ||
        entry.name === 'dist'
      ) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const rel = toPosix(path.relative(root, full));
        if (patterns.some((suffix) => rel.endsWith(suffix))) {
          found.add(rel);
        }
      }
    }
  };

  for (const testRoot of roots) {
    walk(path.join(root, testRoot));
  }
  return [...found].sort();
}

export function generateAndWriteProofLock(
  root: string,
  floors: MetricFloors
): ProofLockfile {
  const config = loadUpliftConfig(root);
  const harnessPaths = config?.proofLock.harnessPaths ?? DEFAULT_HARNESS_PATHS;
  const entries: LockedFileEntry[] = [];
  const seen = new Set<string>();

  for (const hPath of harnessPaths) {
    if (seen.has(hPath)) continue;
    const hash = hashVirtualOrFile(root, hPath);
    if (hash !== null) {
      entries.push({ path: hPath, zone: 'harness', sha256: hash });
      seen.add(hPath);
    }
  }

  for (const tPath of discoverTestFiles(root, config)) {
    if (seen.has(tPath)) continue;
    const hash = hashVirtualOrFile(root, tPath);
    if (hash !== null) {
      entries.push({ path: tPath, zone: 'tests', sha256: hash });
      seen.add(tPath);
    }
  }

  const lock = buildProofLockfile(entries, floors, sha256Text);
  fs.writeFileSync(
    path.join(root, 'proof-lock.json'),
    `${JSON.stringify(lock, null, 2)}\n`
  );
  return lock;
}

export function loadLockfileFromDisk(root: string): ProofLockfile | null {
  const lockPath = path.join(root, 'proof-lock.json');
  if (!fs.existsSync(lockPath)) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    return isProofLockfile(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function loadLockfileFromGitRef(
  root: string,
  gitRef: string
): ProofLockfile | null {
  const res = spawnSync('git', ['show', `${gitRef}:proof-lock.json`], {
    cwd: root,
    encoding: 'utf8',
  });
  if (res.status !== 0 || !res.stdout) return null;
  try {
    const parsed: unknown = JSON.parse(res.stdout);
    return isProofLockfile(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function loadAndVerifyProofChangelog(
  root: string
): ChangelogVerificationResult {
  const filePath = path.join(root, 'PROOF_CHANGELOG.md');
  if (!fs.existsSync(filePath)) {
    return { valid: true, entries: [], headAttestation: null, errors: [] };
  }
  const markdown = fs.readFileSync(filePath, 'utf8');
  return verifyProofChangelogMarkdown(markdown, sha256Text);
}

export function appendProofChangelogEntry(
  root: string,
  fields: Omit<ProofChangelogEntry, 'previousAttestation' | 'attestationSha256'>
): ProofChangelogEntry {
  const current = loadAndVerifyProofChangelog(root);
  if (!current.valid) {
    throw new Error(
      `Cannot append to tampered PROOF_CHANGELOG.md: ${current.errors.join('; ')}`
    );
  }
  const previousAttestation =
    current.entries.at(-1)?.attestationSha256 ?? GENESIS_ATTESTATION;
  const nextEntry = createChangelogEntry(
    { ...fields, previousAttestation },
    sha256Text
  );
  const nextMarkdown = formatProofChangelogMarkdown([
    ...current.entries,
    nextEntry,
  ]);
  fs.writeFileSync(path.join(root, 'PROOF_CHANGELOG.md'), nextMarkdown);
  return nextEntry;
}

export function currentGitCommitShort(root: string): string {
  const res = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  });
  return res.status === 0 && res.stdout.trim()
    ? res.stdout.trim()
    : 'uncommitted';
}

export interface ProofCheckOptions {
  readonly baseRef?: string;
  readonly allowTestChange?: boolean;
  readonly allowHarnessChange?: boolean;
  readonly observedMetrics?: ObservedMetrics;
  readonly now?: Date;
}

export function verifyRepositoryProof(
  root: string,
  options: ProofCheckOptions = {}
): ProofVerificationReport {
  const checkedAt = (options.now ?? new Date())
    .toISOString()
    .replace(/\.\d+Z$/, 'Z');
  const changelog = loadAndVerifyProofChangelog(root);
  const config = loadUpliftConfig(root);

  const baseLock = options.baseRef
    ? loadLockfileFromGitRef(root, options.baseRef)
    : null;
  const localLock = loadLockfileFromDisk(root);
  const lock = baseLock ?? localLock;
  const source = baseLock
    ? `git:${options.baseRef}`
    : options.baseRef
      ? `local (bootstrap: no lockfile on ${options.baseRef})`
      : 'local:proof-lock.json';

  if (!lock) {
    const violations: TamperViolation[] = [
      {
        code: 'missing-lockfile',
        path: 'proof-lock.json',
        message: 'proof-lock.json is missing or invalid.',
      },
    ];
    if (!changelog.valid) {
      for (const err of changelog.errors) {
        violations.push({
          code: 'broken-changelog-chain',
          path: 'PROOF_CHANGELOG.md',
          message: err,
        });
      }
    }
    return {
      schema_version: 1,
      checked_at: checkedAt,
      ok: false,
      source,
      root_sha256: null,
      locked_files: 0,
      harness_files: 0,
      test_files: 0,
      metric_floors: null,
      added_test_files: [],
      authorized_changes: [],
      violations,
      changelog: {
        valid: changelog.valid,
        count: changelog.entries.length,
        head_attestation: changelog.headAttestation,
        errors: changelog.errors,
      },
    };
  }

  const lockedFileHashes = new Map<string, string | null>();
  for (const entry of lock.files) {
    lockedFileHashes.set(entry.path, hashVirtualOrFile(root, entry.path));
  }

  const currentTestPaths = discoverTestFiles(root, config);
  const currentTestFiles = currentTestPaths.map((rel) => ({
    path: rel,
    content: fs.readFileSync(path.join(root, rel), 'utf8'),
  }));

  const snapResult = verifySnapshotAgainstLock(
    {
      lock,
      lockedFileHashes,
      currentTestFiles,
      allowTestChange: options.allowTestChange,
      allowHarnessChange: options.allowHarnessChange,
      observedMetrics: options.observedMetrics,
    },
    sha256Text
  );

  const allViolations: TamperViolation[] = [...snapResult.violations];

  if (baseLock && localLock && !options.allowHarnessChange) {
    allViolations.push(
      ...verifyFloorRatchet(baseLock.metricFloors, localLock.metricFloors)
    );
  }

  if (!changelog.valid) {
    for (const err of changelog.errors) {
      allViolations.push({
        code: 'broken-changelog-chain',
        path: 'PROOF_CHANGELOG.md',
        message: err,
      });
    }
  }

  const harnessFiles = lock.files.filter((f) => f.zone === 'harness').length;
  const testFiles = lock.files.filter((f) => f.zone === 'tests').length;

  return {
    schema_version: 1,
    checked_at: checkedAt,
    ok: allViolations.length === 0,
    source,
    root_sha256: lock.rootSha256,
    locked_files: lock.files.length,
    harness_files: harnessFiles,
    test_files: testFiles,
    metric_floors: lock.metricFloors,
    added_test_files: snapResult.addedTestFiles,
    authorized_changes: snapResult.authorizedChanges,
    violations: allViolations,
    changelog: {
      valid: changelog.valid,
      count: changelog.entries.length,
      head_attestation: changelog.headAttestation,
      errors: changelog.errors,
    },
  };
}
