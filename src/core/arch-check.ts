/**
 * Zero-dependency architectural boundary and circular-dependency verifier.
 * Layer 2 (`src/core/`).
 */
import fs from 'node:fs';
import path from 'node:path';

export interface ArchViolation {
  readonly rule: string;
  readonly file: string;
  readonly line: number;
  readonly specifier: string;
  readonly message: string;
}

interface BoundaryRule {
  readonly name: string;
  readonly from: RegExp;
  readonly forbidSpecifier?: RegExp;
  readonly forbidResolved?: RegExp;
  readonly guidance: string;
}

export const BOUNDARY_RULES: readonly BoundaryRule[] = [
  {
    name: 'pure-shared-layer',
    from: /^src\/shared\//,
    forbidResolved: /^src\/(domain|core|adapters|cli\.ts)/,
    guidance:
      'src/shared/ holds pure domain types and runtime guards only. It must not import from domain, core, adapters, or cli.',
  },
  {
    name: 'no-node-in-shared',
    from: /^src\/shared\//,
    forbidSpecifier: /^node:/,
    guidance: 'src/shared/ must remain runtime-agnostic with zero node:* imports.',
  },
  {
    name: 'pure-domain-layer',
    from: /^src\/domain\//,
    forbidResolved: /^src\/(core|adapters|cli\.ts)/,
    guidance:
      'src/domain/ must remain pure business logic and invariants. Import only from src/domain/ or src/shared/.',
  },
  {
    name: 'no-node-in-domain',
    from: /^src\/domain\//,
    forbidSpecifier: /^node:/,
    guidance:
      'src/domain/ must not import Node built-ins (node:*). Inject I/O or crypto helpers from src/core/.',
  },
  {
    name: 'core-isolation',
    from: /^src\/core\//,
    forbidResolved: /^src\/(adapters|cli\.ts)/,
    guidance:
      'src/core/ cannot import external adapters (src/adapters/) or CLI orchestration (src/cli.ts).',
  },
  {
    name: 'adapters-no-cli',
    from: /^src\/adapters\//,
    forbidResolved: /^src\/cli\.ts$/,
    guidance: 'src/adapters/ must not import src/cli.ts.',
  },
  {
    name: 'zero-third-party-runtime-imports',
    from: /^src\//,
    forbidSpecifier: /^(?!\.|node:)/,
    guidance:
      'agentic-uplift core maintains zero third-party runtime dependencies. Only relative .ts imports and node:* built-ins are allowed under src/.',
  },
];

const IMPORT_PATTERNS: readonly RegExp[] = [
  /(?:^|\n)\s*import\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g,
  /(?:^|\n)\s*export\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
}

function lineNumberAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (source.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function toPosix(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function collectTsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      results.push(full);
    }
  }
  return results.sort();
}

export function extractImports(
  source: string
): Array<{ readonly specifier: string; readonly line: number }> {
  const cleaned = stripComments(source);
  const found: Array<{ readonly specifier: string; readonly line: number }> = [];
  for (const pattern of IMPORT_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    for (const match of cleaned.matchAll(regex)) {
      const specifier = match[1];
      if (!specifier) continue;
      found.push({
        specifier,
        line: lineNumberAt(cleaned, match.index),
      });
    }
  }
  return found;
}

function detectCycles(
  adjacency: ReadonlyMap<string, readonly string[]>
): string[][] {
  const visited = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const seenSignatures = new Set<string>();

  function dfs(node: string): void {
    visited.add(node);
    active.add(node);
    stack.push(node);

    for (const next of adjacency.get(node) ?? []) {
      if (!adjacency.has(next)) continue;
      if (active.has(next)) {
        const start = stack.indexOf(next);
        const cycle = [...stack.slice(start), next];
        const sig = [...cycle.slice(0, -1)].sort().join('->');
        if (!seenSignatures.has(sig)) {
          seenSignatures.add(sig);
          cycles.push(cycle);
        }
      } else if (!visited.has(next)) {
        dfs(next);
      }
    }

    stack.pop();
    active.delete(node);
  }

  for (const node of adjacency.keys()) {
    if (!visited.has(node)) dfs(node);
  }
  return cycles;
}

export interface ArchCheckResult {
  readonly ok: boolean;
  readonly filesChecked: number;
  readonly ruleCount: number;
  readonly violations: readonly ArchViolation[];
}

export function runArchCheck(root: string): ArchCheckResult {
  const srcDir = path.join(root, 'src');
  const files = collectTsFiles(srcDir);
  const violations: ArchViolation[] = [];
  const adjacency = new Map<string, string[]>();

  for (const absFile of files) {
    const relFile = toPosix(path.relative(root, absFile));
    const source = fs.readFileSync(absFile, 'utf8');
    const imports = extractImports(source);
    const deps: string[] = [];

    for (const imp of imports) {
      let resolvedRel: string | null = null;
      if (imp.specifier.startsWith('.')) {
        if (!imp.specifier.endsWith('.ts')) {
          violations.push({
            rule: 'explicit-ts-extension',
            file: relFile,
            line: imp.line,
            specifier: imp.specifier,
            message:
              'Relative imports must end with explicit `.ts` extension so Node native type stripping executes directly.',
          });
        }
        const absTarget = path.resolve(path.dirname(absFile), imp.specifier);
        resolvedRel = toPosix(path.relative(root, absTarget));
        if (resolvedRel.startsWith('src/')) {
          deps.push(resolvedRel);
        }
      }

      for (const rule of BOUNDARY_RULES) {
        if (!rule.from.test(relFile)) continue;
        if (rule.forbidSpecifier && rule.forbidSpecifier.test(imp.specifier)) {
          violations.push({
            rule: rule.name,
            file: relFile,
            line: imp.line,
            specifier: imp.specifier,
            message: rule.guidance,
          });
        }
        if (
          rule.forbidResolved &&
          resolvedRel !== null &&
          rule.forbidResolved.test(resolvedRel)
        ) {
          violations.push({
            rule: rule.name,
            file: relFile,
            line: imp.line,
            specifier: imp.specifier,
            message: rule.guidance,
          });
        }
      }
    }
    adjacency.set(relFile, deps);
  }

  for (const cycle of detectCycles(adjacency)) {
    violations.push({
      rule: 'no-circular-dependencies',
      file: cycle[0],
      line: 1,
      specifier: cycle.join(' -> '),
      message: `Circular dependency detected: ${cycle.join(' -> ')}`,
    });
  }

  // +2 accounts for explicit-ts-extension and no-circular-dependencies
  const ruleCount = BOUNDARY_RULES.length + 2;
  return {
    ok: violations.length === 0,
    filesChecked: files.length,
    ruleCount,
    violations,
  };
}
