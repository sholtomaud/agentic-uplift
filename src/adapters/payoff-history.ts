/**
 * Loads the uplift pay-off history (readiness vs. savings over time) from the
 * previously published `data/economics.json`, either on disk or on the
 * repository's GitHub Pages site, so each publish appends one point.
 * Layer 3 (`src/adapters/`).
 */
import fs from 'node:fs';
import { isRecord } from '../shared/contracts.ts';
import { readPayoffHistory, type PayoffPoint } from '../shared/economics-types.ts';
import type { GitHubClient } from './github-client.ts';

export function readPayoffHistoryFile(file: string): PayoffPoint[] {
  try {
    return readPayoffHistory(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return [];
  }
}

export async function loadPayoffHistory(
  client: GitHubClient,
  repository: string,
  fetchImpl: typeof fetch = fetch
): Promise<PayoffPoint[]> {
  try {
    const pages = await client.rest(`/repos/${repository}/pages`);
    if (!isRecord(pages) || typeof pages.html_url !== 'string') return [];
    const base = pages.html_url.endsWith('/') ? pages.html_url : `${pages.html_url}/`;
    if (!/^https:\/\//.test(base)) return [];
    const res = await fetchImpl(`${base}data/economics.json`, {
      headers: { Accept: 'application/json' },
    });
    return res.ok ? readPayoffHistory(await res.json()) : [];
  } catch {
    return [];
  }
}
