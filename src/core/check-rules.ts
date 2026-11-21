/**
 * Zero-dependency static anti-pattern & escape-hatch verifier.
 * Enforces zero `any`, zero suppression comments, zero DOM globals in pure layers,
 * and zero non-erasable TypeScript syntax (`enum`, `namespace`).
 * Layer 2 (`src/core/`).
 */
import fs from 'node:fs';
import path from 'node:path';

export interface StaticRuleViolation {
  readonly rule: string;
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

export interface StaticRulesResult {
  readonly ok: boolean;
  readonly filesChecked: number;
  readonly violations: readonly StaticRuleViolation[];
}

function toPosix(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function collectFiles(root: string, subdirs: readonly string[]): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        files.push(full);
      }
    }
  };
  for (const sub of subdirs) {
    walk(path.join(root, sub));
  }
  return files.sort();
}

const SUPPRESSION_PATTERN =
  /@ts-(?:ignore|expect-error|nocheck)|(?:eslint|oxlint)-disable/;

const EXPLICIT_ANY_PATTERN = /(?:[:<,]\s*|\bas\s+)any\b/;

const NON_ERASABLE_TS_PATTERN = /^\s*(?:export\s+)?(?:const\s+)?(?:enum|namespace)\s+\w+/;

const DOM_GLOBALS_PATTERN = /\b(?:window|document|HTMLElement|localStorage)\b/;

function stripStringLiterals(line: string): string {
  return line
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
}

export function checkSourceContent(
  relFile: string,
  content: string
): StaticRuleViolation[] {
  const violations: StaticRuleViolation[] = [];
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const isPureLayer =
    relFile.startsWith('src/shared/') || relFile.startsWith('src/domain/');
  const isRuleEngineSelf = relFile === 'src/core/check-rules.ts';

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();
    const isCommentLine =
      trimmed.startsWith('//') ||
      trimmed.startsWith('*') ||
      trimmed.startsWith('/*');

    if (!isRuleEngineSelf && SUPPRESSION_PATTERN.test(rawLine)) {
      violations.push({
        rule: 'no-suppression-directives',
        file: relFile,
        line: i + 1,
        message:
          'Suppression directives (@ts-ignore, @ts-expect-error, @ts-nocheck, eslint/oxlint-disable) are forbidden.',
      });
    }

    if (isCommentLine) continue;
    const codeOnly = stripStringLiterals(
      rawLine.replace(/(^|[^:\\])\/\/.*$/, '$1')
    );

    if (!isRuleEngineSelf && EXPLICIT_ANY_PATTERN.test(codeOnly)) {
      violations.push({
        rule: 'no-explicit-any',
        file: relFile,
        line: i + 1,
        message:
          'Explicit `any` is forbidden. Use `unknown` with runtime type guards in src/shared/contracts.ts.',
      });
    }

    if (!isRuleEngineSelf && NON_ERASABLE_TS_PATTERN.test(codeOnly)) {
      violations.push({
        rule: 'erasable-ts-only',
        file: relFile,
        line: i + 1,
        message:
          'Non-erasable TypeScript syntax (`enum`, `namespace`) breaks Node native type stripping. Use `as const` objects and union types.',
      });
    }

    if (isPureLayer && DOM_GLOBALS_PATTERN.test(codeOnly)) {
      violations.push({
        rule: 'no-dom-in-pure-layers',
        file: relFile,
        line: i + 1,
        message:
          'Browser DOM globals are forbidden in src/shared/ and src/domain/.',
      });
    }
  }

  return violations;
}

export function runStaticRulesCheck(root: string): StaticRulesResult {
  const files = collectFiles(root, ['src', 'tests']);
  const violations: StaticRuleViolation[] = [];
  for (const abs of files) {
    const rel = toPosix(path.relative(root, abs));
    const content = fs.readFileSync(abs, 'utf8');
    violations.push(...checkSourceContent(rel, content));
  }
  return {
    ok: violations.length === 0,
    filesChecked: files.length,
    violations,
  };
}
