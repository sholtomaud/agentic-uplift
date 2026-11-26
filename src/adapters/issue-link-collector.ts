/**
 * Collects what the `commit-msg` issue-link check needs from git and GitHub:
 * the current branch, the `owner/repo` slug, a token, and each referenced
 * issue with its comments. Every failure is reported as data (`unavailable`)
 * so the pure policy in `src/domain/issue-link.ts` decides the verdict.
 * Layer 3 (`src/adapters/`).
 */
import { spawnSync } from 'node:child_process';
import type { IssueComment, IssueLookup } from '../domain/issue-link.ts';
import { createGitHubClient, type GitHubClient } from './github-client.ts';

const MAX_COMMENT_PAGES = 5;

function git(root: string, args: readonly string[]): string | null {
  const res = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return res.status === 0 && res.stdout.trim() ? res.stdout.trim() : null;
}

/** Current branch, or null when HEAD is detached. */
export function detectCurrentBranch(root: string): string | null {
  return git(root, ['symbolic-ref', '--short', '-q', 'HEAD']);
}

/** `owner/repo` parsed from the `origin` remote, or null. */
export function detectRepositorySlug(root: string): string | null {
  const remote = git(root, ['remote', 'get-url', 'origin']);
  const match = remote?.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/);
  return match ? match[1] : null;
}

/**
 * Token from `UPLIFT_TOKEN`, `GH_TOKEN` or `GITHUB_TOKEN`, then `gh auth token`.
 * An empty string means unauthenticated (public repositories still work).
 */
export function resolveGitHubToken(
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  const fromEnv =
    env.UPLIFT_TOKEN?.trim() || env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const res = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 5000 });
  return res.status === 0 ? (res.stdout ?? '').trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toComment(value: unknown): IssueComment | null {
  if (!isRecord(value) || typeof value.body !== 'string') return null;
  const user = isRecord(value.user) && typeof value.user.login === 'string' ? value.user.login : '';
  return { author: user, body: value.body };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function lookupIssue(
  client: GitHubClient,
  slug: string,
  issue: number,
  authenticated: boolean
): Promise<IssueLookup> {
  const meta = await client.restWithStatus(`/repos/${slug}/issues/${issue}`);
  if (meta.status === 404) {
    // Without a token a private repository also answers 404.
    return authenticated
      ? { kind: 'not_found', number: issue }
      : { kind: 'unavailable', number: issue, reason: 'not visible without a GitHub token' };
  }
  if (!meta.ok || !isRecord(meta.data)) {
    return {
      kind: 'unavailable',
      number: issue,
      reason: `GitHub answered HTTP ${meta.status} (rate limit or missing access)`,
    };
  }
  const comments: IssueComment[] = [];
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    const res = await client.restWithStatus(
      `/repos/${slug}/issues/${issue}/comments?per_page=100&page=${page}`
    );
    if (!res.ok || !Array.isArray(res.data)) {
      return {
        kind: 'unavailable',
        number: issue,
        reason: `could not read comments (HTTP ${res.status})`,
      };
    }
    for (const raw of res.data) {
      const c = toComment(raw);
      if (c) comments.push(c);
    }
    if (res.data.length < 100) break;
  }
  return {
    kind: 'found',
    number: issue,
    state: typeof meta.data.state === 'string' ? meta.data.state : 'unknown',
    isPullRequest: 'pull_request' in meta.data && meta.data.pull_request != null,
    comments,
  };
}

export interface IssueLookupOptions {
  readonly slug: string;
  readonly token: string;
  readonly apiUrl?: string;
  readonly timeoutMs?: number;
}

/** Looks up each issue; network errors become `unavailable` entries. */
export async function collectIssueLookups(
  issues: readonly number[],
  options: IssueLookupOptions
): Promise<IssueLookup[]> {
  const client = createGitHubClient({ token: options.token, apiUrl: options.apiUrl });
  const timeoutMs = options.timeoutMs ?? 8000;
  const results: IssueLookup[] = [];
  for (const issue of issues) {
    try {
      results.push(
        await withTimeout(
          lookupIssue(client, options.slug, issue, options.token !== ''),
          timeoutMs
        )
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const status = reason.match(/HTTP (\d{3})/)?.[1];
      results.push({
        kind: 'unavailable',
        number: issue,
        reason:
          status === '401'
            ? 'GitHub rejected the token (HTTP 401); check GH_TOKEN, GITHUB_TOKEN or `gh auth login`'
            : status
              ? `GitHub answered HTTP ${status}`
              : `GitHub unreachable (${reason})`,
      });
    }
  }
  return results;
}
