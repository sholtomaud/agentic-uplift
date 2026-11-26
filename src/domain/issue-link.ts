/**
 * Pure issue-link policy for the `commit-msg` hook.
 *
 * Every commit must answer to a GitHub issue, and that issue must carry a
 * claim comment naming the branch the work happens on, for example
 * "Picking up as branch feat/42-retry-budget". This module holds the
 * deterministic parts: finding issue references, matching claim comments,
 * and deciding the verdict. Network I/O lives in `src/adapters/`.
 * Layer 1 (`src/domain/`): zero `node:*` imports.
 */

export interface IssueComment {
  readonly author: string;
  readonly body: string;
}

/** What the adapter could learn about one referenced issue. */
export type IssueLookup =
  | {
      readonly kind: 'found';
      readonly number: number;
      readonly state: string;
      readonly isPullRequest: boolean;
      readonly comments: readonly IssueComment[];
    }
  | { readonly kind: 'not_found'; readonly number: number }
  | { readonly kind: 'unavailable'; readonly number: number; readonly reason: string };

export type IssueLinkStatus =
  | 'pass'
  | 'skipped'
  | 'missing_reference'
  | 'missing_claim'
  | 'unverified';

export interface IssueLinkVerdict {
  readonly ok: boolean;
  readonly status: IssueLinkStatus;
  readonly branch: string | null;
  readonly issues: readonly number[];
  readonly claimed_by: number | null;
  readonly messages: readonly string[];
}

const BRANCH_SEGMENT_ISSUE = /^(?:issues?[-_]?|gh-)?(\d+)(?:[-_]|$)/i;
const MESSAGE_ISSUE = /(?:^|[^\w/&])(?:#|GH-)(\d+)\b/gi;
const CLAIM_PATTERN =
  /picking\s+(?:this\s+|it\s+)?up\s+(?:as|on|in)\s+(?:the\s+)?branch\s*:?\s*[`'"]?([^\s`'"]+)/gi;
const SKIPPED_SUBJECT = /^(?:Merge |Revert "|fixup! |squash! |amend! )/;
const SCISSORS = /^# -+ >8 -+$/m;

function uniqueSorted(values: readonly number[]): number[] {
  return [...new Set(values)].filter((n) => n > 0).sort((a, b) => a - b);
}

/**
 * Issue numbers named by the branch. A path segment counts when it starts
 * with a number (`42-retry`, `feat/42-retry`, `issues/42`) or with an
 * `issue-42` or `gh-42` prefix.
 */
export function extractBranchIssueRefs(branch: string): number[] {
  const refs: number[] = [];
  for (const segment of branch.split('/')) {
    const match = segment.match(BRANCH_SEGMENT_ISSUE);
    if (match) refs.push(Number(match[1]));
  }
  return uniqueSorted(refs);
}

/** Commit message text as git will store it: comments and scissors removed. */
export function cleanCommitMessage(raw: string): string {
  const scissors = raw.search(SCISSORS);
  const body = scissors === -1 ? raw : raw.slice(0, scissors);
  return body
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('#'))
    .join('\n')
    .trim();
}

/** Issue numbers named in a commit message (`#42`, `Fixes #42`, `GH-42`). */
export function extractMessageIssueRefs(message: string): number[] {
  const refs: number[] = [];
  for (const match of cleanCommitMessage(message).matchAll(MESSAGE_ISSUE)) {
    refs.push(Number(match[1]));
  }
  return uniqueSorted(refs);
}

export function shouldSkipCommitMessage(message: string): boolean {
  return SKIPPED_SUBJECT.test(cleanCommitMessage(message));
}

/** Branch names a comment claims, e.g. "Picking up as branch `feat/42-x`". */
export function extractClaimedBranches(body: string): string[] {
  const branches: string[] = [];
  for (const match of body.matchAll(CLAIM_PATTERN)) {
    const name = match[1].replace(/[.,;:!)]+$/, '');
    if (name) branches.push(name);
  }
  return branches;
}

export function hasBranchClaim(
  comments: readonly IssueComment[],
  branch: string
): boolean {
  return comments.some((c) => extractClaimedBranches(c.body).includes(branch));
}

export function claimCommentText(branch: string): string {
  return `Picking up as branch \`${branch}\``;
}

export interface IssueLinkInput {
  readonly branch: string | null;
  readonly message: string;
  /** Lookups for the referenced issues; null when the check ran offline. */
  readonly lookups: readonly IssueLookup[] | null;
  /** Fail instead of warn when GitHub cannot be reached. */
  readonly strict: boolean;
}

export function referencedIssues(branch: string | null, message: string): number[] {
  return uniqueSorted([
    ...(branch ? extractBranchIssueRefs(branch) : []),
    ...extractMessageIssueRefs(message),
  ]);
}

function verdict(
  status: IssueLinkStatus,
  ok: boolean,
  base: { branch: string | null; issues: readonly number[] },
  messages: readonly string[],
  claimedBy: number | null = null
): IssueLinkVerdict {
  return { ok, status, branch: base.branch, issues: base.issues, claimed_by: claimedBy, messages };
}

export function evaluateIssueLink(input: IssueLinkInput): IssueLinkVerdict {
  const { branch, message, lookups, strict } = input;
  const issues = referencedIssues(branch, message);
  const base = { branch, issues };

  if (shouldSkipCommitMessage(message)) {
    return verdict('skipped', true, base, [
      'Merge, revert, fixup, squash and amend commits are exempt.',
    ]);
  }
  if (!branch) {
    return verdict('skipped', true, base, [
      'Detached HEAD (rebase, bisect or cherry-pick in progress): branch claim check skipped.',
    ]);
  }
  if (issues.length === 0) {
    return verdict('missing_reference', false, base, [
      'This commit does not reference a GitHub issue.',
      `Name the issue in the branch (for example "feat/42-short-name") or in the commit message (for example "Refs #42").`,
    ]);
  }

  const unreachable = (reason: string): IssueLinkVerdict =>
    verdict('unverified', !strict, base, [
      `Could not confirm the branch claim on ${issues.map((n) => `#${n}`).join(', ')}: ${reason}`,
      strict
        ? 'UPLIFT_ISSUE_LINK_STRICT=1 is set, so the commit is blocked.'
        : 'The issue reference was found, so the commit is allowed. Set UPLIFT_ISSUE_LINK_STRICT=1 to block instead.',
    ]);

  if (lookups === null) return unreachable('running offline.');

  const found = lookups.filter(
    (l): l is Extract<IssueLookup, { kind: 'found' }> =>
      l.kind === 'found' && !l.isPullRequest
  );
  const claimed = found.find((l) => hasBranchClaim(l.comments, branch));
  if (claimed) {
    return verdict(
      'pass',
      true,
      base,
      [`Issue #${claimed.number} is claimed for branch ${branch}.`],
      claimed.number
    );
  }

  const unavailable = lookups.filter(
    (l): l is Extract<IssueLookup, { kind: 'unavailable' }> => l.kind === 'unavailable'
  );
  if (unavailable.length > 0) {
    return unreachable(unavailable.map((l) => `#${l.number} ${l.reason}`).join('; '));
  }

  const messages: string[] = [];
  for (const l of lookups) {
    if (l.kind === 'not_found') messages.push(`#${l.number} does not exist in this repository.`);
    else if (l.kind === 'found' && l.isPullRequest)
      messages.push(`#${l.number} is a pull request, not an issue.`);
    else if (l.kind === 'found')
      messages.push(`#${l.number} has no comment claiming branch ${branch}.`);
  }
  const target = found[0]?.number ?? issues[0];
  messages.push(
    `Comment on issue #${target} before committing: "${claimCommentText(branch)}"`,
    `With the gh CLI: gh issue comment ${target} --body 'Picking up as branch ${branch}'`
  );
  return verdict('missing_claim', false, base, messages);
}
