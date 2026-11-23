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
- `CHANGELOG.md`.

### Changed

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
