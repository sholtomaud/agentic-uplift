/**
 * Agentic Uplift Readiness Audit contracts.
 * Designed for BOTH human review and first-class agentic programmatic queries.
 * Layer 0 (`src/shared/`).
 */

export type CheckStatus = 'pass' | 'improve' | 'missing' | 'waiting';
export type CheckImpact = 'high' | 'medium' | 'low';
export type AutonomyLevel = 'not-ready' | 'supervised' | 'autonomous-ready';

export const AUDIT_GROUPS = [
  'Proof integrity',
  'Code and CI',
  'Supply chain and security',
  'Agent operating model',
  'Issues and delivery',
  'Observability and budgets',
] as const;

export type AuditGroup = (typeof AUDIT_GROUPS)[number];

/** Machine-actionable remediation artifact (file to create/update or shell command). */
export interface AuditFix {
  /**
   * Target repository path. Empty string means the content is not a whole
   * file: a shell command (`language: 'shell'`) or a snippet to merge by hand.
   */
  readonly path: string;
  readonly language: 'yaml' | 'json' | 'markdown' | 'shell' | 'text';
  readonly content: string;
}

export interface AuditCheck {
  readonly id: string;
  readonly group: AuditGroup;
  readonly title: string;
  readonly kind: 'setup' | 'habit';
  readonly impact: CheckImpact;
  /** If true and status != 'pass', blocks unattended autonomous execution. */
  readonly blocks_autonomy: boolean;
  readonly status: CheckStatus;
  readonly evidence: string;
  readonly why: string;
  readonly recommendation: string;
  readonly verify_command: string;
  readonly fixes: readonly AuditFix[];
}

export interface GroupReadiness {
  readonly group: AuditGroup;
  readonly score: number;
  readonly passed: number;
  readonly total: number;
}

export interface ReadinessSummary {
  readonly score: number;
  readonly autonomy: AutonomyLevel;
  readonly passed: number;
  readonly improve: number;
  readonly missing: number;
  readonly waiting: number;
  readonly total: number;
  readonly blockers: readonly string[];
  readonly groups: readonly GroupReadiness[];
}

export type ManualCommandCategory =
  | 'github-settings'
  | 'labels'
  | 'secrets'
  | 'local-hooks'
  | 'proof-seal';

export interface ManualUpliftCommand {
  readonly id: string;
  readonly title: string;
  readonly category: ManualCommandCategory;
  readonly status: 'required' | 'recommended' | 'done';
  readonly check_id: string | null;
  readonly why: string;
  readonly command: string;
}

export interface AuditReport {
  readonly schema_version: 1;
  readonly generated_at: string;
  readonly repository: string;
  readonly mode: 'local' | 'github';
  readonly readiness: ReadinessSummary;
  readonly checks: readonly AuditCheck[];
  readonly manual_commands: readonly ManualUpliftCommand[];
}

export const AGENT_DOC_TOPICS = [
  'build-and-test',
  'tdd',
  'verification-gates',
  'issues',
  'commits-and-prs',
  'security',
  'attribution',
] as const;

export type AgentDocTopic = (typeof AGENT_DOC_TOPICS)[number];

/** Per-job supply-chain signals. Booleans only: secret names are never recorded. */
export interface WorkflowJobSummary {
  readonly name: string;
  /** References repository secrets other than GITHUB_TOKEN, or `secrets: inherit`. */
  readonly usesSecrets: boolean;
  /** Holds a coding-agent / LLM provider API key. */
  readonly usesAgentApiKey: boolean;
  /** Runs a coding agent (known agent action or agent API key present). */
  readonly isAgentJob: boolean;
  /** Grants the agent shell/Bash tools or disables its permission prompts. */
  readonly agentShellTools: boolean;
  readonly installsPackages: boolean;
  readonly runsPackageScripts: boolean;
  readonly usesCheckout: boolean;
  /** At least one actions/checkout step lacks `persist-credentials: false`. */
  readonly checkoutPersistsCredentials: boolean;
  /** Job can write to the repository (contents: write, write-all, git push). */
  readonly pushes: boolean;
  /** Installs are screened by Socket Firewall (socketdev/action firewall mode or `sfw`). */
  readonly socketFirewall: boolean;
}

export interface WorkflowSummary {
  readonly path: string;
  readonly triggers: readonly string[];
  readonly hasTests: boolean;
  readonly hasProofGate: boolean;
  readonly hasResolveGate: boolean;
  readonly hasPermissions: boolean;
  readonly unpinnedActions: readonly string[];
  /** Per-job signals (absent for profiles built before job analysis existed). */
  readonly jobs?: readonly WorkflowJobSummary[];
}

/** Normalized repository profile built from either local filesystem or GitHub API. */
export interface RepoProfile {
  readonly repository: string;
  readonly defaultBranch: string;
  readonly ecosystems: readonly string[];
  readonly languages: readonly string[];
  readonly fileCount: number;
  readonly testFileCount: number;
  readonly hasLockfile: boolean;
  readonly hasProofLock: boolean;
  readonly proofLockValid: boolean | null;
  readonly hasProofChangelog: boolean;
  readonly proofChangelogValid: boolean | null;
  readonly hasPreCommitHook: boolean;
  readonly hasPrePushHook: boolean;
  readonly hooksPathConfigured: boolean;
  readonly hasCodeowners: boolean;
  readonly codeownersProtectsProof: boolean;
  readonly hasAgentsMd: boolean;
  readonly agentsMdTopics: readonly AgentDocTopic[];
  readonly hasClaudeMd: boolean;
  readonly hasSecurityPolicy: boolean;
  readonly hasIssueForms: boolean;
  readonly hasPrTemplate: boolean;
  readonly hasDependabot: boolean;
  readonly hasDependabotCooldown: boolean;
  readonly hasCodeql: boolean;
  readonly hasScorecard: boolean;
  readonly hasDependencyReview: boolean;
  readonly hasUpliftConfig: boolean;
  readonly hasZeroRuntimeDeps: boolean | null;
  /** npm/yarn/pnpm lifecycle scripts disabled repo-wide (.npmrc, .yarnrc.yml, pnpm-workspace.yaml). */
  readonly npmIgnoreScripts?: boolean;
  /** Lockfile packages flagged `hasInstallScript: true` (package names only). */
  readonly installScriptPackages?: readonly string[];
  readonly branchProtectionEnabled: boolean | null;
  readonly workflows: readonly WorkflowSummary[];
  /** Optional live operational metrics (null when running purely offline/local). */
  readonly ciPassRate: number | null;
  readonly ciFailingNow: readonly string[];
  readonly closedIssuesCount: number | null;
  readonly linkedFixShare: number | null;
  readonly agentAttributionCount: number | null;
  readonly costConfigured: boolean;
}
