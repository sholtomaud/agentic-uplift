/**
 * Minimal zero-dependency GitHub REST API client powered by native `fetch`.
 * Returns `unknown` so callers narrow via runtime guards (zero unsafe casts).
 * Layer 3 (`src/adapters/`).
 */

export interface GitHubClientConfig {
  readonly token: string;
  readonly apiUrl?: string;
}

export interface GitHubClient {
  rest(endpoint: string): Promise<unknown>;
}

export function createGitHubClient(config: GitHubClientConfig): GitHubClient {
  const baseUrl = (config.apiUrl ?? 'https://api.github.com').replace(/\/$/, '');

  return {
    async rest(endpoint: string): Promise<unknown> {
      const headers: Record<string, string> = {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'agentic-uplift/0.1',
        'X-GitHub-Api-Version': '2022-11-28',
      };
      if (config.token) {
        headers.Authorization = `Bearer ${config.token}`;
      }
      const response = await fetch(`${baseUrl}${endpoint}`, { headers });
      if (response.status === 403 || response.status === 404) {
        return null;
      }
      if (!response.ok) {
        throw new Error(
          `GitHub API ${endpoint} failed with HTTP ${response.status}`
        );
      }
      return response.json();
    },
  };
}
