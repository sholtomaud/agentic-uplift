/**
 * Buildless, zero-dependency native Web Components cockpit for Agentic Uplift.
 * Renders the exact same versioned JSON endpoints queried by autonomous agents.
 */

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function evalSimpleQuery(bundle, expr) {
  const cleaned = String(expr || '').trim().replace(/^\$\.?/, '');
  if (!cleaned) return { found: true, value: bundle };

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
    if (cur === null || cur === undefined) return { found: false, value: null };
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
        return { found: false, value: null };
      }
    } else if (tok.kind === 'index') {
      if (!Array.isArray(cur) || tok.index >= cur.length) {
        return { found: false, value: null };
      }
      cur = cur[tok.index];
    } else if (tok.kind === 'filter') {
      if (!Array.isArray(cur)) return { found: false, value: null };
      cur = cur.filter((item) => {
        if (!item || typeof item !== 'object') return false;
        return tok.preds.every((p) => {
          const actual = String(item[p.key]);
          return p.op === '=' ? actual === p.val : actual !== p.val;
        });
      });
    }
  }
  return { found: true, value: cur };
}

class UpliftCockpit extends HTMLElement {
  constructor() {
    super();
    this.bundle = null;
    this.queryExpr = 'status.summary';
    this.onlyFailing = false;
  }

  async connectedCallback() {
    this.innerHTML = `<main class="shell"><p class="meta">Loading Agentic Uplift JSON control plane…</p></main>`;
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
      this.innerHTML = `<main class="shell"><div class="section"><h2>Failed to load JSON endpoints</h2><pre class="json-out">${escapeHtml(String(err))}</pre></div></main>`;
    }
  }

  render() {
    if (!this.bundle) return;
    const { status, audit, proof, gate } = this.bundle;
    const qResult = evalSimpleQuery(this.bundle, this.queryExpr);
    const visibleChecks = this.onlyFailing
      ? audit.checks.filter((c) => c.status !== 'pass')
      : audit.checks;

    const autonomyClass =
      status.summary.autonomy === 'autonomous-ready'
        ? 'pass'
        : status.summary.autonomy === 'supervised'
          ? 'supervised'
          : 'not-ready';

    this.innerHTML = `
      <main class="shell">
        <header class="hero">
          <div>
            <h1>${escapeHtml(status.repository)} — Agentic Uplift</h1>
            <div class="meta">mode=${escapeHtml(status.mode)} · updated ${escapeHtml(status.generated_at)}</div>
          </div>
          <nav class="links" aria-label="Agent JSON Endpoints">
            <a href="data/status.json">status.json</a>
            <a href="data/audit.json">audit.json</a>
            <a href="data/proof.json">proof.json</a>
            <a href="data/gate.json">gate.json</a>
            <a href="llms.txt">llms.txt</a>
          </nav>
        </header>

        <section class="grid" aria-label="Control Plane Summary">
          <article class="card">
            <h2>Autonomy Readiness</h2>
            <div class="big-value">${status.summary.readiness_score}%</div>
            <span class="badge ${autonomyClass}">${escapeHtml(status.summary.autonomy)}</span>
            <div class="meta" style="margin-top:8px">${status.summary.blockers_count} blocker(s)</div>
          </article>

          <article class="card">
            <h2>Cryptographic Proof Seal</h2>
            <div class="big-value">${proof.ok ? 'INTACT' : 'BROKEN'}</div>
            <span class="badge ${proof.ok ? 'pass' : 'fail'}">${proof.locked_files} locked files</span>
            <div class="meta" style="margin-top:8px">root: ${escapeHtml((proof.root_sha256 || 'none').slice(0, 16))}…</div>
          </article>

          <article class="card">
            <h2>Resolve Circuit Breaker</h2>
            <div class="big-value">${gate.decision.proceed ? 'OPEN' : 'PAUSED'}</div>
            <span class="badge ${gate.decision.proceed ? 'pass' : 'improve'}">${escapeHtml(gate.decision.reason)}</span>
            <div class="meta" style="margin-top:8px">agent PRs: ${gate.constraints.open_agent_prs}/${gate.constraints.max_open_agent_prs}</div>
          </article>

          <article class="card">
            <h2>Attestation Chain</h2>
            <div class="big-value">${proof.changelog.count}</div>
            <span class="badge ${proof.changelog.valid ? 'pass' : 'fail'}">${proof.changelog.valid ? 'chain valid' : 'chain broken'}</span>
            <div class="meta" style="margin-top:8px">${status.repo.test_file_count} test file(s)</div>
          </article>
        </section>

        <section class="section">
          <h2>First-Class Agentic JSON Query</h2>
          <div class="query-row">
            <input id="q-input" type="text" value="${escapeHtml(this.queryExpr)}" aria-label="JSON Query Expression" />
            <button id="q-run" type="button">Run Query</button>
          </div>
          <div class="chips">
            <button class="chip" data-q="status.summary">status.summary</button>
            <button class="chip" data-q="audit.readiness.blockers">audit.readiness.blockers</button>
            <button class="chip" data-q="audit.checks[status!=pass].id">failing checks</button>
            <button class="chip" data-q="audit.checks[blocks_autonomy=true].id">autonomy blockers</button>
            <button class="chip" data-q="proof.metric_floors">proof.metric_floors</button>
            <button class="chip" data-q="gate.decision">gate.decision</button>
          </div>
          <div class="meta" style="margin-bottom:8px">CLI equivalent: <code>node src/cli.ts query "${escapeHtml(this.queryExpr)}"</code></div>
          <pre class="json-out">${escapeHtml(JSON.stringify(qResult, null, 2))}</pre>
        </section>

        <section class="section">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
            <h2 style="margin:0">Uplift & Proof Readiness Checks (${audit.readiness.passed}/${audit.readiness.total} passed)</h2>
            <button id="toggle-failing" class="chip" type="button">${this.onlyFailing ? 'Show all checks' : 'Show non-passing only'}</button>
          </div>
          <table>
            <thead>
              <tr>
                <th>Status</th>
                <th>Check</th>
                <th>Group</th>
                <th>Evidence &amp; Verify Command</th>
              </tr>
            </thead>
            <tbody>
              ${visibleChecks
                .map(
                  (c) => `
                <tr>
                  <td>
                    <span class="badge ${escapeHtml(c.status)}">${escapeHtml(c.status)}</span>
                    ${c.blocks_autonomy && c.status !== 'pass' ? '<div class="meta" style="color:var(--fail)">BLOCKER</div>' : ''}
                  </td>
                  <td>
                    <strong>${escapeHtml(c.id)}</strong>
                    <div class="meta">${escapeHtml(c.title)}</div>
                  </td>
                  <td>${escapeHtml(c.group)}</td>
                  <td>
                    <div>${escapeHtml(c.evidence)}</div>
                    <div class="meta">verify: <code>${escapeHtml(c.verify_command)}</code></div>
                  </td>
                </tr>`
                )
                .join('')}
            </tbody>
          </table>
        </section>
      </main>
    `;

    const input = this.querySelector('#q-input');
    const runBtn = this.querySelector('#q-run');
    const runQuery = () => {
      if (input instanceof HTMLInputElement) {
        this.queryExpr = input.value;
        this.render();
      }
    };
    runBtn?.addEventListener('click', runQuery);
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') runQuery();
    });
    for (const chip of this.querySelectorAll('.chip[data-q]')) {
      chip.addEventListener('click', () => {
        const q = chip.getAttribute('data-q');
        if (q) {
          this.queryExpr = q;
          this.render();
        }
      });
    }
    this.querySelector('#toggle-failing')?.addEventListener('click', () => {
      this.onlyFailing = !this.onlyFailing;
      this.render();
    });
  }
}

customElements.define('uplift-cockpit', UpliftCockpit);
