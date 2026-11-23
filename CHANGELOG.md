# Changelog

All notable changes to `agentic-uplift` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). Cryptographic proof attestations
live separately in [`PROOF_CHANGELOG.md`](./PROOF_CHANGELOG.md).

## [Unreleased]

### Added

- **Secret-reachability audit checks** (#9) under *Supply chain and security*:
  `install-scripts`, `secrets-in-package-jobs`, `agent-jobs-isolated` and
  `checkout-persist-credentials`, backed by per-job workflow analysis
  (`src/domain/workflow-jobs.ts`). Only workflow and job names are reported;
  secret names never reach JSON or the cockpit.
- **`socket-firewall` check** (#7): flags CI package installs (npm, Python,
  Cargo) not screened by Socket Firewall and emits a pinned
  `SocketDev/action` firewall-mode snippet with the cache caveat. Not
  applicable to zero-dependency repositories.
- **Fix-snippet round-trip tests** (#10): every whole-file fix emitted by
  `runUpliftAudit` is applied to synthetic npm, Python, Go, Rust,
  multi-ecosystem and zero-dep repositories, re-scanned, and must turn its
  check green with zero regressions. Negative canaries cover unpinned
  actions, missing permissions, persisted checkout credentials, incomplete
  CODEOWNERS and mismatched ruleset check names.
- **Measured attribution coverage** (#6): `status.attribution` records
  sources, sample sizes and a lower-bound caveat (`basis: "measured"`), shown
  on the cockpit beside agent counts. New issue metrics
  `closed_agent_assisted` and `opened_by_agent`.
- **People vs agents economics** (#2, #4): `data/economics.json` (schema
  `schemas/economics-v1.json`) compares issues resolved by people and agents:
  measured elapsed time, time to first PR, review rounds, reverts, reopens,
  CI minutes and process compliance, plus modeled $ per issue, hands-on
  hours, human and agentic monthly budgets (spend, pace, month-end
  projection), an all-human counterfactual, monthly savings and an uplift
  pay-off history. Modeled figures are always `{ low, high }` ranges and the
  report lists which figures are measured and which are modeled.
- **Dated, sourced LLM price table** (#3): `src/domain/price-table.ts` covers
  Anthropic, Google Gemini and GitHub Copilot plans with source URLs and
  effective dates; negotiated rates go in `uplift.config.json` →
  `costs.priceOverrides`.
- **`Agent-Usage:` line**: agents can report tokens and run time in PR
  descriptions or squash commits so their cost is measured, not modeled.
- **People vs Agents cockpit panel** (#5): cost and time ranges, budget fuel
  dials with month-end projection, quality against best-in-class targets,
  compliance shares, savings against the counterfactual with assumptions
  shown, a readiness-vs-savings pay-off chart, and a table view of every
  figure. Selected dark-mode series colours.
- **Isolated visual snapshot workflow** (#8): `.github/workflows/visual.yml`
  runs Playwright screenshot diffs (1024 px and 390 px, light and dark) in a
  digest-pinned container against frozen fixture data, with a baseline
  regeneration flow. The root `package.json` stays dependency-free.
- Root action inputs `monthly-human-budget`, `human-hourly-rate`,
  `copilot-seats` and `agent-model`.
- `CHANGELOG.md`.

### Changed

- **Mobile-first cockpit**: `site/styles.css` now starts from phone
  layouts and widens at 40rem (tablet), 64rem (desktop) and 90rem (wide),
  using only `min-width` queries. Touch targets are at least 44px on coarse
  pointers, the nav scrolls sideways on phones, safe-area insets are
  respected, and the economics grid goes 1 → 2 → 3 columns.
- **Chart forms matched to the data**: pillar readiness is a meter list with
  the supervised/autonomous thresholds marked (was six mini dials); the proof
  seal is a status stamp with a segmented bar of sealed files by zone (was a
  gauge of a binary state); audit checks gain a segmented status bar; monthly
  budgets are bullet charts with spent, projected, measured and limit marks
  (were dials); process compliance is a People-vs-Agents dumbbell; monthly
  savings gets a diverging bar centred on $0.

- The resolve gate's agentic spend now defaults to **measured** spend
  (reported token usage and CI minutes this month) in `--github` mode when
  `MONTHLY_AGENTIC_SPEND` is not set.
- Agent attribution (#6) matches agent names as whole tokens (no more
  `/claude/i` substring matches on human logins), recognises more agents
  (Antigravity, Gemini, Jules, Roo Code, Amp, OpenHands), reads
  `Co-Authored-By` / `Assisted-by` / `Generated-by` trailers and structured
  commit authors, and attributes issue closures through merged PRs,
  squash-merge commits and default-branch commits.
- `agent_resolution_share` now counts human-directed agent-assisted
  closures as well as direct agent closures.
- The generated branch ruleset requires the status-check names that the
  repository's pull-request proof-gate workflows actually produce, instead
  of a hard-coded context.

### Fixed

- `deploy-pages` no longer fails with "No artifacts named github-pages were
  found" right after REST indexing (#11): the root action matches the
  uploaded `artifact_id`, settles for 5s, and retries `deploy-pages` once
  after 15s. `page-url` is wired to either attempt.
- The `pr-tamper-gate` workflow fix pinned `actions/proof-gate@v1` instead of
  a 40-character SHA, failing the audit's own `pinned-actions` check (#10).
- The `uplift-config` fix narrowed test discovery (dropped `.test.js` and the
  `test/`, `src/`, `e2e/` roots), regressing the `tests` check (#10).
