# Request Governance + Site Strategy Architecture

This document captures the current migration from scattered request logic to a governed article-loading pipeline.

## Current Request Paths

- `articlePicker.js`
  - reads configured feed URLs
  - discovers feed URLs
  - probes sitemap URLs
  - parses feed/sitemap documents into article candidates
- `feedDiscovery.js`
  - fetches homepage for RSS autodiscovery
  - tries a small standard fallback list
  - classifies discovery status
- `readerMode.js`
  - fetches article HTML
  - falls back to hidden BrowserWindow when HTTP fetch is blocked
  - runs Readability and custom extractors
- `browserArticleDiscovery.js`
  - uses a hidden BrowserWindow as last-resort article index discovery
- `bypassRegistry.js`
  - generates archive/paywall bypass URLs

Historically these paths had different timeout, retry, request identity and error handling. The migration goal is to make all network entry points observable through one request governance layer.

## Request Lifecycle Flow

```text
SiteStrategy
  -> ArticlePipeline
      -> feed/sitemap stage
      -> browser fallback stage
      -> article extraction stage
      -> archive probe stage
  -> requestGovernance.request(url, context)
  -> RequestGovernor
      -> cache lookup
      -> inflight dedupe
      -> per-domain cooldown
      -> request_start log
      -> httpClient.requestText
      -> request_success OR request_failed log
      -> cache success/error
  -> parser/extractor
  -> SiteHealthStore
```

Each request should carry:

- `source`: module-level source, e.g. `feed-fetcher`, `sitemap-parser`, `article-fetch`
- `fetchMode`: semantic mode, e.g. `feed`, `sitemap`, `article`, `inspect`
- `strategySource`: site strategy id or `generic`
- `traceId`: generated request trace id

## Retry Flow

```text
request attempt 0
  -> success: return
  -> timeout/network failure: exponential backoff
  -> aborted: do not retry
  -> final failure: cache short-lived error and throw
```

Retries are intentionally conservative. Feed discovery and article reading should avoid flooding one domain because many publishers use HTTP/2 stream refusal or bot mitigation when request bursts look automated.

## Fallback Flow

```text
site strategy
  -> configured user sources
  -> RSS autodiscovery from homepage
  -> standard feed fallback only: /feed, /rss.xml, /feed.xml
  -> sitemap fallback
  -> browser automation fallback
  -> archive fallback/probe when paywall or block is detected
```

Important rule: browser automation is a fallback, not the default. It is heavier, creates Chromium requests and can trigger TLS/abort noise.

BrowserWindow page subresources are not Node fetch requests, so they cannot literally be emitted by `RequestGovernor.request()`. The governed boundary is the pipeline stage entry, timeout/fallback decision, isolated session, resource blocker and lifecycle diagnostics.

## ArticlePipeline

`articlePipeline.js` turns article candidate discovery into explicit stages.

```text
resolveSiteStrategy
  -> load SiteHealthStore
  -> AdaptiveStrategyEngine decides stage order/cooldown
  -> run feed-sitemap
  -> if empty: browser fallback
  -> PipelineTrace records transitions
  -> record success/failure health event
```

Current stage input:

- `site`
- `limit`
- `timeoutMs`
- `enabledStages`
- `traceId`
- resolved static strategy
- prior health record

Current stage output:

- `articles`
- `durationMs`
- `stageName`
- `strategySource`
- `failureCategory`
- `failureTransitionReason`
- `cost`
- `qualityScore`

Fallback transitions are explicit:

- `feed_and_sitemap_returned_no_article_candidates`
- `feed-sitemap_timeout`
- `browser_discovery_returned_no_article_candidates`
- `browser_timeout`

## BrowserExtractionController

`browserExtractionController.js` centralizes hidden BrowserWindow lifecycle.

Responsibilities:

- launch hidden BrowserWindow with an isolated extraction session
- enforce max concurrent hidden windows
- centralize navigation timeout behavior
- guarantee `webContents.stop()`
- guarantee `BrowserWindow.destroy()`
- guarantee extraction session cleanup
- emit lifecycle metrics

Lifecycle:

```text
enqueue
  -> create isolated extraction session
  -> create hidden BrowserWindow
  -> attach diagnostics
  -> load URL best-effort
  -> run extraction worker
  -> stop navigation
  -> destroy window
  -> close session connections and clear cache
  -> log summary
```

Current concurrency limit: `1`.

This deliberately favors stability over throughput. Browser fallback is expensive and anti-bot sensitive.

## Capability-Based Pipeline

Discovery is moving from a monolithic `articlePicker.js` into capability modules.

Current capabilities:

- `feedReader.js`
- `sitemapReader.js`
- `browserArticleDiscovery.js`
- `archive.js`
- `articleDiscoveryPipeline.js`

Each capability should converge on:

- unified input: site, limit, trace, strategy context
- unified output: article candidates or governed failure
- unified failure classification
- unified trace/cost logging

`articlePicker.js` is now a compatibility facade.

## Capability Contract

`capabilityContract.js` defines the stable shape that pipeline capabilities should return.

CapabilityResult:

```ts
interface CapabilityResult<T = unknown> {
  success: boolean;
  capabilityName: string;
  stage: string;
  strategySource: string;
  url: string | null;
  normalizedUrl: string | null;
  duration: number;
  qualityScore: number | null;
  failureCategory: string | null;
  retryable: boolean;
  antiBotDetected: boolean;
  contentMetadata: Record<string, unknown>;
  trace: Record<string, unknown>;
  failure: FailureObject | null;
  data: T | null;
}
```

FailureObject:

```ts
interface FailureObject {
  category: string;
  subcategory: string | null;
  stage: string;
  retryable: boolean;
  severity: "low" | "medium" | "high";
  originalError: {
    name: string;
    message: string;
    code: string | null;
    kind: string | null;
    status: number | null;
  } | null;
  domain: string | null;
  strategy: string;
  transitionReason: string;
}
```

PipelineMetadata:

```ts
interface PipelineMetadata {
  stage: string;
  stageStart: number;
  stageEnd: number;
  duration: number;
  strategySource: string;
  costClass: string;
  fallbackReason: string | null;
  attemptIndex: number;
  stateTransition: string | null;
  traceId: string | null;
  cost: RequestCost;
}
```

Current integration:

- `articleDiscoveryPipeline.discoverArticleCandidatesResult()` returns CapabilityResult.
- `ArticlePipeline.runStage()` wraps stage output in CapabilityResult.
- `pipelineReplayReport` consumes capability results and metadata.

## Capability Registry

`capabilityRegistry.js` declares capability metadata without introducing a DI framework.

Registered capabilities:

- feed
- sitemap
- browser
- archive

Metadata:

- capability name
- stage
- priority
- supported domains
- estimated cost
- anti-bot risk
- retry policy

The registry currently supports resolution and ordering. It does not yet instantiate capability implementations. That is intentional: the project gets stable metadata first, then capability execution can migrate gradually.

Current registry status:

- metadata lookup
- stage-to-capability lookup
- lightweight handler binding
- runtime execution config

No DI framework is used. Capability handlers are plain functions.

## Capability Runtime

`capabilityRunner.js` is the execution boundary for capabilities.

Execution lifecycle:

```text
ArticlePipeline selects stage
  -> CapabilityRegistry resolves capability + handler
  -> CapabilityRunner starts runtime event
  -> execute handler with CapabilityExecutionContext
  -> timeout guard
  -> normalize CapabilityResult
  -> normalize PipelineMetadata
  -> validate contract
  -> emit runtime event
  -> return { result, metadata }
```

`ArticlePipeline` should not know how a capability executes. It should only know:

- which capability to run
- what state transition happened
- whether result succeeded
- what fallback reason to record

## CapabilityExecutionContext

`capabilityExecutionContext.js` creates the runtime context passed to capabilities.

Schema:

```ts
interface CapabilityExecutionContext {
  traceId: string;
  site: Site;
  strategy: SiteStrategy | null;
  health: SiteHealth | null;
  adaptivePlan: AdaptivePlan | null;
  trace: PipelineTrace | null;
  siteHealthStore: SiteHealthStore | null;
  requestGovernance: unknown | null;
  cancellationSignal: AbortSignal | null;
  qualityEvaluator: unknown | null;
  strategySource: string;
  domain: string;
}
```

This prevents new capabilities from quietly depending on globals.

## Contract Guardrails

`capabilityContract.js` now includes runtime validators:

- `validateCapabilityResult`
- `validateFailureObject`
- `validatePipelineMetadata`

CapabilityRunner uses these validators after every execution.

Malformed capability output is normalized into a failed CapabilityResult with:

```text
transitionReason = malformed_capability_output_normalized
```

This is intentional. A bad capability should not crash the whole pipeline unless validation itself cannot recover.

## Policy Layer

Policy complexity is now split from capability execution.

Policy modules:

- `AdaptivePolicy`
- `StormPolicy`
- `HealthPolicy`
- `TransitionPolicy`

`ArticlePipeline` should orchestrate policy decisions, not implement policy internals.

PolicyDecision:

```ts
interface PolicyDecision {
  policyName: string;
  decision: string;
  reason: string;
  confidence: number;
  triggeredBy: string | null;
  resultingTransition: string | null;
  suppressionApplied: boolean;
  fallbackAllowed: boolean;
  metadata: Record<string, unknown>;
}
```

PolicyExecutionContext:

```ts
interface PolicyExecutionContext {
  traceId: string;
  currentState: string;
  site: Site;
  strategy: SiteStrategy | null;
  health: SiteHealth | null;
  adaptivePlan: AdaptivePlan | null;
  previousFailures: unknown[];
  qualityScore: number | null;
  antiBotSignals: unknown[];
  retryState: unknown | null;
  stormState: unknown | null;
  fallbackChain: unknown[];
}
```

TransitionRecord:

```ts
interface TransitionRecord {
  from: string | null;
  to: string;
  policyName: string;
  reason: string;
  triggeringFailure: string | null;
  suppressionStatus: boolean | null;
  fallbackStatus: boolean | null;
  retryStatus: string | null;
  metadata: Record<string, unknown>;
  at: number;
}
```

Policy replay:

- transition events include `policyDecision`
- storm suppression includes explicit `suppressionApplied`
- health updates are logged as `pipeline_policy_decision`
- replay reports summarize policy decisions

## FallbackStormProtector

`fallbackStormProtector.js` prevents expensive fallback loops.

Protection rules:

- domain-level rolling window
- expensive fallback budget
- repeated browser/archive failure suppression
- temporary strategy disable
- anti-bot escalation cooldown
- low-success browser cutoff

This prevents behavior like:

```text
feed empty
  -> browser fallback
  -> bot block
  -> archive fallback
  -> retry browser
  -> repeated hidden windows
```

The target behavior is:

```text
feed empty
  -> browser fallback once
  -> failure recorded
  -> cooldown / suppress repeated expensive stage
```

## Unified Pipeline Replay

`pipelineReplayReport.js` converts a trace summary into:

- JSON replay format
- human-readable diagnostic text
- failure summary
- fallback summary
- strategy decision summary
- capability result summary
- normalized metadata summary
- decision tree

Replay should answer:

- which strategy was selected
- which stages were entered
- why fallback happened
- which request class failed
- whether extraction quality was low
- where anti-bot was detected
- what the final state was

Machine-readable replay now includes:

- `capabilityResults`
- `metadata`
- `decisionTree`

## Remaining Chromium Limits

RequestGovernor cannot directly govern Chromium subresources inside a loaded page.

Still uncontrolled at Chromium level:

- same-site scripts required by the page
- redirects initiated by page scripts
- CSP/reporting quirks
- browser-internal TLS/socket lifecycle noise
- site-specific service-worker behavior

Current safeguards:

- isolated session per extraction
- resource-type blocker
- third-party script blocker
- tracker/ad host blocker
- hidden window concurrency limit
- lifecycle cleanup in `BrowserExtractionController`
- fallback storm suppression
- diagnostic summaries

State machine:

```text
INIT
  -> RESOLVE_STRATEGY
  -> FEED_DISCOVERY
  -> BROWSER_DISCOVERY
  -> ARTICLE_EXTRACTION
  -> ARCHIVE_PROBE
  -> SUCCESS | FAILURE
```

Every transition includes:

- reason
- trace id
- elapsed time
- failure category when relevant
- estimated request cost

## AdaptiveStrategyEngine

`adaptiveStrategyEngine.js` reads `SiteHealthStore` output and adjusts stage selection without hard-coding publisher-specific branches.

Current adaptive rules:

- Prefer `lastSuccessfulStrategy`.
- Prefer feed/sitemap when feed success rate is high.
- Skip expensive browser/archive stages when historical success is low or bot-block rate is high.
- Recommend cooldown when bot-block rate is high.
- Signal reduced concurrency when bot-block rate crosses a threshold.

This is deliberately conservative. It changes order and skips expensive repeated failures, but it does not yet rewrite site strategies automatically.

## ExtractionQualityEvaluator

`extractionQualityEvaluator.js` evaluates whether extracted content is actually readable.

Signals:

- content length
- text density
- duplication ratio
- boilerplate ratio
- paywall contamination
- title/body consistency
- aggregate `qualityScore`

The current integration records quality in diagnostics and site health. It does not yet hard-fail low quality extraction by default because overly aggressive quality gates can create false negatives.

## AntiBotIntelligence

`antiBotIntelligence.js` builds on `antiBot.js`.

Tracked signals:

- Cloudflare
- Akamai
- CAPTCHA
- access denied
- JS challenge
- unusual redirect chains
- HTTP/2 refused stream

Output:

- `antiBotType`
- `cooldownRecommendationMs`
- `blocked`

Future use:

- avoid repeated probing on domains that recently triggered bot mitigation
- lower concurrency for sensitive domains
- prefer cached/feed-based paths over browser automation

## Request Cost Model

`requestCostModel.js` gives every fetch mode a rough cost profile.

```text
feed      -> low
sitemap   -> medium
article   -> medium
archive   -> high
browser   -> very high
```

Cost fields:

- estimated cost
- latency class
- anti-bot risk
- memory impact

Pipeline logs include cost so expensive fallback storms are diagnosable.

## SiteHealthStore

`siteHealthStore.js` writes `site-health.json` under Electron user data.

Schema:

```json
{
  "version": 1,
  "sites": {
    "site-id-or-domain": {
      "domain": "example.com",
      "successRate": 0.78,
      "feedSuccessRate": 0.82,
      "sitemapSuccessRate": 0.4,
      "articleSuccessRate": 0.7,
      "browserSuccessRate": 0.6,
      "archiveSuccessRate": null,
      "botBlockedRate": 0.05,
      "avgLatency": 923,
      "lastSuccessfulStrategy": "feed",
      "lastFailureCategory": "empty_content",
      "lastUpdated": "2026-05-23T00:00:00.000Z",
      "events": []
    }
  }
}
```

Usage:

- Next visits can prioritize the historically successful stage.
- Repeated failures become visible instead of silently falling through.
- Future health reports can show which domains are blocked, slow or parser-hostile.

## Failure Categories

Unified categories live in `requestClassification.js`:

- `timeout`
- `dns_failure`
- `ssl_error`
- `blocked_by_bot`
- `paywall_detected`
- `empty_content`
- `invalid_html`
- `parser_failure`
- `network_error`
- `aborted`
- `unknown`

Feed discovery has a smaller result state machine:

- `FOUND`
- `NOT_FOUND`
- `ANTI_BOT`
- `TIMEOUT`
- `NETWORK_FAILURE`
- `ABORTED`
- `BLOCKED`

## TypeScript Type Design

The app is currently JavaScript. If/when migrated, keep these interfaces as the target shape.

```ts
type FailureCategory =
  | "timeout"
  | "dns_failure"
  | "ssl_error"
  | "blocked_by_bot"
  | "paywall_detected"
  | "empty_content"
  | "invalid_html"
  | "parser_failure"
  | "network_error"
  | "aborted"
  | "unknown";

type FetchMode =
  | "browser-document"
  | "feed"
  | "sitemap"
  | "article"
  | "archive"
  | "inspect"
  | "browser-fallback";

interface GovernedRequestContext {
  source: string;
  fetchMode: FetchMode;
  strategySource?: string;
  parserUsed?: string;
  fallbackChain?: string[];
  traceId?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

interface GovernedResponse {
  ok: boolean;
  status: number;
  url: string;
  headers: Record<string, string | string[]>;
  text: string;
  traceId: string;
  durationMs: number;
}

interface SiteStrategy {
  id: string;
  hostnames: string[];
  feedEndpoints?: string[];
  sitemapEndpoints?: string[];
  articleHints?: string[];
  readabilityHints?: string[];
  archiveFallbackRules?: string[];
  antiBotHints?: string[];
  preferredFetchMode?: "feed-first" | "sitemap-first" | "browser-first";
  parserPriority?: Array<"feed" | "sitemap" | "readability" | "browser" | "custom">;
  canonicalNormalization?: {
    stripQueryParams?: string[];
  };
  knownFailurePatterns?: string[];
}
```

## Module Dependency Flow

```text
siteStrategies
  -> articlePicker
      -> requestGovernance
          -> RequestGovernor
              -> httpClient
      -> feedDiscovery
      -> sitemap parser
  -> readerMode
      -> requestGovernance
      -> extractionSession for browser fallback
```

## Migration Checklist

- [x] Add request classification utility.
- [x] Add request governance facade.
- [x] Add structured request logs with trace id, domain, duration, source and mode.
- [x] Add declarative site strategy registry.
- [x] Route feed/sitemap/article fetch through governed requests.
- [x] Make strategy sources visible in logs.
- [x] Route archive URL probing through governed requests.
- [x] Add governed wrapper around browser automation lifecycle events.
- [x] Persist per-domain health scores.
- [x] Add ArticlePipeline for explicit stage fallback.
- [x] Add AdaptiveStrategyEngine.
- [x] Add pipeline state transitions and replayable traces.
- [x] Add ExtractionQualityEvaluator.
- [x] Add AntiBotIntelligence module.
- [x] Add request cost model.
- [x] Move translator network requests through RequestGovernor.
- [x] Start splitting articlePicker pure logic into candidate modules.
- [x] Add lightweight test runner.
- [x] Add BrowserExtractionController.
- [x] Route browser discovery and reader browser fallback through BrowserExtractionController.
- [x] Add FallbackStormProtector.
- [x] Split feed/sitemap reading into capability modules.
- [x] Add pipeline replay report builder.
- [x] Add CapabilityResult contract helpers.
- [x] Add FailureObject normalization.
- [x] Add PipelineMetadata normalization.
- [x] Add CapabilityRegistry.
- [x] Add contract/registry/replay tests.
- [x] Add CapabilityRunner.
- [x] Add CapabilityExecutionContext.
- [x] Move ArticlePipeline capability execution through CapabilityRunner.
- [x] Add runtime contract validation.
- [x] Add malformed capability output tests.
- [x] Add capability timeout normalization tests.
- [x] Add PolicyDecision contract.
- [x] Add PolicyExecutionContext.
- [x] Add TransitionRecord.
- [x] Add AdaptivePolicy / StormPolicy / HealthPolicy / TransitionPolicy.
- [x] Move adaptive, storm, health and transition logic behind policy modules.
- [x] Add policy replay tests.
- [ ] Move sitemap discovery into its own module.
- [ ] Add a health dashboard or JSON report for strategy hit rate and failure category rate.
- [ ] Convert every capability implementation to return CapabilityResult directly.
- [ ] Remove compatibility-only array-return paths once callers are migrated.
- [ ] Use extraction quality as a controlled fallback trigger.
- [ ] Persist anti-bot domain cooldowns as first-class health fields.

## TODO Roadmap

1. Split `articlePicker.js` into:
   - `feedReader.js`
   - `sitemapReader.js`
   - `articleCandidateFilter.js`
   - `articleDiscoveryPipeline.js`
   Current progress:
   - `candidateFilter.js`
   - `candidateNormalizer.js`
   - `candidateRanker.js`
2. Add per-site health:
   - last successful strategy
   - extraction success rate
   - common failure category
   Current progress:
   - `siteHealthStore.js`
   - quality/cost fields
3. Promote strategy files into `/src/main/sites/*.js` once the registry grows beyond a few sites.
4. Add tests around:
   - strategy resolution
   - failure classification
   - feed discovery states
   - candidate filtering
   Current progress:
   - `scripts/run-tests.js`
   - request governor retry test
   - adaptive strategy test
   - site health persistence test
   - quality evaluator test
   - pipeline transition test

## Risks

- Too many declarative strategy fields can become a second codebase. Keep strategies limited to data that changes per site.
- Browser-like headers can help with normal sites but will not defeat serious bot mitigation. Treat `ANTI_BOT` as a product state, not a parser failure.
- Hidden BrowserWindow fallback still needs lifecycle diagnostics because Chromium resource requests can fail independently of the app's governed HTTP requests.
- Contract drift is now the highest maintainability risk. New capabilities should return CapabilityResult from day one.
- `ArticlePipeline` can become a god object if it continues to own state transitions, adaptive decisions, storm suppression and capability execution. The next cleanup should move capability execution into registry-backed capability runners.
- After CapabilityRunner, the remaining god-object risk in `ArticlePipeline` is policy concentration: adaptive decisions, storm suppression and health recording still live together. Future cleanup should move policy decisions into small policy modules with explicit inputs/outputs.
- After Policy Layer, the remaining risk is orchestration density: `ArticlePipeline` still coordinates sequencing, state and policy calls. Keep it small by moving only stable, repeated decisions into policies; avoid creating a general rules engine.

## Stabilization Boundary

The architecture is now in stabilization mode. The goal is not to keep adding layers. The goal is to keep runtime behavior predictable, replayable and bounded.

### ArticlePipeline Final Responsibility

`articlePipeline.js` is the orchestration boundary. It is allowed to:

- create one trace for a candidate discovery run
- resolve static site strategy and health
- ask policies for decisions
- select the next capability stage
- call `CapabilityRunner`
- record health outcomes
- emit state transitions
- return normalized article candidates

It is not allowed to:

- implement capability execution details
- perform direct HTTP requests
- create or destroy BrowserWindows directly
- normalize raw capability output
- implement retry/backoff/timeouts
- contain site-specific parsing rules
- contain anti-bot heuristics beyond invoking policy/runtime modules
- silently skip fallback stages without trace events

This boundary is intentionally pragmatic. `ArticlePipeline` remains dense because orchestration has to live somewhere. Do not split it into a new orchestration runtime unless the existing loop becomes impossible to reason about in tests.

### Orchestration Invariants

- Every discovery run starts with a trace id.
- Every terminal run ends in `SUCCESS` or `FAILURE`.
- Every stage entry has a transition record.
- Every fallback has a transition reason.
- Every failed capability has a normalized `FailureObject`.
- Every suppressed expensive fallback records a policy decision.
- Health updates happen after stage outcomes, not before.
- Browser fallback is always treated as expensive and last-resort.
- Replay output must be able to explain the final result without reading logs from another subsystem.

### Orchestration Anti-Patterns

Avoid these changes:

- adding `if (domain.includes(...))` inside `ArticlePipeline`
- calling `fetch`, `requestText`, `BrowserWindow` or archive probes directly from `ArticlePipeline`
- returning raw arrays from new capabilities without a `CapabilityResult`
- swallowing capability failure and moving to the next stage without a trace event
- adding retries inside a capability handler that are invisible to `RequestGovernor` or `CapabilityRunner`
- creating a generic workflow/rules engine for the current stage count

### Future Extension Rules

- Add a capability only when a new stable source of article candidates exists.
- Add a policy only when the decision is reused or growing in more than one place.
- Prefer extending `CapabilityResult`, `FailureObject` and replay tests over adding new ad hoc log fields.
- Site-specific behavior belongs in site strategies or capability internals, not orchestration.
- A fallback path is not complete until replay explains why it was entered, skipped or suppressed.

## Replay Correctness

Replay is now treated as a correctness artifact, not just a debug print.

`pipelineReplayReport.js` exposes `validateReplayIntegrity(traceSummary)` and embeds the result under:

```json
{
  "integrity": {
    "ok": true,
    "issueCount": 0,
    "issues": []
  }
}
```

Current integrity checks:

- empty trace
- missing initial `INIT` transition
- missing terminal `SUCCESS` / `FAILURE`
- broken transition chain
- failed stage without transition reason
- failed capability result without `FailureObject`

Human-readable reports also include:

```text
Replay integrity: ok (0 issues)
```

Replay validation is intentionally conservative. Medium-severity issues can warn about imperfect diagnostics without failing the whole report. High-severity issues mean the replay cannot be trusted as a complete explanation of runtime behavior.

## Integration Testing Roadmap

Unit tests already cover contracts, policy decisions and runner behavior. Stabilization requires integration-style tests around orchestration behavior:

- feed empty -> sitemap empty -> browser fallback
- browser fallback suppressed by storm policy
- anti-bot failure -> cooldown recommendation -> expensive stage skipped
- low-quality extraction -> fallback transition recorded
- cancellation -> BrowserWindow cleanup -> no orphan lifecycle state
- adaptive plan reranks stages based on health
- health record is written after stage success/failure
- replay integrity stays valid for success, failure and suppression paths

These tests should use fake capability handlers and fake stores. They should not require live publisher websites.

## Lifecycle Cleanup Review

Cleanup boundaries:

- `RequestGovernor` owns request timeout, retry, dedupe and request-level logging.
- `CapabilityRunner` owns execution timeout, result normalization and metadata normalization.
- `BrowserExtractionController` owns hidden BrowserWindow lifecycle and extraction session cleanup.
- `FallbackStormProtector` owns temporary suppression state.
- `SiteHealthStore` owns persisted per-domain rolling history.
- `PipelineTrace` owns per-run trace events.

Expected cleanup guarantees:

- hidden BrowserWindows are stopped and destroyed in `finally`
- extraction sessions are cleaned even when worker code throws
- browser fallback concurrency remains limited
- failed capabilities return normalized failures instead of throwing raw errors into orchestration
- replay entries are scoped to one `PipelineTrace` and do not persist beyond the run unless explicitly exported
- storm suppression is rolling-window based and can recover after cooldown

Remaining Chromium limitations are acceptable if they stay documented: page subresources are governed through session blockers and lifecycle control, not through `RequestGovernor.request()`.

## Complexity Budget Review

Most complex modules today:

- `articlePipeline.js`: acceptable orchestration density
- `browserExtractionController.js`: dangerous lifecycle surface, but bounded
- `articleDiscoveryPipeline.js`: remaining candidate aggregation complexity
- `pipelineReplayReport.js`: can drift if runtime metadata changes without tests
- `policies.js`: small now; watch for policy concentration returning

Do not add new abstractions around:

- orchestration runtime
- policy engine
- workflow engine
- dependency injection
- generic crawler framework

Allowed growth areas:

- focused integration tests
- replay integrity checks
- documentation of invariants
- small site strategies
- capability contract tests
- cleanup/lifecycle assertions

Dangerous growth areas:

- hidden fallback branches
- direct network paths outside RequestGovernor
- new BrowserWindow entry points
- capability outputs that bypass normalization
- site-specific behavior leaking into orchestration

## Future Contributors Guidelines

Before adding a capability:

- prove the existing capabilities cannot express the path
- register it in `CapabilityRegistry`
- execute it through `CapabilityRunner`
- return `CapabilityResult`
- add replay and contract tests

Before adding a policy:

- identify the concrete decision it owns
- keep inputs inside `PolicyExecutionContext`
- return `PolicyDecision`
- add tests for allow, suppress and recovery paths

Before changing fallback behavior:

- add a transition reason
- update replay output if a new reason needs explanation
- confirm `validateReplayIntegrity` still passes
- add an integration test that fails before the change

Before changing BrowserWindow extraction:

- keep isolated sessions
- keep resource blocking
- keep concurrency limited
- prove cleanup on success, timeout, cancellation and worker failure

## Remaining Technical Debt

Acceptable complexity:

- `ArticlePipeline` coordinates stage sequencing. This should remain visible rather than hidden behind a new framework.
- Chromium subresources cannot be completely governed by RequestGovernor. The controller/session safeguards are the correct boundary.
- Some compatibility array-return paths remain while older callers migrate.

Dangerous complexity:

- any new direct fetch path outside RequestGovernor
- any new hidden BrowserWindow path outside BrowserExtractionController
- any capability that returns malformed output and relies on runner recovery
- any replay event emitted without enough metadata to explain a decision

Future cleanup candidates:

- move remaining sitemap discovery details out of compatibility code
- convert all capability implementations to return CapabilityResult directly
- make extraction quality a controlled fallback trigger once false positives are understood
- persist anti-bot cooldowns as first-class health fields

## Stabilization Checklist

- [x] Runtime request paths governed by RequestGovernor where possible.
- [x] Browser fallback lifecycle governed by BrowserExtractionController.
- [x] Capability execution centralized in CapabilityRunner.
- [x] Policy decisions centralized in policy modules.
- [x] Capability and failure contracts normalized.
- [x] Replay report includes capability, policy and decision summaries.
- [x] Replay integrity validation added.
- [x] Contract and replay tests cover malformed output.
- [ ] Add integration tests for feed -> sitemap -> browser fallback.
- [ ] Add integration tests for anti-bot suppression recovery.
- [ ] Add integration tests for low-quality extraction fallback.
- [ ] Add cancellation + cleanup lifecycle integration tests.
- [ ] Remove compatibility-only array-return paths after callers migrate.
