import assert from 'node:assert/strict';
import test from 'node:test';
import {
  claimCommentText,
  cleanCommitMessage,
  evaluateIssueLink,
  extractBranchIssueRefs,
  extractClaimedBranches,
  extractMessageIssueRefs,
  hasBranchClaim,
  shouldSkipCommitMessage,
  type IssueLookup,
} from '../../src/domain/issue-link.ts';

const BRANCH = 'feat/42-retry-budget';

function found(number: number, bodies: readonly string[], isPullRequest = false): IssueLookup {
  return {
    kind: 'found',
    number,
    state: 'open',
    isPullRequest,
    comments: bodies.map((body) => ({ author: 'dev', body })),
  };
}

test('branch issue refs: leading numbers, issue-/gh- prefixes and issues/N paths', () => {
  assert.deepEqual(extractBranchIssueRefs('42-retry'), [42]);
  assert.deepEqual(extractBranchIssueRefs('feat/42-retry'), [42]);
  assert.deepEqual(extractBranchIssueRefs('fix/issue-7'), [7]);
  assert.deepEqual(extractBranchIssueRefs('issues/19'), [19]);
  assert.deepEqual(extractBranchIssueRefs('gh-3_tidy'), [3]);
  assert.deepEqual(extractBranchIssueRefs('claude/project-thread-0ftjqf'), []);
  assert.deepEqual(extractBranchIssueRefs('main'), []);
  assert.deepEqual(extractBranchIssueRefs('release/v2.0'), []);
  assert.deepEqual(extractBranchIssueRefs('feat/retry-42'), []);
});

test('message issue refs: #N, closing keywords and GH-N, ignoring git comments', () => {
  assert.deepEqual(extractMessageIssueRefs('fix: retry budget\n\nFixes #42'), [42]);
  assert.deepEqual(extractMessageIssueRefs('feat: x (#7) refs GH-9'), [7, 9]);
  assert.deepEqual(extractMessageIssueRefs('chore: bump\n# Refs #99 (comment)'), []);
  assert.deepEqual(extractMessageIssueRefs('docs: see https://x.test/page#12'), []);
  assert.deepEqual(extractMessageIssueRefs('docs: other/repo#12 and a&#12;'), []);
});

test('cleanCommitMessage drops comment lines and everything below the scissors line', () => {
  const raw = 'feat: x\n\nRefs #1\n# Please enter the commit message\n# ------------------------ >8 ------------------------\ndiff #2';
  assert.equal(cleanCommitMessage(raw), 'feat: x\n\nRefs #1');
  assert.deepEqual(extractMessageIssueRefs(raw), [1]);
});

test('merge, revert, fixup, squash and amend commits are exempt', () => {
  for (const msg of ["Merge branch 'main'", 'Revert "feat: x"', 'fixup! feat: x', 'squash! feat: x', 'amend! feat: x']) {
    assert.equal(shouldSkipCommitMessage(msg), true, msg);
    assert.equal(evaluateIssueLink({ branch: 'main', message: msg, lookups: null, strict: true }).status, 'skipped');
  }
  assert.equal(shouldSkipCommitMessage('feat: merge helpers'), false);
});

test('claim comments: accepted phrasings and exact branch matching', () => {
  assert.deepEqual(extractClaimedBranches(`Picking up as branch ${BRANCH}`), [BRANCH]);
  assert.deepEqual(extractClaimedBranches(`picking this up on branch \`${BRANCH}\`.`), [BRANCH]);
  assert.deepEqual(extractClaimedBranches(`Picking it up in the branch: "${BRANCH}"!`), [BRANCH]);
  assert.deepEqual(extractClaimedBranches('Looks good to me'), []);
  assert.equal(hasBranchClaim([{ author: 'a', body: `Picking up as branch ${BRANCH}-v2` }], BRANCH), false);
  assert.deepEqual(extractClaimedBranches(claimCommentText(BRANCH)), [BRANCH]);
});

test('verdict: no issue reference blocks the commit even offline', () => {
  const v = evaluateIssueLink({ branch: 'feat/retry', message: 'feat: retry', lookups: null, strict: false });
  assert.equal(v.ok, false);
  assert.equal(v.status, 'missing_reference');
});

test('verdict: claimed issue passes and reports which issue holds the claim', () => {
  const v = evaluateIssueLink({
    branch: BRANCH,
    message: 'feat: retry budget',
    lookups: [found(42, ['Thanks!', `Picking up as branch ${BRANCH}`])],
    strict: true,
  });
  assert.equal(v.ok, true);
  assert.equal(v.status, 'pass');
  assert.equal(v.claimed_by, 42);
});

test('verdict: issue without a claim blocks and tells the author what to post', () => {
  const v = evaluateIssueLink({
    branch: BRANCH,
    message: 'feat: retry budget',
    lookups: [found(42, ['Picking up as branch someone-else'])],
    strict: false,
  });
  assert.equal(v.ok, false);
  assert.equal(v.status, 'missing_claim');
  assert.ok(v.messages.some((m) => m.includes(claimCommentText(BRANCH))));
  assert.ok(v.messages.some((m) => m.startsWith('With the gh CLI: gh issue comment 42')));
});

test('verdict: pull requests and missing issues never satisfy the claim', () => {
  const pr = evaluateIssueLink({
    branch: BRANCH,
    message: 'feat: x',
    lookups: [found(42, [`Picking up as branch ${BRANCH}`], true)],
    strict: false,
  });
  assert.equal(pr.status, 'missing_claim');
  const missing = evaluateIssueLink({
    branch: BRANCH,
    message: 'feat: x',
    lookups: [{ kind: 'not_found', number: 42 }],
    strict: false,
  });
  assert.equal(missing.status, 'missing_claim');
  assert.ok(missing.messages[0].includes('does not exist'));
});

test('verdict: offline or unreachable GitHub warns by default and blocks in strict mode', () => {
  const offline = evaluateIssueLink({ branch: BRANCH, message: 'feat: x', lookups: null, strict: false });
  assert.equal(offline.ok, true);
  assert.equal(offline.status, 'unverified');
  const strict = evaluateIssueLink({ branch: BRANCH, message: 'feat: x', lookups: null, strict: true });
  assert.equal(strict.ok, false);
  const down = evaluateIssueLink({
    branch: BRANCH,
    message: 'feat: x',
    lookups: [{ kind: 'unavailable', number: 42, reason: 'GitHub unreachable' }],
    strict: false,
  });
  assert.equal(down.status, 'unverified');
  assert.ok(down.messages[0].includes('GitHub unreachable'));
});

test('verdict: one claimed issue among several references is enough', () => {
  const v = evaluateIssueLink({
    branch: BRANCH,
    message: 'feat: x\n\nRefs #50',
    lookups: [{ kind: 'unavailable', number: 42, reason: 'timeout' }, found(50, [`Picking up as branch ${BRANCH}`])],
    strict: true,
  });
  assert.deepEqual(v.issues, [42, 50]);
  assert.equal(v.status, 'pass');
  assert.equal(v.claimed_by, 50);
});

test('verdict: detached HEAD is skipped', () => {
  const v = evaluateIssueLink({ branch: null, message: 'feat: x', lookups: null, strict: true });
  assert.equal(v.status, 'skipped');
  assert.equal(v.ok, true);
});
