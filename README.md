# agentic-uplift

**Zero-dependency repository agentic uplift, cryptographic proof-lock, SRE observability, and guarded autonomous maintenance — with first-class JSON queries for AI agents and a buildless Web Components cockpit for humans.**

Synthesizes the operational control plane of [`repo-sre-dashboard`](https://github.com/sholtomaud/repo-sre-dashboard) with the cryptographic verification and tamper-proofing of [`proof-based-development`](https://github.com/sholtomaud/proof-based-development), engineered from the ground up with **zero third-party runtime dependencies** using only Node.js native TypeScript type stripping (`>=22.18.0`) and native Web Components.

## Why `agentic-uplift`?

Running autonomous agents against a repository requires a closed loop across both **operations** and **proof integrity**:

1. **Observe & Audit (Offline or GitHub API):** Measure autonomy readiness across 6 pillars (*Proof integrity*, *Code & CI*, *Supply chain & security*, *Agent operating model*, *Issues & delivery*, *Observability & budgets*) with machine-actionable fixes and verify commands.
2. **Seal Cryptographically (Tier 0, Language-Agnostic):** Hash Zone A (verification harness, workflows, `.githooks/`), Zone B (existing tests), and Zone C (monotonic test-count floors + skip ceiling) in `proof-lock.json` and chain commit attestations in `PROOF_CHANGELOG.md`.
3. **Block Bad Commits Early (Layer 1 Local Hooks) & Tampered PRs Unbypassably (Layer 2 CI Gate):** Tracked `.githooks/pre-commit` and `.githooks/pre-push` stop LLMs locally; `actions/proof-gate` compares PRs against `origin/<base>:proof-lock.json` so agents cannot forge the lockfile.
4. **Gate Autonomous Resolution (Proof-Aware Circuit Breaker):** `actions/resolve-gate` automatically pauses autonomous agent runs if the proof seal breaks, open agent PRs reach the cap, monthly agentic spend hits budget, or default-branch CI goes red.
5. **Query Programmatically (Agent-First JSON API):** Every CLI command supports `--json`, `query <expr>` queries structured state directly, and published Pages bundles expose `data/{status,audit,proof,gate}.json`, `schemas/*-v1.json`, and `llms.txt`.

## Quick Start (Zero `npm install` Required)

Requires **Node.js 22.18+ / 24+ / 26+**:

```bash
# Run the full 4-tier deterministic verification pipeline
node src/cli.ts verify

# Install tracked pre-commit & pre-push bash verification guardrails
node src/cli.ts hooks install

# Run the offline readiness audit as machine-readable JSON
node src/cli.ts audit --json

# Query any field or filtered slice directly (first-class agentic query)
node src/cli.ts query status.summary
node src/cli.ts query audit.readiness.blockers
node src/cli.ts query "audit.checks[status!=pass,blocks_autonomy=true].id"
node src/cli.ts query proof.ok
node src/cli.ts query gate.decision

# Publish JSON APIs + schemas + llms.txt + zero-dep Web Components cockpit
node src/cli.ts publish --out _site
node src/cli.ts serve --dir _site
```

## Composable GitHub Actions

Use all three or adopt them incrementally:

### 1. Control Plane & Pages Cockpit (root action)
```yaml
- uses: sholtomaud/agentic-uplift@v1
  with:
    monthly-agentic-budget: '50'
```

### 2. Tier-0 Cryptographic PR Tamper Gate (any language: TS, Python, Go, Rust)
```yaml
- uses: sholtomaud/agentic-uplift/actions/proof-gate@v1
  with:
    base-ref: origin/${{ github.base_ref }}
```

### 3. Proof-Aware Autonomous Resolution Circuit Breaker
```yaml
- id: gate
  uses: sholtomaud/agentic-uplift/actions/resolve-gate@v1
  with:
    max-open-agent-prs: '2'
    monthly-agentic-budget: '50'
```

## Architecture (Enforced by `src/core/arch-check.ts`)

| Layer | Directory | Rules |
| --- | --- | --- |
| **0. Shared Contracts** | `src/shared/` | Pure types & runtime guards only; zero `node:*` imports |
| **1. Pure Domain** | `src/domain/` | Audit engine, proof verifier, resolve-gate, SRE metrics, query engine + formal `check*Invariants()`; zero `node:*` or DOM globals |
| **2. Core Engine** | `src/core/` | Filesystem proof I/O, local repo scanner, architectural checker, static anti-pattern verifier, JSON Schema validator |
| **3. Adapters** | `src/adapters/` | Native-`fetch` GitHub REST collector, JSON API & static cockpit publisher |
| **4. Entrypoint & UI** | `src/cli.ts`, `site/` | Single zero-dep CLI + buildless native Web Components cockpit with live Agent Query Bar |

See [AGENTS.md](./AGENTS.md) for the complete operating model.