# Release Hardening Handoff

This document is the maintenance handoff for the current reader architecture. The project is now in release stabilization mode. Do not add new runtime layers, policy engines, orchestration frameworks or capability systems unless a concrete production failure proves the current boundary is insufficient.

## Architecture Snapshot

```text
Renderer UI
  -> preload readerApi
  -> main IPC handlers
  -> ArticlePrefetcher
  -> ArticlePipeline
      -> Policy Layer
      -> CapabilityRegistry
      -> CapabilityRunner
      -> feed/sitemap/browser/archive capabilities
  -> RequestGovernor
  -> parser/readability/browser extraction
  -> ArticleCache / SiteHealthStore
```

Key boundaries:

- `ArticlePipeline` owns orchestration only.
- `CapabilityRunner` owns execution, timeout and contract normalization.
- `RequestGovernor` owns direct HTTP request governance.
- `BrowserExtractionController` owns hidden BrowserWindow lifecycle.
- `SiteHealthStore` owns rolling strategy health.
- `pipelineReplayReport` explains single-run decisions.
- `runtimeHealthReport` summarizes persisted runtime health signals.

## Runtime Lifecycle

Startup:

1. Electron main initializes stores and diagnostics.
2. IPC handlers are registered through the shared wrapper in `main.js`.
3. Article prefetching starts.
4. Renderer loads local HTML under CSP.
5. Renderer calls `reading:next`.
6. Main returns a cached or newly prepared article.

All IPC calls now emit:

- `ipc_start`
- `ipc_success`
- `ipc_failed`

Renderer errors are reported through `readerApi.reportRendererError`.

## BrowserWindow Governance

Hidden BrowserWindow usage is intentionally limited and expensive.

Current guarantees:

- max concurrent extraction windows: `1`
- isolated extraction session per run
- resource blocking for images, media, fonts, stylesheets, subframes, trackers and third-party scripts
- best-effort load lifecycle
- `webContents.stop()` guarded by destroyed checks
- `BrowserWindow.destroy()` in cleanup
- extraction session cache/socket cleanup

Known limitation: Chromium page subresources cannot all be routed through `RequestGovernor.request()`. They are governed by session blockers and lifecycle cleanup.

## RequestGovernor Boundary

Use `RequestGovernor` for direct network requests:

- feed
- sitemap
- article fetch
- archive/fallback probes
- translator requests

Do not call raw `fetch`, Electron `net.request`, or custom HTTP clients from new feature code. If a direct request is unavoidable, document why it is outside governance.

Electron `net.request` must not receive browser-only headers such as:

- `Sec-Fetch-*`
- `Sec-CH-UA-*`
- `Accept-Encoding`
- `Host`
- `Content-Length`

`httpClient.sanitizeElectronNetHeaders()` enforces this.

## Replay System

Replay is a correctness artifact.

Use `buildReplayReport(traceSummary)` when debugging pipeline behavior. The report includes:

- final state
- capability results
- policy decisions
- failure summary
- fallback summary
- decision tree
- integrity validation

Integrity failures mean runtime behavior and diagnostics are drifting.

## Runtime Health Report

Run:

```bash
npm run health:runtime
```

The report summarizes:

- IPC failures
- request failures
- parser failures
- BrowserWindow cleanup failures
- anti-bot signals
- replay inconsistencies
- extraction quality failures

This is intentionally a lightweight CLI report, not a dashboard.

## Test Workflow

Run before release:

```bash
npm run check
npm test
```

Optional diagnostics:

```bash
npm run health:runtime
npm run health:report
```

The test suite includes fixture-based parser regression tests for:

- New Yorker-like long-form pages
- Economist/archive JSON-LD pages
- multi-container archive pages

These tests prevent parser changes from silently truncating long articles.

## Release Baseline

Acceptable risks:

- Chromium subresources are only partially controllable.
- Some sites will continue to block automated access.
- Browser fallback is intentionally conservative and slow.
- Renderer remains mostly one file, with runtime reporting extracted.
- Some compatibility paths remain while older callers migrate.

Intentionally not abstracted:

- no generic workflow engine
- no policy rules engine
- no dependency injection container
- no new orchestration runtime
- no crawler framework

Acceptable technical debt:

- `ArticlePipeline` has orchestration density but is still readable.
- `articleDiscoveryPipeline` still coordinates candidate aggregation.
- Renderer UI modules are not fully split yet.

Dangerous technical debt:

- new direct network paths outside `RequestGovernor`
- new hidden BrowserWindow paths outside `BrowserExtractionController`
- site-specific branches inside `ArticlePipeline`
- capability output that bypasses `CapabilityResult`
- fallback without replay-visible transition reason

## Future Contributor Guide

When adding a site strategy:

- keep it declarative
- avoid `if domain includes` logic in pipeline code
- add only data that is actually site-specific

When changing extraction:

- add or update an HTML fixture
- assert text from the final section exists
- assert quality remains acceptable
- preserve diagnostics

When changing renderer code:

- use `runAction()` for async UI actions
- report errors through `runtimeReporter`
- avoid one-off IPC calls without user-visible failure handling

When changing BrowserWindow logic:

- prove cleanup works on success, timeout, worker failure and destroyed webContents
- keep concurrency low
- keep session isolation

## Release Readiness Checklist

- [x] IPC has structured start/success/failure logs.
- [x] Renderer runtime errors are reported.
- [x] CSP is present.
- [x] Electron net browser-only headers are stripped.
- [x] BrowserWindow cleanup is guarded.
- [x] Reader/browser discovery JavaScript execution checks destroyed state.
- [x] Runtime health report exists.
- [x] Fixture parser regressions exist.
- [x] Smoke check passes.
- [x] Unit/regression tests pass.
- [ ] Run a real manual reading session across 5-10 sites before packaging.
- [ ] Review `npm run health:runtime` after manual use.
