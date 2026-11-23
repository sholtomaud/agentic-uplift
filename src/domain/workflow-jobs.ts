/**
 * Zero-dependency GitHub Actions workflow job analyzer.
 * Extracts per-job supply-chain signals (secret reachability, package
 * installs, coding-agent tooling, checkout credential persistence, Socket
 * Firewall usage) from raw workflow YAML text without a YAML parser.
 * Never records secret names: only booleans leave this module.
 * Layer 1 (`src/domain/`): pure, zero Node/DOM imports.
 */
import type { WorkflowJobSummary } from '../shared/audit-types.ts';

const AGENT_ACTION_PATTERN =
  /uses\s*:\s*['"]?(?:anthropics\/claude-code(?:-base)?-action|google-github-actions\/run-gemini-cli|openai\/codex-action|sourcegraph\/amp-action|roovetgit\/roo-code-action)@/i;

const AGENT_KEY_PATTERN =
  /secrets\.[A-Za-z0-9_]*(?:ANTHROPIC|CLAUDE|OPENAI|GEMINI|GOOGLE_AI|GOOGLE_API|CODEX|COPILOT|AMP|OPENROUTER)[A-Za-z0-9_]*/i;

const AGENT_SHELL_PATTERN =
  /(?:\b(?:allowed_tools|allowedTools|allowed-tools|claude_args)\b[^\n]*\bBash\b|--allowedTools[^\n]*\bBash\b|\bBash\(|--dangerously-skip-permissions|--yolo\b|danger-full-access|\bshell\s*:\s*true\b)/;

const INSTALL_PATTERN =
  /\b(?:npm\s+(?:ci|install|i)\b|yarn\s+install\b|^\s*(?:run\s*:\s*)?yarn\s*$|pnpm\s+(?:install|i)\b|bun\s+install\b|(?:python3?\s+-m\s+)?pip3?\s+install\b|uv\s+(?:sync|pip\s+install)\b|poetry\s+install\b|pipenv\s+install\b|cargo\s+(?:build|install|fetch|test|run)\b)/m;

const SCRIPT_PATTERN =
  /\b(?:npm\s+(?:run|test|start|exec)\b|npx\s|yarn\s+(?:run\s+)?[a-z][\w:-]*|pnpm\s+(?:run|exec|dlx|test)\b|node_modules\/\.bin\/)/;

const SOCKET_FIREWALL_PATTERN =
  /(?:uses\s*:\s*['"]?socketdev\/action@[^\n]*\n(?:[^\n]*\n){0,6}?[^\n]*mode\s*:\s*['"]?firewall|\bsfw\s+(?:npm|npx|yarn|pnpm|pip3?|uv|cargo)\b|-sfw-dev\b)/i;

function indentOf(line: string): number {
  const match = line.match(/^ */);
  return match ? match[0].length : 0;
}

function isContent(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length > 0 && !trimmed.startsWith('#');
}

function stripComments(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, '$1'))
    .join('\n');
}

/** Returns true when a block references any secret other than GITHUB_TOKEN. */
export function referencesRepositorySecrets(text: string): boolean {
  if (/\bsecrets\s*:\s*inherit\b/.test(text)) return true;
  for (const match of text.matchAll(/\bsecrets\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
    if (match[1].toUpperCase() !== 'GITHUB_TOKEN') return true;
  }
  for (const match of text.matchAll(/\bsecrets\[\s*['"]([^'"]+)['"]\s*\]/g)) {
    if (match[1].toUpperCase() !== 'GITHUB_TOKEN') return true;
  }
  return false;
}

interface RawJob {
  readonly name: string;
  readonly text: string;
}

function splitJobs(content: string): { header: string; jobs: RawJob[] } {
  const lines = content.split('\n');
  const jobsIdx = lines.findIndex((l) => /^jobs\s*:\s*$/.test(l));
  if (jobsIdx === -1) return { header: content, jobs: [] };

  const header = lines.slice(0, jobsIdx).join('\n');
  const body = lines.slice(jobsIdx + 1);
  const firstContent = body.find(isContent);
  if (!firstContent) return { header, jobs: [] };
  const jobIndent = indentOf(firstContent);

  const jobs: RawJob[] = [];
  let current: { name: string; lines: string[] } | null = null;
  for (const line of body) {
    if (isContent(line) && indentOf(line) < jobIndent) break;
    const keyMatch =
      isContent(line) && indentOf(line) === jobIndent
        ? line.match(/^\s*['"]?([A-Za-z0-9_.-]+)['"]?\s*:\s*$/)
        : null;
    if (keyMatch) {
      if (current) jobs.push({ name: current.name, text: current.lines.join('\n') });
      current = { name: keyMatch[1], lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) jobs.push({ name: current.name, text: current.lines.join('\n') });
  return { header, jobs };
}

/** Splits a job body into its `steps:` list items. */
export function splitSteps(jobText: string): string[] {
  const lines = jobText.split('\n');
  const stepsIdx = lines.findIndex((l) => /^\s*steps\s*:\s*$/.test(l));
  if (stepsIdx === -1) return [];
  const stepsIndent = indentOf(lines[stepsIdx]);
  const rest = lines.slice(stepsIdx + 1);
  const firstDash = rest.find((l) => /^\s*-\s/.test(l) || /^\s*-$/.test(l));
  if (!firstDash) return [];
  const dashIndent = indentOf(firstDash);

  const steps: string[] = [];
  let current: string[] | null = null;
  for (const line of rest) {
    if (isContent(line) && indentOf(line) <= stepsIndent) break;
    if (isContent(line) && indentOf(line) === dashIndent && /^\s*-(?:\s|$)/.test(line)) {
      if (current) steps.push(current.join('\n'));
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) steps.push(current.join('\n'));
  return steps;
}

function readJobDisplayName(jobText: string): string | null {
  const lines = jobText.split('\n');
  const first = lines.find(isContent);
  if (!first) return null;
  const propIndent = indentOf(first);
  for (const line of lines) {
    if (!isContent(line) || indentOf(line) !== propIndent) continue;
    const match = line.match(/^\s*name\s*:\s*(.+?)\s*$/);
    if (match) {
      const value = match[1].replace(/^(['"])(.*)\1$/, '$2');
      return value.includes('${{') ? null : value;
    }
  }
  return null;
}

function jobPushes(text: string, header: string): boolean {
  const scope = `${header}\n${text}`;
  return (
    /\bcontents\s*:\s*write\b/.test(scope) ||
    /\bpermissions\s*:\s*write-all\b/.test(scope) ||
    /\bgit\s+push\b/.test(text) ||
    /\bgh\s+release\s+create\b/.test(text)
  );
}

/** Summarizes every job of a workflow file into booleans (never secret names). */
export function summarizeWorkflowJobs(content: string): WorkflowJobSummary[] {
  const clean = stripComments(content);
  const { header, jobs } = splitJobs(clean);
  const headerSecrets = referencesRepositorySecrets(header);
  const headerAgentKey = AGENT_KEY_PATTERN.test(header);

  return jobs.map((job) => {
    const steps = splitSteps(job.text);
    const checkoutSteps = steps.filter((s) =>
      /uses\s*:\s*['"]?actions\/checkout@/.test(s)
    );
    const usesAgentApiKey =
      headerAgentKey ||
      AGENT_KEY_PATTERN.test(job.text) ||
      /\b(?:anthropic_api_key|claude_code_oauth_token|openai_api_key|gemini_api_key)\s*:/i.test(
        job.text
      );
    return {
      name: job.name,
      checkName: readJobDisplayName(job.text) ?? job.name,
      usesSecrets: headerSecrets || referencesRepositorySecrets(job.text),
      usesAgentApiKey,
      isAgentJob: AGENT_ACTION_PATTERN.test(job.text) || usesAgentApiKey,
      agentShellTools: AGENT_SHELL_PATTERN.test(job.text),
      installsPackages: INSTALL_PATTERN.test(job.text),
      runsPackageScripts: SCRIPT_PATTERN.test(job.text),
      usesCheckout: checkoutSteps.length > 0,
      checkoutPersistsCredentials: checkoutSteps.some(
        (s) => !/persist-credentials\s*:\s*['"]?false['"]?/.test(s)
      ),
      pushes: jobPushes(job.text, header),
      socketFirewall: SOCKET_FIREWALL_PATTERN.test(job.text),
    };
  });
}
