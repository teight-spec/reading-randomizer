const { resolveSiteStrategy } = require("./siteStrategies");
const { createTraceId } = require("./requestClassification");
const { getRequestCost } = require("./requestCostModel");
const { PipelineTrace } = require("./pipelineTrace");
const { createCapabilityResult } = require("./capabilityContract");
const { CapabilityRegistry } = require("./capabilityRegistry");
const { CapabilityRunner } = require("./capabilityRunner");
const { createCapabilityExecutionContext, domainFor } = require("./capabilityExecutionContext");
const { createPolicyExecutionContext } = require("./policyContract");
const { AdaptivePolicy, StormPolicy, HealthPolicy, TransitionPolicy } = require("./policies");

const DEFAULT_STAGES = ["feed-sitemap", "browser"];
const PipelineState = Object.freeze({
  INIT: "INIT",
  RESOLVE_STRATEGY: "RESOLVE_STRATEGY",
  FEED_DISCOVERY: "FEED_DISCOVERY",
  SITEMAP_DISCOVERY: "SITEMAP_DISCOVERY",
  BROWSER_DISCOVERY: "BROWSER_DISCOVERY",
  ARTICLE_EXTRACTION: "ARTICLE_EXTRACTION",
  ARCHIVE_PROBE: "ARCHIVE_PROBE",
  SUCCESS: "SUCCESS",
  FAILURE: "FAILURE"
});

class ArticlePipeline {
  constructor({ siteHealthStore = null } = {}) {
    this.siteHealthStore = siteHealthStore;
    this.adaptivePolicy = new AdaptivePolicy();
    this.stormPolicy = new StormPolicy();
    this.healthPolicy = new HealthPolicy(siteHealthStore);
    this.transitionPolicy = new TransitionPolicy();
    this.capabilityRegistry = new CapabilityRegistry();
    this.capabilityRunner = new CapabilityRunner();
  }

  async getCandidates(site, { limit = 12, timeoutMs = 12000, enabledStages = DEFAULT_STAGES } = {}) {
    const traceId = createTraceId("article-pipeline");
    let state = PipelineState.INIT;
    const strategy = resolveSiteStrategy(site.url);
    const trace = new PipelineTrace({ traceId, site, strategy });
    state = this.transition(trace, null, state, "pipeline_created").state;
    state = this.transition(trace, state, PipelineState.RESOLVE_STRATEGY, "resolving_static_strategy_and_site_health").state;
    const health = this.siteHealthStore ? await this.siteHealthStore.getSiteHealth(site) : null;
    const adaptiveOutcome = this.adaptivePolicy.decide({
      staticStrategy: strategy,
      health,
      enabledStages
    });
    const adaptivePlan = adaptiveOutcome.plan;
    const stages = adaptivePlan.stages;
    const context = createCapabilityExecutionContext({
      traceId,
      site,
      strategy,
      health,
      adaptivePlan,
      trace,
      siteHealthStore: this.siteHealthStore
    });
    Object.assign(context, {
      fallbackChain: []
    });
    const capabilities = this.capabilityRegistry.list({ domain: domainFor(site) });

    logPipeline("pipeline_start", {
      traceId,
      siteTitle: site.title,
      domain: site.domain,
      strategySource: strategy?.id || "generic",
      stages,
      adaptiveDecisions: adaptiveOutcome.decisions,
      capabilities: capabilities.map((capability) => ({
        name: capability.name,
        priority: capability.priority,
        cost: capability.estimatedCost
      }))
    });

    for (let index = 0; index < stages.length; index += 1) {
      const stageName = stages[index];
      const policyContext = createPolicyExecutionContext({
        traceId,
        currentState: state,
        site,
        strategy,
        health,
        adaptivePlan,
        previousFailures: context.fallbackChain,
        stormState: null,
        fallbackChain: context.fallbackChain
      });
      const stormDecision = this.stormPolicy.canEnter({
        domain: domainFor(site),
        stageName: publicStageName(stageName),
        health,
        policyContext
      });
      if (!stormDecision.allowed) {
        const skipped = {
          articles: [],
          durationMs: 0,
          stageName,
          strategySource: "storm-protector",
          failureCategory: "empty_content",
          failureTransitionReason: stormDecision.raw.reason,
          cost: getRequestCost(publicStageName(stageName))
        };
        context.fallbackChain.push({
          stageName,
          reason: skipped.failureTransitionReason,
          failureCategory: skipped.failureCategory,
          cost: skipped.cost
        });
        trace.stage(stageName, {
          ok: false,
          durationMs: 0,
          transitionReason: stormDecision.raw.reason,
          failureCategory: skipped.failureCategory,
          retryCount: 0,
          cost: skipped.cost,
          policyDecision: stormDecision.policyDecision,
          qualityScore: null
        });
        logPipeline("pipeline_stage_suppressed", {
          traceId,
          stageName,
          stormDecision
        });
        continue;
      }
      state = this.transition(trace, state, stateForStage(stageName), `enter_stage:${stageName}`, {
        policyName: "transition-policy",
        payload: {
          fallbackAllowed: true,
          policyDecision: stormDecision.policyDecision
        }
      }).state;
      const result = await this.runStage(stageName, context, { limit, timeoutMs, attemptIndex: index });
      this.stormPolicy.record({
        domain: domainFor(site),
        stageName: publicStageName(stageName),
        ok: Boolean(result.articles.length),
        failureCategory: result.failureCategory
      });
      if (result.articles.length) {
        state = this.transition(trace, state, PipelineState.SUCCESS, "article_candidates_found", {
          policyName: "transition-policy",
          payload: {
            stageName,
            articleCount: result.articles.length,
            qualityScore: null,
            cost: result.cost,
            capabilityResult: result.capabilityResult
          }
        }).state;
        await this.recordHealth(site, {
          stageName: publicStageName(stageName),
          ok: true,
          latencyMs: result.durationMs,
          strategySource: result.strategySource,
          fallbackReason: result.fallbackReason,
          traceId,
          cost: result.cost?.estimatedCost || null
        });
        logPipeline("pipeline_success", {
          traceId,
          stageName,
          articleCount: result.articles.length,
          fallbackChain: context.fallbackChain,
          trace: trace.summary({ state })
        });
        return result.articles;
      }

      context.fallbackChain.push({
        stageName,
        reason: result.failureTransitionReason,
        failureCategory: result.failureCategory,
        cost: result.cost
      });
      await this.recordHealth(site, {
        stageName: publicStageName(stageName),
        ok: false,
        latencyMs: result.durationMs,
        strategySource: result.strategySource,
        failureCategory: result.failureCategory,
        fallbackReason: result.failureTransitionReason,
        traceId,
        cost: result.cost?.estimatedCost || null
      });
      trace.stage(stageName, {
        ok: false,
        durationMs: result.durationMs,
        transitionReason: result.failureTransitionReason,
        failureCategory: result.failureCategory,
        retryCount: 0,
        cost: result.cost,
        qualityScore: result.capabilityResult?.qualityScore ?? null,
        metadata: result.metadata,
        capabilityResult: result.capabilityResult
      });
      logPipeline("pipeline_stage_fallback", {
        traceId,
        stageName,
        failureCategory: result.failureCategory,
        failureTransitionReason: result.failureTransitionReason,
        nextStage: stages[index + 1] || null
      });
    }

    state = this.transition(trace, state, PipelineState.FAILURE, "all_enabled_stages_failed", {
      policyName: "transition-policy",
      payload: {
        fallbackAllowed: false,
        failureCategory: "empty_content"
      }
    }).state;
    logPipeline("pipeline_failed", {
      traceId,
      fallbackChain: context.fallbackChain,
      trace: trace.summary({ state })
    });
    return [];
  }

  async runStage(stageName, context, options) {
    const capability = this.capabilityRegistry.getForStage(stageName);
    const handler = capability ? this.capabilityRegistry.getHandler(capability.name) : null;
    if (capability && handler) {
      const runtime = await this.capabilityRunner.run({
        capability,
        context,
        input: {
          limit: options.limit,
          stageName
        },
        attemptIndex: options.attemptIndex,
        timeoutMs: options.timeoutMs,
        handler
      });
      const articles = runtime.result.data?.articles || [];
      return {
        articles,
        durationMs: runtime.metadata.duration,
        stageName,
        strategySource: runtime.result.strategySource,
        cost: runtime.metadata.cost,
        metadata: runtime.metadata,
        capabilityResult: runtime.result,
        failureCategory: runtime.result.failureCategory,
        failureTransitionReason: runtime.result.failure?.transitionReason || null
      };
    }

    return {
      articles: [],
      durationMs: 0,
      stageName,
      strategySource: "disabled",
      failureCategory: "unknown",
      failureTransitionReason: `stage_disabled_or_unknown:${stageName}`,
      cost: getRequestCost(publicStageName(stageName)),
      capabilityResult: createCapabilityResult({
        success: false,
        capabilityName: stageName,
        stage: publicStageName(stageName),
        strategySource: "disabled",
        failure: {
          category: "unknown",
          stage: publicStageName(stageName),
          retryable: false,
          transitionReason: `stage_disabled_or_unknown:${stageName}`
        }
      })
    };
  }

  async recordHealth(site, event) {
    const decision = await this.healthPolicy.record(site, event);
    logPipeline("pipeline_policy_decision", {
      traceId: event.traceId || null,
      decision
    });
  }

  transition(trace, from, to, reason, options = {}) {
    return this.transitionPolicy.transition(trace, {
      from,
      to,
      reason,
      policyName: options.policyName || "transition-policy",
      payload: options.payload || {}
    });
  }
}

function publicStageName(stageName) {
  if (stageName === "feed-sitemap") return "feed";
  return stageName;
}

function stateForStage(stageName) {
  if (stageName === "feed-sitemap") return PipelineState.FEED_DISCOVERY;
  if (stageName === "browser") return PipelineState.BROWSER_DISCOVERY;
  if (stageName === "archive") return PipelineState.ARCHIVE_PROBE;
  return PipelineState.FEED_DISCOVERY;
}

function logPipeline(event, payload) {
  console.info("[article-pipeline]", JSON.stringify({
    event,
    timestamp: Date.now(),
    payload
  }));
}

module.exports = {
  ArticlePipeline,
  PipelineState
};
