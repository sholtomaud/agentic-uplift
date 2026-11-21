/**
 * Unified Agentic Uplift & Proof-Integrity Audit Engine.
 * Evaluates any repository (offline locally OR online via GitHub API) and
 * produces both human guidance and machine-actionable remediation plans.
 * Layer 1 (`src/domain/`): pure, zero Node/DOM imports.
 */
import {
  AGENT_DOC_TOPICS,
  AUDIT_GROUPS,
  type AuditCheck,
  type AuditGroup,
  type AuditReport,
  type AutonomyLevel,
  type CheckImpact,
  type CheckStatus,
  type GroupReadiness,
  type ManualUpliftCommand,
  type ReadinessSummary,
  type RepoProfile,
} from '../shared/audit-types.ts';

const PINNED_ACTIONS = {
  checkout:
    'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
  setupNode:
    'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0',
  dependencyReview:
    'actions/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294 # v5.0.0',
} as const;

const PRE_COMMIT_HOOK_TEMPLATE = `#!/usr/bin/env bash
set -euo pipefail

# Layer 1 local guardrail: blocks LLMs and developers from committing
# untested, failing, or tamper-violating changes.
echo "[agentic-uplift] Running pre-commit verification gate..."
if [ -f "package.json" ] && grep -q '"verify:fast"' package.json; then
  npm run verify:fast
elif [ -f "package.json" ] && grep -q '"verify"' package.json; then
  npm run verify
else
  npm test
fi
`;

const PRE_PUSH_HOOK_TEMPLATE = `#!/usr/bin/env bash
set -euo pipefail

# Layer 1 pre-push verification gate: runs full verification + proof check
# before pushing commits to remote.
echo "[agentic-uplift] Running full pre-push verification gate..."
if [ -f "package.json" ] && grep -q '"verify"' package.json; then
  npm run verify
else
  npm test
fi
`;

const PROOF_GATE_WORKFLOW_TEMPLATE = `name: Proof Tamper Gate
on:
  pull_request:
    branches: [main]

permissions:
  contents: read

jobs:
  proof-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: ${PINNED_ACTIONS.checkout}
        with:
          persist-credentials: false
      - uses: sholtomaud/agentic-uplift/actions/proof-gate@v1
        with:
          base-ref: origin/\${{ github.base_ref }}
`;

const CODEOWNERS_TEMPLATE = `# Require maintainer approval for verification harness, hooks, and proof lockfile
proof-lock.json @OWNER
PROOF_CHANGELOG.md @OWNER
uplift.config.json @OWNER
.githooks/ @OWNER
.github/CODEOWNERS @OWNER
.github/workflows/ @OWNER
`;

function impactWeight(impact: CheckImpact): number {
  if (impact === 'high') return 3;
  if (impact === 'medium') return 2;
  return 1;
}

function statusScore(status: CheckStatus): number {
  if (status === 'pass') return 1;
  if (status === 'improve') return 0.5;
  return 0;
}

function repoSlug(repository: string): string {
  return repository.includes('/') ? repository : `<owner>/${repository}`;
}

function buildBranchRulesetCommand(repository: string, branch: string): string {
  const slug = repoSlug(repository);
  return [
    `gh api --method POST repos/${slug}/rulesets --input - <<'JSON'`,
    JSON.stringify(
      {
        name: `Protect ${branch} for autonomous agents`,
        target: 'branch',
        enforcement: 'active',
        bypass_actors: [
          {
            actor_id: 5,
            actor_type: 'RepositoryRole',
            bypass_mode: 'pull_request',
          },
        ],
        conditions: {
          ref_name: { include: [`refs/heads/${branch}`], exclude: [] },
        },
        rules: [
          { type: 'deletion' },
          { type: 'non_fast_forward' },
          {
            type: 'pull_request',
            parameters: {
              required_approving_review_count: 1,
              dismiss_stale_reviews_on_push: true,
              require_code_owner_review: true,
              require_last_push_approval: false,
              required_review_thread_resolution: true,
            },
          },
          {
            type: 'required_status_checks',
            parameters: {
              strict_required_status_checks_policy: true,
              required_status_checks: [
                { context: '4-Tier Verification & PR Tamper Gate' },
              ],
            },
          },
        ],
      },
      null,
      2
    ),
    'JSON',
  ].join('\n');
}

function buildTamperLabelsCommand(repository: string): string {
  const slug = repoSlug(repository);
  return [
    `gh label create allow-test-change -R ${slug} --color B60205 --description "Maintainer-approved change to locked tests" --force`,
    `gh label create allow-harness-change -R ${slug} --color D93F0B --description "Maintainer-approved change to verification harness" --force`,
    `gh label create agentic-uplift -R ${slug} --color 0E8A16 --description "Automated uplift finding tracked by agentic-uplift" --force`,
    `gh label create agent-ready -R ${slug} --color 1D76DB --description "Approved by maintainer for guarded autonomous resolution" --force`,
  ].join('\n');
}

export function runUpliftAudit(
  profile: RepoProfile,
  mode: 'local' | 'github' = 'local'
): AuditCheck[] {
  const checks: AuditCheck[] = [];
  const prWorkflows = profile.workflows.filter((w) =>
    w.triggers.includes('pull_request')
  );
  const prTestWorkflows = prWorkflows.filter((w) => w.hasTests);
  const proofGateWorkflows = profile.workflows.filter((w) => w.hasProofGate);
  const resolveGateWorkflows = profile.workflows.filter(
    (w) => w.hasResolveGate
  );
  const unpinned = profile.workflows.flatMap((w) =>
    w.unpinnedActions.map((a) => `${w.path}: ${a}`)
  );
  const workflowsMissingPerms = profile.workflows
    .filter((w) => !w.hasPermissions)
    .map((w) => w.path);

  // --- Group 1: Proof integrity ---
  checks.push({
    id: 'proof-lock',
    group: 'Proof integrity',
    title: 'Cryptographic proof-lock sealing tests and harness',
    kind: 'setup',
    impact: 'high',
    blocks_autonomy: true,
    status: !profile.hasProofLock
      ? 'missing'
      : profile.proofLockValid === false
        ? 'improve'
        : 'pass',
    evidence: !profile.hasProofLock
      ? 'No proof-lock.json found at repository root.'
      : profile.proofLockValid === false
        ? 'proof-lock.json exists, but integrity verification failed.'
        : 'proof-lock.json is present and cryptographically intact.',
    why: 'Prevents autonomous agents from silently editing or deleting existing tests or weakening verification scripts to force green CI.',
    recommendation: !profile.hasProofLock
      ? 'Generate proof-lock.json sealing Zone A (harness) and Zone B (tests) plus Zone C metric floors.'
      : profile.proofLockValid === false
        ? 'Inspect tamper violations and restore modified tests/harness, or intentionally re-seal with maintainer approval.'
        : '',
    verify_command: 'node src/cli.ts proof check --json',
    fixes:
      !profile.hasProofLock || profile.proofLockValid === false
        ? [
            {
              path: '',
              language: 'shell',
              content: 'node src/cli.ts proof lock',
            },
          ]
        : [],
  });

  checks.push({
    id: 'pr-tamper-gate',
    group: 'Proof integrity',
    title: 'Out-of-band PR base-branch tamper gate in CI',
    kind: 'setup',
    impact: 'high',
    blocks_autonomy: true,
    status: proofGateWorkflows.length > 0 ? 'pass' : 'missing',
    evidence:
      proofGateWorkflows.length > 0
        ? `Proof tamper gate active in ${proofGateWorkflows.map((w) => w.path).join(', ')}.`
        : 'No workflow compares PRs against origin/<base>:proof-lock.json.',
    why: 'A local lockfile alone can be regenerated inside a PR; comparing against the trusted base branch makes test/harness tampering unforgeable.',
    recommendation:
      proofGateWorkflows.length > 0
        ? ''
        : 'Add a pull_request workflow running sholtomaud/agentic-uplift/actions/proof-gate against origin/${{ github.base_ref }}.',
    verify_command: 'node src/cli.ts proof check --base origin/main --json',
    fixes:
      proofGateWorkflows.length > 0
        ? []
        : [
            {
              path: '.github/workflows/proof-gate.yml',
              language: 'yaml',
              content: PROOF_GATE_WORKFLOW_TEMPLATE,
            },
          ],
  });

  checks.push({
    id: 'proof-changelog',
    group: 'Proof integrity',
    title: 'Hash-chained PROOF_CHANGELOG.md attestation ledger',
    kind: 'setup',
    impact: 'medium',
    blocks_autonomy: false,
    status: !profile.hasProofChangelog
      ? 'missing'
      : profile.proofChangelogValid === false
        ? 'improve'
        : 'pass',
    evidence: !profile.hasProofChangelog
      ? 'No PROOF_CHANGELOG.md attestation ledger found.'
      : profile.proofChangelogValid === false
        ? 'PROOF_CHANGELOG.md exists, but hash chain verification failed.'
        : 'PROOF_CHANGELOG.md hash chain is valid.',
    why: 'Provides an append-only tamper-evident audit trail of verified commits and intentional harness/test re-seals.',
    recommendation:
      !profile.hasProofChangelog || profile.proofChangelogValid === false
        ? 'Initialize or repair PROOF_CHANGELOG.md using proof attest.'
        : '',
    verify_command: 'node src/cli.ts proof check --json',
    fixes:
      !profile.hasProofChangelog || profile.proofChangelogValid === false
        ? [
            {
              path: '',
              language: 'shell',
              content: 'node src/cli.ts proof attest --summary "Initial verified seal"',
            },
          ]
        : [],
  });

  const bothHooksExist = profile.hasPreCommitHook && profile.hasPrePushHook;
  const hooksSatisfied =
    bothHooksExist && (mode === 'github' || profile.hooksPathConfigured);

  checks.push({
    id: 'git-hooks',
    group: 'Proof integrity',
    title: 'Tracked pre-commit & pre-push verification bash hooks',
    kind: 'setup',
    impact: 'high',
    blocks_autonomy: false,
    status: hooksSatisfied
      ? 'pass'
      : profile.hasPreCommitHook || profile.hasPrePushHook
        ? 'improve'
        : 'missing',
    evidence: bothHooksExist
      ? mode === 'github'
        ? '.githooks/pre-commit and .githooks/pre-push are tracked and sealed (developers activate locally with `npm run hooks:install`).'
        : profile.hooksPathConfigured
          ? '.githooks/pre-commit and .githooks/pre-push exist and core.hooksPath is active.'
          : '.githooks/pre-commit and .githooks/pre-push exist, but git core.hooksPath is not set locally.'
      : 'Tracked .githooks/pre-commit and .githooks/pre-push guardrails are incomplete or missing.',
    why: 'Blocks LLMs and developers locally from committing or pushing failing/untested code, saving CI cycles while CI remains the unbypassable boundary.',
    recommendation: hooksSatisfied
      ? ''
      : 'Track .githooks/pre-commit and .githooks/pre-push (sealed in proof-lock.json) and activate with git config core.hooksPath .githooks.',
    verify_command: 'git config --get core.hooksPath',
    fixes: hooksSatisfied
      ? []
      : [
          {
            path: '.githooks/pre-commit',
            language: 'shell',
            content: PRE_COMMIT_HOOK_TEMPLATE,
          },
          {
            path: '.githooks/pre-push',
            language: 'shell',
            content: PRE_PUSH_HOOK_TEMPLATE,
          },
          {
            path: '',
            language: 'shell',
            content: 'git config core.hooksPath .githooks',
          },
        ],
  });

  checks.push({
    id: 'codeowners-proof',
    group: 'Proof integrity',
    title: 'CODEOWNERS protects proof-lock, hooks, and CI workflows',
    kind: 'setup',
    impact: 'high',
    blocks_autonomy: true,
    status: profile.codeownersProtectsProof
      ? 'pass'
      : profile.hasCodeowners
        ? 'improve'
        : 'missing',
    evidence: profile.codeownersProtectsProof
      ? '.github/CODEOWNERS requires human review for proof-lock.json, hooks, and workflows.'
      : profile.hasCodeowners
        ? 'CODEOWNERS exists, but does not explicitly protect proof-lock.json and .github/workflows/.'
        : 'No CODEOWNERS file found.',
    why: 'Ensures an autonomous agent PR cannot modify verification workflows, git hooks, or lockfiles without explicit maintainer sign-off.',
    recommendation: profile.codeownersProtectsProof
      ? ''
      : 'Add rules in .github/CODEOWNERS protecting proof-lock.json, .githooks/, and .github/workflows/.',
    verify_command: 'node src/cli.ts audit --json',
    fixes: profile.codeownersProtectsProof
      ? []
      : [
          {
            path: '.github/CODEOWNERS',
            language: 'text',
            content: CODEOWNERS_TEMPLATE,
          },
        ],
  });

  // --- Group 2: Code and CI ---
  checks.push({
    id: 'tests',
    group: 'Code and CI',
    title: 'Automated tests present in repository',
    kind: 'setup',
    impact: 'high',
    blocks_autonomy: true,
    status: profile.testFileCount > 0 ? 'pass' : 'missing',
    evidence:
      profile.testFileCount > 0
        ? `Found ${profile.testFileCount} automated test file(s) across ${profile.fileCount} repository files.`
        : 'No test files detected.',
    why: 'Autonomous edits without automated tests cannot be verified deterministically.',
    recommendation:
      profile.testFileCount > 0
        ? ''
        : 'Add unit and property-based tests and register them in uplift.config.json.',
    verify_command: 'npm test',
    fixes: [],
  });

  checks.push({
    id: 'ci-on-pr',
    group: 'Code and CI',
    title: 'CI runs automated verification on every pull request',
    kind: 'setup',
    impact: 'high',
    blocks_autonomy: true,
    status:
      prTestWorkflows.length > 0
        ? 'pass'
        : prWorkflows.length > 0
          ? 'improve'
          : 'missing',
    evidence:
      prTestWorkflows.length > 0
        ? `PR test verification runs in ${prTestWorkflows.map((w) => w.path).join(', ')}.`
        : prWorkflows.length > 0
          ? 'PR workflows exist, but none visibly execute test or verify commands.'
          : 'No pull_request CI workflow found.',
    why: 'PR CI is the non-bypassable execution boundary validating agent-authored code.',
    recommendation:
      prTestWorkflows.length > 0
        ? ''
        : 'Add a pull_request workflow that runs your deterministic verification command.',
    verify_command: 'node src/cli.ts verify --json',
    fixes: [],
  });

  const branchRulesetCmd = buildBranchRulesetCommand(
    profile.repository,
    profile.defaultBranch
  );
  const slug = repoSlug(profile.repository);

  checks.push({
    id: 'branch-protection',
    group: 'Code and CI',
    title: 'Default branch protection / required status checks',
    kind: 'setup',
    impact: 'high',
    blocks_autonomy: false,
    status:
      profile.branchProtectionEnabled === null
        ? 'waiting'
        : profile.branchProtectionEnabled
          ? 'pass'
          : 'missing',
    evidence:
      profile.branchProtectionEnabled === null
        ? mode === 'github'
          ? `Could not read branch rules on ${profile.defaultBranch} (default GITHUB_TOKEN lacks administration:read). Run the gh CLI command below to verify or apply.`
          : 'Branch protection requires GitHub API access (skipped in offline local mode).'
        : profile.branchProtectionEnabled
          ? `Branch protection is enabled on ${profile.defaultBranch}.`
          : `No branch protection detected on ${profile.defaultBranch}.`,
    why: 'Prevents direct pushes to the default branch and enforces required CI + tamper-gate checks before merge.',
    recommendation:
      profile.branchProtectionEnabled === true
        ? ''
        : `Apply a branch ruleset on ${profile.defaultBranch} requiring PR reviews, CODEOWNERS approval, and the 4-Tier Verification & PR Tamper Gate check.`,
    verify_command: `gh api repos/${slug}/rulesets`,
    fixes:
      profile.branchProtectionEnabled === true
        ? []
        : [
            {
              path: '',
              language: 'shell',
              content: branchRulesetCmd,
            },
          ],
  });

  checks.push({
    id: 'ci-health',
    group: 'Code and CI',
    title: 'Default-branch CI stays green',
    kind: 'habit',
    impact: 'high',
    blocks_autonomy: false,
    status:
      profile.ciPassRate === null
        ? 'waiting'
        : profile.ciFailingNow.length === 0 && profile.ciPassRate >= 0.9
          ? 'pass'
          : 'improve',
    evidence:
      profile.ciPassRate === null
        ? 'Waiting for GitHub Actions run history.'
        : `Pass rate ${Math.round(profile.ciPassRate * 100)}%; failing now: ${profile.ciFailingNow.length === 0 ? 'none' : profile.ciFailingNow.join(', ')}.`,
    why: 'Agents operating on a red default branch compound failures instead of converging.',
    recommendation:
      profile.ciPassRate !== null &&
      (profile.ciFailingNow.length > 0 || profile.ciPassRate < 0.9)
        ? 'Restore failing default-branch workflows before resuming autonomous resolution.'
        : '',
    verify_command: 'node src/cli.ts query status.ci',
    fixes: [],
  });

  checks.push({
    id: 'uplift-config',
    group: 'Code and CI',
    title: 'Declarative uplift.config.json policy file',
    kind: 'setup',
    impact: 'medium',
    blocks_autonomy: false,
    status: profile.hasUpliftConfig ? 'pass' : 'missing',
    evidence: profile.hasUpliftConfig
      ? 'uplift.config.json defines proof zones, SLA limits, and gate policy.'
      : 'No uplift.config.json found at repository root.',
    why: 'Gives both humans and agents a single typed source of truth for verification zones, limits, and circuit-breaker thresholds.',
    recommendation: profile.hasUpliftConfig
      ? ''
      : 'Add uplift.config.json defining proofLock zones, SLA limits, and resolve-gate limits.',
    verify_command: 'node src/cli.ts audit --json',
    fixes: profile.hasUpliftConfig
      ? []
      : [
          {
            path: 'uplift.config.json',
            language: 'json',
            content: JSON.stringify(
              {
                schemaVersion: 1,
                projectName: profile.repository,
                proofLock: {
                  harnessPaths: [
                    '.github/CODEOWNERS',
                    '.githooks/pre-commit',
                    '.githooks/pre-push',
                  ],
                  testRoots: ['tests'],
                  testFilePatterns: ['.test.ts', '.spec.ts', '_test.go', '_test.py'],
                },
                limits: { securityDays: 7, bugDays: 30, featureDays: 180 },
                gate: { maxOpenAgentPrs: 2, requireProofSeal: true },
              },
              null,
              2
            ),
          },
        ],
  });

  // --- Group 3: Supply chain and security ---
  checks.push({
    id: 'pinned-actions',
    group: 'Supply chain and security',
    title: 'GitHub Actions pinned to full 40-character commit SHAs',
    kind: 'setup',
    impact: 'high',
    blocks_autonomy: false,
    status:
      profile.workflows.length === 0
        ? 'waiting'
        : unpinned.length === 0
          ? 'pass'
          : 'improve',
    evidence:
      profile.workflows.length === 0
        ? 'No workflows present yet.'
        : unpinned.length === 0
          ? `All third-party action references across ${profile.workflows.length} workflow(s) are pinned to commit SHAs.`
          : `Found ${unpinned.length} unpinned action reference(s): ${unpinned.slice(0, 3).join('; ')}.`,
    why: 'Prevents mutable tag hijacking in automated workflows that hold repository or agent credentials.',
    recommendation:
      unpinned.length > 0
        ? 'Pin every external `uses:` entry to its 40-character commit SHA with `# vX.Y.Z` comment.'
        : '',
    verify_command: 'node src/cli.ts query audit.checks[id=pinned-actions]',
    fixes: [],
  });

  checks.push({
    id: 'workflow-permissions',
    group: 'Supply chain and security',
    title: 'Least-privilege permissions declared in every workflow',
    kind: 'setup',
    impact: 'high',
    blocks_autonomy: false,
    status:
      profile.workflows.length === 0
        ? 'waiting'
        : workflowsMissingPerms.length === 0
          ? 'pass'
          : 'improve',
    evidence:
      profile.workflows.length === 0
        ? 'No workflows present yet.'
        : workflowsMissingPerms.length === 0
          ? 'Every workflow declares explicit top-level `permissions:`.'
          : `Workflows missing explicit permissions: ${workflowsMissingPerms.join(', ')}.`,
    why: 'Limits blast radius of untrusted PRs or prompt-injected agent runs.',
    recommendation:
      workflowsMissingPerms.length > 0
        ? 'Declare top-level `permissions: {}` or `permissions: { contents: read }` in every workflow.'
        : '',
    verify_command:
      'node src/cli.ts query audit.checks[id=workflow-permissions]',
    fixes: [],
  });

  checks.push({
    id: 'lockfiles',
    group: 'Supply chain and security',
    title: 'Dependency lockfile or zero third-party runtime dependencies',
    kind: 'setup',
    impact: 'medium',
    blocks_autonomy: false,
    status:
      profile.hasZeroRuntimeDeps === true || profile.hasLockfile
        ? 'pass'
        : 'missing',
    evidence:
      profile.hasZeroRuntimeDeps === true
        ? 'Zero third-party runtime dependencies declared (minimal supply-chain footprint).'
        : profile.hasLockfile
          ? 'Dependency lockfile detected.'
          : 'No lockfile detected for declared package ecosystem.',
    why: 'Ensures deterministic installs and prevents unexpected upstream supply-chain drift.',
    recommendation:
      profile.hasZeroRuntimeDeps === true || profile.hasLockfile
        ? ''
        : 'Commit your package manager lockfile or eliminate unnecessary runtime dependencies.',
    verify_command: 'node src/cli.ts query audit.checks[id=lockfiles]',
    fixes: [],
  });

  checks.push({
    id: 'security-policy',
    group: 'Supply chain and security',
    title: 'SECURITY.md private vulnerability reporting policy',
    kind: 'setup',
    impact: 'low',
    blocks_autonomy: false,
    status: profile.hasSecurityPolicy ? 'pass' : 'missing',
    evidence: profile.hasSecurityPolicy
      ? 'SECURITY.md is present.'
      : 'No SECURITY.md found.',
    why: 'Directs researchers to private reporting channels instead of public issues.',
    recommendation: profile.hasSecurityPolicy
      ? ''
      : 'Add SECURITY.md describing how to privately report vulnerabilities.',
    verify_command: 'node src/cli.ts query audit.checks[id=security-policy]',
    fixes: profile.hasSecurityPolicy
      ? []
      : [
          {
            path: 'SECURITY.md',
            language: 'markdown',
            content:
              '# Security Policy\n\nPlease report security vulnerabilities privately via GitHub Security Advisories instead of opening a public issue.\n',
          },
        ],
  });

  // --- Group 4: Agent operating model ---
  const missingTopics = AGENT_DOC_TOPICS.filter(
    (topic) => !profile.agentsMdTopics.includes(topic)
  );
  checks.push({
    id: 'agents-md',
    group: 'Agent operating model',
    title: 'AGENTS.md operating model covers verification, TDD, security, and attribution',
    kind: 'setup',
    impact: 'high',
    blocks_autonomy: true,
    status: !profile.hasAgentsMd
      ? 'missing'
      : missingTopics.length === 0
        ? 'pass'
        : 'improve',
    evidence: !profile.hasAgentsMd
      ? 'No AGENTS.md found.'
      : missingTopics.length === 0
        ? `AGENTS.md covers all ${AGENT_DOC_TOPICS.length} required operating topics.`
        : `AGENTS.md exists, missing coverage for: ${missingTopics.join(', ')}.`,
    why: 'Gives every coding agent clear build/test commands, security boundaries (untrusted issue text), and non-negotiable proof rules.',
    recommendation:
      !profile.hasAgentsMd || missingTopics.length > 0
        ? 'Add or complete AGENTS.md covering build/test, TDD, verification gates, issues, commits/PRs, security, and attribution.'
        : '',
    verify_command: 'node src/cli.ts query audit.checks[id=agents-md]',
    fixes: [],
  });

  checks.push({
    id: 'guarded-resolve-workflow',
    group: 'Agent operating model',
    title: 'Autonomous issue resolution guarded by circuit breaker',
    kind: 'setup',
    impact: 'medium',
    blocks_autonomy: false,
    status: resolveGateWorkflows.length > 0 ? 'pass' : 'missing',
    evidence:
      resolveGateWorkflows.length > 0
        ? `Circuit-broken resolution workflow found in ${resolveGateWorkflows.map((w) => w.path).join(', ')}.`
        : 'No resolve-gate guarded autonomous workflow detected.',
    why: 'Serializes agent runs and automatically pauses when the proof seal breaks, open agent PRs hit the cap, budgets trip, or main CI goes red.',
    recommendation:
      resolveGateWorkflows.length > 0
        ? ''
        : 'Wire sholtomaud/agentic-uplift/actions/resolve-gate ahead of any autonomous agent workflow.',
    verify_command: 'node src/cli.ts gate --json',
    fixes: [],
  });

  checks.push({
    id: 'agent-attribution',
    group: 'Agent operating model',
    title: 'Agent work attributed via account or Co-Authored-By trailers',
    kind: 'habit',
    impact: 'low',
    blocks_autonomy: false,
    status:
      profile.agentAttributionCount === null
        ? 'waiting'
        : profile.agentAttributionCount > 0
          ? 'pass'
          : 'improve',
    evidence:
      profile.agentAttributionCount === null
        ? 'Waiting for PR/commit attribution history (requires GitHub API mode).'
        : `Detected ${profile.agentAttributionCount} agent-attributed PR(s) or issue resolution(s).`,
    why: 'Measures whether AI agents actually reduce backlog and maintain quality over time.',
    recommendation:
      profile.agentAttributionCount === 0
        ? 'Preserve Co-Authored-By / Assisted-by trailers in squash-merged PRs.'
        : '',
    verify_command: 'node src/cli.ts query status.pulls',
    fixes: [],
  });

  // --- Group 5: Issues and delivery ---
  checks.push({
    id: 'issue-forms',
    group: 'Issues and delivery',
    title: 'Structured GitHub issue forms for triage and SLAs',
    kind: 'setup',
    impact: 'medium',
    blocks_autonomy: false,
    status: profile.hasIssueForms ? 'pass' : 'missing',
    evidence: profile.hasIssueForms
      ? 'Structured issue templates found under .github/ISSUE_TEMPLATE/.'
      : 'No .github/ISSUE_TEMPLATE/ forms found.',
    why: 'Labels issues consistently (security, bug, enhancement) so agents and SLA monitors prioritize accurately.',
    recommendation: profile.hasIssueForms
      ? ''
      : 'Add YAML issue forms under .github/ISSUE_TEMPLATE/ that apply severity/type labels.',
    verify_command: 'node src/cli.ts query audit.checks[id=issue-forms]',
    fixes: [],
  });

  checks.push({
    id: 'pr-template',
    group: 'Issues and delivery',
    title: 'Pull request template requiring linked issues and verification summary',
    kind: 'setup',
    impact: 'low',
    blocks_autonomy: false,
    status: profile.hasPrTemplate ? 'pass' : 'missing',
    evidence: profile.hasPrTemplate
      ? 'Pull request template is present.'
      : 'No .github/pull_request_template.md found.',
    why: 'Standardizes `Fixes #123` links and verification proof summaries across human and agent PRs.',
    recommendation: profile.hasPrTemplate
      ? ''
      : 'Add .github/pull_request_template.md prompting for linked issue and verification output.',
    verify_command: 'node src/cli.ts query audit.checks[id=pr-template]',
    fixes: profile.hasPrTemplate
      ? []
      : [
          {
            path: '.github/pull_request_template.md',
            language: 'markdown',
            content:
              '## Summary\n\nFixes #\n\n## Verification\n- [ ] `npm run verify` passes locally\n- [ ] Proof-lock intact (no unauthorized test/harness edits)\n',
          },
        ],
  });

  checks.push({
    id: 'linked-fixes',
    group: 'Issues and delivery',
    title: 'Closed issues link back to a verifiable fix',
    kind: 'habit',
    impact: 'medium',
    blocks_autonomy: false,
    status:
      profile.closedIssuesCount === null || profile.closedIssuesCount < 5
        ? 'waiting'
        : profile.linkedFixShare !== null && profile.linkedFixShare >= 0.8
          ? 'pass'
          : 'improve',
    evidence:
      profile.closedIssuesCount === null || profile.closedIssuesCount < 5
        ? 'Waiting for at least 5 closed issues to evaluate closure verification rate.'
        : `${Math.round((profile.linkedFixShare ?? 0) * 100)}% of ${profile.closedIssuesCount} closed issues reference a fix.`,
    why: 'Separates real fixes from silent closures without commits or PRs.',
    recommendation:
      profile.closedIssuesCount !== null &&
      profile.closedIssuesCount >= 5 &&
      (profile.linkedFixShare ?? 0) < 0.8
        ? 'Close issues via merged PRs containing `Fixes #<number>`.'
        : '',
    verify_command: 'node src/cli.ts query status.issues',
    fixes: [],
  });

  // --- Group 6: Observability and budgets ---
  checks.push({
    id: 'cost-and-budgets',
    group: 'Observability and budgets',
    title: 'Agentic spend and budget guardrails configured',
    kind: 'setup',
    impact: 'low',
    blocks_autonomy: false,
    status: profile.costConfigured ? 'pass' : 'missing',
    evidence: profile.costConfigured
      ? 'Monthly budget / cost parameters are configured.'
      : 'No monthly agentic budget configured yet.',
    why: 'Prevents runaway autonomous API/CI loops by letting resolve-gate trip automatically at budget limits.',
    recommendation: profile.costConfigured
      ? ''
      : 'Configure monthly-agentic-budget in your uplift workflow or uplift.config.json.',
    verify_command: 'node src/cli.ts gate --json',
    fixes: [],
  });

  return checks;
}

export function scoreAuditChecks(
  checks: readonly AuditCheck[]
): ReadinessSummary {
  let weightedEarned = 0;
  let weightedTotal = 0;
  let passed = 0;
  let improve = 0;
  let missing = 0;
  let waiting = 0;
  const blockers: string[] = [];

  for (const check of checks) {
    if (check.status === 'pass') passed += 1;
    else if (check.status === 'improve') improve += 1;
    else if (check.status === 'missing') missing += 1;
    else waiting += 1;

    if (check.blocks_autonomy && check.status !== 'pass') {
      blockers.push(check.id);
    }

    if (check.status === 'waiting') continue;
    const w = impactWeight(check.impact);
    weightedTotal += w;
    weightedEarned += w * statusScore(check.status);
  }

  const score =
    weightedTotal > 0 ? Math.round((weightedEarned / weightedTotal) * 100) : 0;

  const missingBlocker = checks.some(
    (c) => c.blocks_autonomy && c.status === 'missing'
  );
  let autonomy: AutonomyLevel;
  if (missingBlocker || score < 50) {
    autonomy = 'not-ready';
  } else if (blockers.length > 0 || score < 85) {
    autonomy = 'supervised';
  } else {
    autonomy = 'autonomous-ready';
  }

  const groups: GroupReadiness[] = AUDIT_GROUPS.map((group: AuditGroup) => {
    const inGroup = checks.filter((c) => c.group === group);
    const active = inGroup.filter((c) => c.status !== 'waiting');
    let gEarned = 0;
    let gTotal = 0;
    for (const c of active) {
      const w = impactWeight(c.impact);
      gTotal += w;
      gEarned += w * statusScore(c.status);
    }
    return {
      group,
      score: gTotal > 0 ? Math.round((gEarned / gTotal) * 100) : 100,
      passed: inGroup.filter((c) => c.status === 'pass').length,
      total: inGroup.length,
    };
  });

  return {
    score,
    autonomy,
    passed,
    improve,
    missing,
    waiting,
    total: checks.length,
    blockers,
    groups,
  };
}

export function buildManualUpliftCommands(
  profile: RepoProfile,
  checks: readonly AuditCheck[]
): ManualUpliftCommand[] {
  const slug = repoSlug(profile.repository);
  const checkById = new Map(checks.map((c) => [c.id, c]));
  const commands: ManualUpliftCommand[] = [];

  const branchCheck = checkById.get('branch-protection');
  commands.push({
    id: 'branch-rules',
    title: `Protect ${profile.defaultBranch} with PR review, CODEOWNERS & Tamper Gate`,
    category: 'github-settings',
    status:
      branchCheck?.status === 'pass'
        ? 'done'
        : branchCheck?.status === 'missing'
          ? 'required'
          : 'recommended',
    check_id: 'branch-protection',
    why: 'Makes the CI 4-Tier Verification & PR Tamper Gate an unbypassable merge boundary on GitHub.',
    command: buildBranchRulesetCommand(
      profile.repository,
      profile.defaultBranch
    ),
  });

  commands.push({
    id: 'tamper-labels',
    title: 'Create tamper-override & autonomous-triage labels',
    category: 'labels',
    status: 'recommended',
    check_id: 'pr-tamper-gate',
    why: 'Enables maintainer-controlled override labels (allow-test-change, allow-harness-change) and agent issue queues (agentic-uplift, agent-ready).',
    command: buildTamperLabelsCommand(profile.repository),
  });

  commands.push({
    id: 'github-pages',
    title: 'Enable GitHub Pages (GitHub Actions source) for live cockpit & JSON API',
    category: 'github-settings',
    status: 'recommended',
    check_id: null,
    why: 'Publishes data/{status,audit,proof,gate}.json, schemas/*-v1.json, llms.txt, and the flight-deck cockpit.',
    command: `gh api --method POST repos/${slug}/pages -f build_type=workflow || gh api --method PUT repos/${slug}/pages -f build_type=workflow`,
  });

  const hookCheck = checkById.get('git-hooks');
  commands.push({
    id: 'local-hooks',
    title: 'Activate local pre-commit & pre-push verification hooks on your machine',
    category: 'local-hooks',
    status:
      hookCheck?.status === 'pass' && profile.hooksPathConfigured
        ? 'done'
        : 'required',
    check_id: 'git-hooks',
    why: 'Blocks LLMs and developers locally from committing or pushing failing or tampered code before CI even runs.',
    command: 'node src/cli.ts hooks install',
  });

  const proofCheck = checkById.get('proof-lock');
  if (!proofCheck || proofCheck.status !== 'pass') {
    commands.push({
      id: 'proof-seal',
      title: 'Generate cryptographic proof-lock.json and attest genesis changelog entry',
      category: 'proof-seal',
      status: 'required',
      check_id: 'proof-lock',
      why: 'Seals Zone A (verification harness & hooks), Zone B (tests), and Zone C (monotonic test floors).',
      command:
        'node src/cli.ts proof lock && node src/cli.ts proof attest --summary "Initial verified seal"',
    });
  }

  commands.push({
    id: 'resolver-secret',
    title: 'Configure model API key secret for guarded autonomous issue resolution',
    category: 'secrets',
    status: 'recommended',
    check_id: 'guarded-resolve-workflow',
    why: 'Allows .github/workflows/agent-resolve.yml to resolve agent-ready issues when the Proof-Aware circuit breaker opens.',
    command: `gh secret set ANTHROPIC_API_KEY -R ${slug}`,
  });

  return commands;
}

export function buildAuditReport(
  profile: RepoProfile,
  mode: 'local' | 'github',
  now: Date
): AuditReport {
  const checks = runUpliftAudit(profile, mode);
  const readiness = scoreAuditChecks(checks);
  const manual_commands = buildManualUpliftCommands(profile, checks);
  return {
    schema_version: 1,
    generated_at: now.toISOString().replace(/\.\d+Z$/, 'Z'),
    repository: profile.repository,
    mode,
    readiness,
    checks,
    manual_commands,
  };
}

/** Explicit formal invariant checker for AuditReport / ReadinessSummary. */
export function checkAuditInvariants(
  checks: readonly AuditCheck[],
  summary: ReadinessSummary
): string[] {
  const errors: string[] = [];
  if (summary.score < 0 || summary.score > 100) {
    errors.push(`Readiness score out of range [0,100]: ${summary.score}`);
  }
  const sumCounts =
    summary.passed + summary.improve + summary.missing + summary.waiting;
  if (sumCounts !== summary.total || summary.total !== checks.length) {
    errors.push(
      `Check status counts (${sumCounts}) do not equal total (${summary.total})`
    );
  }
  if (summary.autonomy === 'autonomous-ready' && summary.blockers.length > 0) {
    errors.push(
      `Invariant violation: autonomy="autonomous-ready" while blockers exist (${summary.blockers.join(', ')})`
    );
  }
  if (summary.autonomy === 'autonomous-ready' && summary.score < 85) {
    errors.push(
      `Invariant violation: autonomy="autonomous-ready" with score ${summary.score} < 85`
    );
  }
  const expectedBlockers = checks
    .filter((c) => c.blocks_autonomy && c.status !== 'pass')
    .map((c) => c.id);
  if (JSON.stringify(expectedBlockers) !== JSON.stringify(summary.blockers)) {
    errors.push('Blockers list does not match failing blocks_autonomy checks');
  }
  return errors;
}
