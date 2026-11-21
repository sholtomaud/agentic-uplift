/**
 * Buildless, zero-dependency native Web Components Flight Deck for Agentic Uplift.
 * Renders the exact versioned JSON control plane (`data/{status,audit,proof,gate}.json`)
 * with aviation annunciator lamps, 240° SVG instrument dials, repo-specific `gh` CLI
 * manual uplift commands, and a live first-class agentic JSON query console.
 */

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/* --- Precision 240° SVG Instrument Dial Geometry (polar arc + needle + target bug) --- */
const DIAL_START = -120;
const DIAL_SWEEP = 240;

function dialAngle(pct) {
  const clamped = Math.min(100, Math.max(0, pct));
  return DIAL_START + (clamped / 100) * DIAL_SWEEP;
}

function polar(cx, cy, r, deg) {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function arcPath(cx, cy, r, fromDeg, toDeg) {
  const start = polar(cx, cy, r, fromDeg);
  const end = polar(cx, cy, r, toDeg);
  const largeArc = toDeg - fromDeg > 180 ? 1 : 0;
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}

function renderDialSvg({ value, bands, target = null, ticks = [], label, compact = false }) {
  const cx = 100;
  const cy = 100;
  const r = compact ? 74 : 78;
  const strokeW = compact ? 14 : 12;
  const parts = [];

  parts.push(
    `<path d="${arcPath(cx, cy, r, DIAL_START, DIAL_START + DIAL_SWEEP)}" class="dial-track" style="stroke-width:${strokeW}"></path>`
  );

  for (const band of bands) {
    const opacity = value === null ? '0.25' : '1';
    parts.push(
      `<path d="${arcPath(cx, cy, r, dialAngle(band.from), dialAngle(band.to))}" class="dial-band" style="stroke:${band.color};stroke-width:${strokeW};opacity:${opacity}"></path>`
    );
  }

  for (const tick of ticks) {
    const a = dialAngle(tick);
    const inner = polar(cx, cy, r - 14, a);
    const outer = polar(cx, cy, r - 6, a);
    const at = polar(cx, cy, r - 26, a);
    parts.push(
      `<line x1="${inner.x.toFixed(1)}" y1="${inner.y.toFixed(1)}" x2="${outer.x.toFixed(1)}" y2="${outer.y.toFixed(1)}" class="dial-tick"></line>`,
      `<text x="${at.x.toFixed(1)}" y="${(at.y + 3.5).toFixed(1)}" class="dial-tick-label">${tick}</text>`
    );
  }

  if (target !== null && value !== null && target > value) {
    const a = dialAngle(target);
    const tip = polar(cx, cy, r + 7, a);
    const left = polar(cx, cy, r + 17, a - 4.5);
    const right = polar(cx, cy, r + 17, a + 4.5);
    parts.push(
      `<path d="M ${tip.x.toFixed(1)} ${tip.y.toFixed(1)} L ${left.x.toFixed(1)} ${left.y.toFixed(1)} L ${right.x.toFixed(1)} ${right.y.toFixed(1)} Z" class="dial-target"><title>Projected after fixes: ${target}%</title></path>`
    );
  }

  if (value !== null) {
    const a = dialAngle(value);
    const tip = polar(cx, cy, r - 10, a);
    const tail = polar(cx, cy, 12, a + 180);
    parts.push(
      `<line x1="${tail.x.toFixed(1)}" y1="${tail.y.toFixed(1)}" x2="${tip.x.toFixed(1)}" y2="${tip.y.toFixed(1)}" class="dial-needle"></line>`,
      `<circle cx="${cx}" cy="${cy}" r="${compact ? 5 : 6}" class="dial-hub"></circle>`
    );
  }

  return `<svg viewBox="0 0 200 184" class="dial" role="img" aria-label="${escapeHtml(label)}">${parts.join('')}</svg>`;
}

const READINESS_BANDS = [
  { from: 0, to: 50, color: 'var(--critical)' },
  { from: 50, to: 85, color: 'var(--warning)' },
  { from: 85, to: 100, color: 'var(--good)' },
];

const HEALTH_BANDS = [
  { from: 0, to: 70, color: 'var(--critical)' },
  { from: 70, to: 90, color: 'var(--warning)' },
  { from: 90, to: 100, color: 'var(--good)' },
];

/* --- Client-side mirror of Agentic JSON Query Engine --- */
function evalSimpleQuery(bundle, expr) {
  const cleaned = String(expr || '').trim().replace(/^\$\.?/, '');
  if (!cleaned) return { schema_version: 1, query: expr, found: true, value: bundle };

  const tokens = [];
  let i = 0;
  let buf = '';
  const flush = () => {
    if (buf.trim()) tokens.push({ kind: 'prop', name: buf.trim() });
    buf = '';
  };

  while (i < cleaned.length) {
    const ch = cleaned[i];
    if (ch === '.') {
      flush();
      i += 1;
    } else if (ch === '[') {
      flush();
      const close = cleaned.indexOf(']', i + 1);
      if (close === -1) break;
      const inner = cleaned.slice(i + 1, close).trim();
      if (/^\d+$/.test(inner)) {
        tokens.push({ kind: 'index', index: Number.parseInt(inner, 10) });
      } else {
        const preds = inner
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean)
          .map((p) => {
            const neq = p.indexOf('!=');
            if (neq !== -1) {
              return {
                key: p.slice(0, neq).trim(),
                op: '!=',
                val: p.slice(neq + 2).trim().replace(/^['"]|['"]$/g, ''),
              };
            }
            const eq = p.indexOf('=');
            return {
              key: p.slice(0, eq).trim(),
              op: '=',
              val: p.slice(eq + 1).trim().replace(/^['"]|['"]$/g, ''),
            };
          });
        tokens.push({ kind: 'filter', preds });
      }
      i = close + 1;
    } else {
      buf += ch;
      i += 1;
    }
  }
  flush();

  let cur = bundle;
  for (const tok of tokens) {
    if (cur === null || cur === undefined) {
      return { schema_version: 1, query: expr, found: false, value: null };
    }
    if (tok.kind === 'prop') {
      if (Array.isArray(cur) && (tok.name === 'length' || tok.name === 'count')) {
        cur = cur.length;
      } else if (Array.isArray(cur)) {
        cur = cur
          .map((item) => (item && typeof item === 'object' ? item[tok.name] : undefined))
          .filter((v) => v !== undefined);
      } else if (typeof cur === 'object' && tok.name in cur) {
        cur = cur[tok.name];
      } else {
        return { schema_version: 1, query: expr, found: false, value: null };
      }
    } else if (tok.kind === 'index') {
      if (!Array.isArray(cur) || tok.index >= cur.length) {
        return { schema_version: 1, query: expr, found: false, value: null };
      }
      cur = cur[tok.index];
    } else if (tok.kind === 'filter') {
      if (!Array.isArray(cur)) {
        return { schema_version: 1, query: expr, found: false, value: null };
      }
      cur = cur.filter((item) => {
        if (!item || typeof item !== 'object') return false;
        return tok.preds.every((p) => {
          const actual = String(item[p.key]);
          return p.op === '=' ? actual === p.val : actual !== p.val;
        });
      });
    }
  }
  return { schema_version: 1, query: expr, found: true, value: cur };
}

function projectedScoreAfterFixes(checks) {
  let earned = 0;
  let total = 0;
  for (const c of checks) {
    if (c.status === 'waiting') continue;
    const w = c.impact === 'high' ? 3 : c.impact === 'medium' ? 2 : 1;
    total += w;
    if (c.status === 'pass' || (c.fixes && c.fixes.length > 0)) {
      earned += w;
    } else if (c.status === 'improve') {
      earned += w * 0.5;
    }
  }
  return total > 0 ? Math.round((earned / total) * 100) : 100;
}

class UpliftCockpit extends HTMLElement {
  constructor() {
    super();
    this.bundle = null;
    this.queryExpr = 'audit.manual_commands';
    this.onlyNonPassing = false;
    this.selectedGroup = null;
    this.theme = localStorage.getItem('uplift-theme') || '';
    if (this.theme) {
      document.documentElement.setAttribute('data-theme', this.theme);
    }
  }

  async connectedCallback() {
    this.innerHTML = `<main class="shell"><div class="card"><p class="eyebrow">Loading Agentic Uplift Flight Deck…</p></div></main>`;
    try {
      const [status, audit, proof, gate] = await Promise.all([
        fetch('data/status.json').then((r) => r.json()),
        fetch('data/audit.json').then((r) => r.json()),
        fetch('data/proof.json').then((r) => r.json()),
        fetch('data/gate.json').then((r) => r.json()),
      ]);
      this.bundle = { status, audit, proof, gate };
      this.render();
    } catch (err) {
      this.innerHTML = `<main class="shell"><div class="card"><h2>Failed to load JSON endpoints</h2><pre class="code-block">${escapeHtml(String(err))}</pre></div></main>`;
    }
  }

  toggleTheme() {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const current = this.theme || (prefersDark ? 'dark' : 'light');
    this.theme = current === 'dark' ? 'light' : 'dark';
    localStorage.setItem('uplift-theme', this.theme);
    document.documentElement.setAttribute('data-theme', this.theme);
    this.render();
  }

  render() {
    if (!this.bundle) return;
    const { status, audit, proof, gate } = this.bundle;
    const manualCommands = Array.isArray(audit.manual_commands)
      ? audit.manual_commands
      : [];
    const requiredManual = manualCommands.filter((m) => m.status === 'required');
    const pendingManual = manualCommands.filter((m) => m.status !== 'done');
    const projected = projectedScoreAfterFixes(audit.checks);

    // Annunciator lamp states (dark when normal, amber/red ONLY when abnormal)
    const proofState = !proof.ok
      ? 'warning'
      : !proof.changelog.valid
        ? 'caution'
        : 'normal';
    const autonomyState =
      status.summary.autonomy === 'not-ready'
        ? 'warning'
        : status.summary.autonomy === 'supervised'
          ? 'caution'
          : 'normal';
    const blockersState = status.summary.blockers_count > 0 ? 'warning' : 'normal';
    const ciFailingCount = status.ci ? status.ci.failing_workflows.length : 0;
    const ciState = ciFailingCount > 0 ? 'warning' : 'normal';
    const gateState =
      gate.decision.reason === 'proof-seal-broken' ||
      gate.decision.reason === 'agentic-budget-exceeded'
        ? 'warning'
        : gate.decision.reason === 'open-agent-pr-cap' ||
            gate.decision.reason === 'ci-failing-on-main'
          ? 'caution'
          : 'normal';
    const manualState = requiredManual.length > 0 ? 'caution' : 'normal';

    const states = [
      proofState,
      autonomyState,
      blockersState,
      ciState,
      gateState,
      manualState,
    ];
    const masterState = states.includes('warning')
      ? 'warning'
      : states.includes('caution')
        ? 'caution'
        : 'normal';
    const masterText =
      masterState === 'warning'
        ? 'MASTER WARNING'
        : masterState === 'caution'
          ? 'MASTER CAUTION'
          : 'ALL NOMINAL';

    const ciPct =
      status.ci && status.ci.pass_rate !== null
        ? Math.round(status.ci.pass_rate * 100)
        : null;
    const proofPct = proof.ok ? (proof.changelog.valid ? 100 : 85) : 0;

    const visibleChecks = audit.checks.filter((c) => {
      if (this.onlyNonPassing && c.status === 'pass') return false;
      if (this.selectedGroup && c.group !== this.selectedGroup) return false;
      return true;
    });

    const qResult = evalSimpleQuery(this.bundle, this.queryExpr);
    const allPendingScript = pendingManual
      .map((m) => `# ${m.title}\n${m.command}`)
      .join('\n\n');

    this.innerHTML = `
      <header class="topbar">
        <div class="topbar-inner">
          <div class="brand">
            <h1>${escapeHtml(status.repository)}</h1>
            <span class="pill ${escapeHtml(status.summary.autonomy)}">${escapeHtml(status.summary.autonomy)}</span>
            <span class="brand-meta">
              ${escapeHtml(status.mode)} · ${escapeHtml(status.generated_at)}
              ${status.run_url ? ` · <a href="${escapeHtml(status.run_url)}" target="_blank" rel="noopener">workflow run ↗</a>` : ''}
            </span>
          </div>
          <nav class="nav-links" aria-label="Sections">
            <a href="#flight-deck">Flight Deck</a>
            <a href="#manual-uplift">gh CLI Runbook (${pendingManual.length})</a>
            <a href="#audit-checks">Audit (${audit.readiness.passed}/${audit.readiness.total})</a>
            <a href="#agent-api">Agent JSON API</a>
            <button id="theme-toggle" class="theme-btn" type="button" title="Toggle light/dark theme">◐ Theme</button>
          </nav>
        </div>
      </header>

      <main class="shell">
        <!-- Dark-Bezel Aviation Annunciator Panel -->
        <section class="annunciator" aria-label="System Annunciator">
          <a href="#manual-uplift" class="master" data-state="${masterState}">
            <span>${masterText}</span>
            <small>${masterState === 'normal' ? 'No active faults' : 'Inspect lit tiles'}</small>
          </a>
          <ul class="tiles">
            <li>
              <a href="#flight-deck" class="tile" data-state="${proofState}">
                <strong>Proof Seal</strong>
                <span>${proof.ok ? `Intact (${proof.locked_files} files)` : `${proof.violations.length} tamper fault(s)`}</span>
              </a>
            </li>
            <li>
              <a href="#flight-deck" class="tile" data-state="${autonomyState}">
                <strong>Autonomy</strong>
                <span>${escapeHtml(status.summary.autonomy)} (${status.summary.readiness_score}%)</span>
              </a>
            </li>
            <li>
              <a href="#audit-checks" class="tile" data-state="${blockersState}">
                <strong>Blockers</strong>
                <span>${status.summary.blockers_count === 0 ? '0 blocking' : `${status.summary.blockers_count} blocking`}</span>
              </a>
            </li>
            <li>
              <a href="#flight-deck" class="tile" data-state="${ciState}">
                <strong>CI Health</strong>
                <span>${ciFailingCount > 0 ? `${ciFailingCount} failing` : ciPct !== null ? `${ciPct}% passing` : 'Offline'}</span>
              </a>
            </li>
            <li>
              <a href="#flight-deck" class="tile" data-state="${gateState}">
                <strong>Resolve Gate</strong>
                <span>${escapeHtml(gate.decision.reason)}</span>
              </a>
            </li>
            <li>
              <a href="#manual-uplift" class="tile" data-state="${manualState}">
                <strong>Manual gh CLI</strong>
                <span>${requiredManual.length > 0 ? `${requiredManual.length} required` : `${pendingManual.length} optional`}</span>
              </a>
            </li>
          </ul>
          <div class="annunciator-note">
            <span>Tiles remain dark while nominal and illuminate only when abnormal.</span>
            <span>Zero runtime deps · ${status.repo.file_count} files · ${status.repo.test_file_count} test files</span>
          </div>
        </section>

        <!-- Primary 3-Instrument Flight Deck -->
        <section id="flight-deck" class="deck-row" aria-label="Primary Instruments">
          <article class="card instrument">
            <div class="instrument-head">
              <h3>Autonomy Readiness</h3>
              <span class="better">Higher is better · ▲ post-fix target</span>
              <p>Distance to fully hardened autonomous maintenance.</p>
            </div>
            <div class="dial-wrap">
              ${renderDialSvg({
                value: status.summary.readiness_score,
                bands: READINESS_BANDS,
                target: projected > status.summary.readiness_score ? projected : null,
                ticks: [0, 25, 50, 75, 100],
                label: `Autonomy readiness ${status.summary.readiness_score} percent`,
              })}
              <div class="dial-figure">
                <span class="readout boxed tabular">${status.summary.readiness_score}%</span>
                <span class="readout-unit">${escapeHtml(status.summary.autonomy)}</span>
              </div>
            </div>
            <dl class="kv-list">
              <dt>Checks passed</dt><dd class="tabular">${audit.readiness.passed} / ${audit.readiness.total}</dd>
              <dt>Autonomy blockers</dt><dd class="tabular">${audit.readiness.blockers.length}</dd>
              <dt>Projected with fixes</dt><dd class="tabular" style="color:var(--target)">${projected}%</dd>
              <dt>Waiting on history</dt><dd class="tabular">${audit.readiness.waiting}</dd>
            </dl>
          </article>

          <article class="card instrument">
            <div class="instrument-head">
              <h3>Cryptographic Proof Seal</h3>
              <span class="better">Tier-0 Tamper Integrity</span>
              <p>SHA-256 lock across harness (Zone A), tests (Zone B) & floors (Zone C).</p>
            </div>
            <div class="dial-wrap">
              ${renderDialSvg({
                value: proofPct,
                bands: HEALTH_BANDS,
                ticks: [0, 50, 100],
                label: `Proof seal ${proof.ok ? 'intact' : 'broken'}`,
              })}
              <div class="dial-figure">
                <span class="readout boxed tabular">${proof.ok ? 'INTACT' : 'BROKEN'}</span>
                <span class="readout-unit">${proof.locked_files} sealed files</span>
              </div>
            </div>
            <dl class="kv-list">
              <dt>Zone A (harness + hooks)</dt><dd class="tabular">${proof.harness_files} files</dd>
              <dt>Zone B (locked tests)</dt><dd class="tabular">${proof.test_files} files</dd>
              <dt>Zone C floors (unit / prop)</dt><dd class="tabular">${proof.metric_floors ? `${proof.metric_floors.minUnitTests} / ${proof.metric_floors.minPropertyTests}` : 'none'}</dd>
              <dt>Root SHA-256</dt><dd>${escapeHtml((proof.root_sha256 || 'none').slice(0, 14))}…</dd>
              <dt>Changelog chain</dt><dd>${proof.changelog.valid ? `valid (${proof.changelog.count})` : 'BROKEN'}</dd>
            </dl>
          </article>

          <article class="card instrument">
            <div class="instrument-head">
              <h3>CI Health &amp; Circuit Breaker</h3>
              <span class="better">Default branch · ${escapeHtml(status.repo.default_branch)}</span>
              <p>Live default-branch CI reliability &amp; guarded autonomous gate.</p>
            </div>
            <div class="dial-wrap">
              ${renderDialSvg({
                value: ciPct,
                bands: HEALTH_BANDS,
                ticks: [0, 50, 100],
                label: ciPct !== null ? `CI pass rate ${ciPct} percent` : 'CI health awaiting runs',
              })}
              <div class="dial-figure">
                <span class="readout boxed tabular">${ciPct !== null ? `${ciPct}%` : 'WAIT'}</span>
                <span class="readout-unit">${status.ci ? `${status.ci.passing_runs}/${status.ci.total_runs} runs` : 'local mode'}</span>
              </div>
            </div>
            <dl class="kv-list">
              <dt>Resolve gate</dt><dd>${gate.decision.proceed ? 'OPEN' : 'PAUSED'} (${escapeHtml(gate.decision.reason)})</dd>
              <dt>Open agent PRs</dt><dd class="tabular">${gate.constraints.open_agent_prs} / ${gate.constraints.max_open_agent_prs}</dd>
              <dt>Monthly agent budget</dt><dd class="tabular">${gate.constraints.agentic_monthly_budget !== null ? `$${gate.constraints.agentic_monthly_budget}` : 'unset'}</dd>
              <dt>7d bug doom ratio</dt><dd class="tabular">${status.issues && status.issues.doom_loop_ratio_7d !== null ? `${status.issues.doom_loop_ratio_7d}×` : '—'}</dd>
              <dt>Zero runtime deps</dt><dd>${status.repo.zero_runtime_deps === true ? 'YES' : status.repo.zero_runtime_deps === false ? 'NO' : '—'}</dd>
            </dl>
          </article>
        </section>

        <!-- 6 Pillar Mini-Dials -->
        <section class="card" aria-label="Readiness by Pillar">
          <div class="panel-head">
            <div>
              <div class="eyebrow">Pillar Breakdown</div>
              <h2>Readiness by Audit Group</h2>
              <p>Click any pillar dial to filter the audit checks below.</p>
            </div>
            ${this.selectedGroup ? `<button id="clear-group" class="btn" type="button">Clear filter: ${escapeHtml(this.selectedGroup)} ×</button>` : ''}
          </div>
          <div class="mini-grid">
            ${audit.readiness.groups
              .map(
                (g) => `
              <button type="button" class="mini-dial-card ${this.selectedGroup === g.group ? 'active' : ''}" data-group="${escapeHtml(g.group)}">
                <div class="dial-wrap">
                  ${renderDialSvg({
                    value: g.score,
                    bands: READINESS_BANDS,
                    label: `${g.group} ${g.score} percent`,
                    compact: true,
                  })}
                  <div class="dial-figure">
                    <span class="readout tabular">${g.score}%</span>
                  </div>
                </div>
                <span class="mini-title">${escapeHtml(g.group)}</span>
                <span class="mini-sub">${g.passed}/${g.total} passed</span>
              </button>`
              )
              .join('')}
          </div>
        </section>

        <!-- Manual Uplift Runbook (gh CLI commands) -->
        <section id="manual-uplift" class="card" aria-label="Manual gh CLI Uplift Runbook">
          <div class="panel-head">
            <div>
              <div class="eyebrow">Human Maintainer Runbook</div>
              <h2>Manual Uplift Tasks (<code>gh</code> CLI Commands)</h2>
              <p>Repository settings, rulesets, labels, secrets, and local git hooks that CI cannot configure automatically. Pre-filled for <code>${escapeHtml(status.repository)}</code>.</p>
            </div>
            ${
              pendingManual.length > 0
                ? `<button type="button" class="btn primary copy-btn" data-copy="${escapeHtml(allPendingScript)}">Copy all ${pendingManual.length} commands</button>`
                : ''
            }
          </div>
          <div class="runbook-list">
            ${manualCommands
              .map(
                (item) => `
              <article class="cmd-card">
                <div class="cmd-head">
                  <div class="cmd-title">
                    <span class="pill ${escapeHtml(item.status)}">${escapeHtml(item.status)}</span>
                    <span class="pill neutral">${escapeHtml(item.category)}</span>
                    <span>${escapeHtml(item.title)}</span>
                  </div>
                  <button type="button" class="btn copy-btn" data-copy="${escapeHtml(item.command)}">Copy command</button>
                </div>
                <p class="cmd-why">${escapeHtml(item.why)}</p>
                <pre class="code-block"><code>${escapeHtml(item.command)}</code></pre>
              </article>`
              )
              .join('')}
          </div>
        </section>

        <!-- Expandable Audit Checks -->
        <section id="audit-checks" class="card" aria-label="Audit Checks">
          <div class="panel-head">
            <div>
              <div class="eyebrow">Deterministic Inspection</div>
              <h2>Audit Checks (${visibleChecks.length} shown · ${audit.readiness.passed}/${audit.readiness.total} passed)</h2>
              <p>Expand any check for evidence, rationale, verification command, and copyable fixes.</p>
            </div>
            <div class="filter-bar">
              <button id="toggle-nonpass" class="btn" type="button">${this.onlyNonPassing ? 'Show all checks' : 'Show non-passing only'}</button>
            </div>
          </div>
          <div class="check-list">
            ${visibleChecks
              .map(
                (c) => `
              <details class="check-item" ${c.status === 'missing' || c.status === 'improve' ? 'open' : ''}>
                <summary>
                  <span class="pill ${escapeHtml(c.status)}">${escapeHtml(c.status)}</span>
                  <div class="check-summary-main">
                    <strong>${escapeHtml(c.title)}</strong>
                    <span>${escapeHtml(c.evidence)}</span>
                  </div>
                  <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
                    ${c.blocks_autonomy && c.status !== 'pass' ? '<span class="pill blocker">blocker</span>' : ''}
                    <span class="pill neutral">${escapeHtml(c.group)}</span>
                  </div>
                </summary>
                <div class="check-body">
                  <p><strong>Why it matters:</strong> ${escapeHtml(c.why)}</p>
                  ${c.recommendation ? `<p><strong>Action:</strong> ${escapeHtml(c.recommendation)}</p>` : ''}
                  <div class="cli-echo">
                    <span>Verify: <code>${escapeHtml(c.verify_command)}</code></span>
                    <button type="button" class="btn copy-btn" data-copy="${escapeHtml(c.verify_command)}">Copy verify</button>
                  </div>
                  ${(c.fixes || [])
                    .map(
                      (fix) => `
                    <div>
                      <div class="cli-echo">
                        <span>${fix.path ? `File: <code>${escapeHtml(fix.path)}</code>` : 'Run in terminal:'}</span>
                        <button type="button" class="btn copy-btn" data-copy="${escapeHtml(fix.content)}">Copy fix</button>
                      </div>
                      <pre class="code-block"><code>${escapeHtml(fix.content)}</code></pre>
                    </div>`
                    )
                    .join('')}
                </div>
              </details>`
              )
              .join('')}
          </div>
        </section>

        <!-- First-Class Agentic JSON API & Live Query Console -->
        <section id="agent-api" class="card" aria-label="Agentic JSON API">
          <div class="panel-head">
            <div>
              <div class="eyebrow">Machine-First Control Plane</div>
              <h2>First-Class Agentic JSON Queries</h2>
              <p>Autonomous agents read these exact schema-validated endpoints directly or query them locally via CLI without scraping HTML.</p>
            </div>
          </div>
          <nav class="endpoints-bar" aria-label="JSON Endpoints">
            <a href="data/status.json">data/status.json</a>
            <a href="data/audit.json">data/audit.json</a>
            <a href="data/proof.json">data/proof.json</a>
            <a href="data/gate.json">data/gate.json</a>
            <a href="schemas/status-v1.json">schemas/status-v1.json</a>
            <a href="schemas/audit-v1.json">schemas/audit-v1.json</a>
            <a href="schemas/proof-v1.json">schemas/proof-v1.json</a>
            <a href="schemas/gate-v1.json">schemas/gate-v1.json</a>
            <a href="llms.txt">llms.txt</a>
          </nav>
          <div class="query-row">
            <input id="q-input" type="text" value="${escapeHtml(this.queryExpr)}" aria-label="JSON Query Expression" />
            <button id="q-run" class="btn primary" type="button">Run Query</button>
          </div>
          <div class="chips">
            <button class="btn chip-q" data-q="status.summary">status.summary</button>
            <button class="btn chip-q" data-q="audit.manual_commands">audit.manual_commands</button>
            <button class="btn chip-q" data-q="audit.readiness.blockers">audit.readiness.blockers</button>
            <button class="btn chip-q" data-q="audit.checks[status!=pass].id">non-passing checks</button>
            <button class="btn chip-q" data-q="proof.metric_floors">proof.metric_floors</button>
            <button class="btn chip-q" data-q="gate.decision">gate.decision</button>
          </div>
          <div class="cli-echo">
            <span>CLI: <code>node src/cli.ts query "${escapeHtml(this.queryExpr)}"</code></span>
            <button type="button" class="btn copy-btn" data-copy='node src/cli.ts query "${escapeHtml(this.queryExpr)}"'>Copy CLI query</button>
          </div>
          <pre class="code-block"><code>${escapeHtml(JSON.stringify(qResult, null, 2))}</code></pre>
        </section>

        <footer class="foot">
          Published by <strong>agentic-uplift</strong> · Zero third-party runtime dependencies · Schema v1
        </footer>
      </main>
    `;

    this.wireEvents();
  }

  wireEvents() {
    this.querySelector('#theme-toggle')?.addEventListener('click', () => {
      this.toggleTheme();
    });

    const input = this.querySelector('#q-input');
    const runQuery = () => {
      if (input instanceof HTMLInputElement) {
        this.queryExpr = input.value;
        this.render();
      }
    };
    this.querySelector('#q-run')?.addEventListener('click', runQuery);
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') runQuery();
    });

    for (const chip of this.querySelectorAll('.chip-q')) {
      chip.addEventListener('click', () => {
        const q = chip.getAttribute('data-q');
        if (q) {
          this.queryExpr = q;
          this.render();
        }
      });
    }

    for (const card of this.querySelectorAll('.mini-dial-card')) {
      card.addEventListener('click', () => {
        const group = card.getAttribute('data-group');
        this.selectedGroup = this.selectedGroup === group ? null : group;
        this.render();
      });
    }

    this.querySelector('#clear-group')?.addEventListener('click', () => {
      this.selectedGroup = null;
      this.render();
    });

    this.querySelector('#toggle-nonpass')?.addEventListener('click', () => {
      this.onlyNonPassing = !this.onlyNonPassing;
      this.render();
    });

    for (const btn of this.querySelectorAll('.copy-btn')) {
      btn.addEventListener('click', async () => {
        const text = btn.getAttribute('data-copy') || '';
        try {
          await navigator.clipboard.writeText(text);
          const prev = btn.textContent;
          btn.textContent = 'Copied ✓';
          btn.classList.add('copied');
          setTimeout(() => {
            btn.textContent = prev;
            btn.classList.remove('copied');
          }, 1500);
        } catch {
          btn.textContent = 'Select & copy';
        }
      });
    }
  }
}

customElements.define('uplift-cockpit', UpliftCockpit);
