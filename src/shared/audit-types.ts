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
  /** Target repository path; empty string means run as a shell command. */
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

export interface WorkflowSummary {
  readonly path: string;
  readonly triggers: readonly string[];
  readonly hasTests: boolean;
  readonly hasProofGate: boolean;
  readonly hasResolveGate: boolean;
  readonly hasPermissions: boolean;
  readonly unpinnedActions: readonly string[];
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
