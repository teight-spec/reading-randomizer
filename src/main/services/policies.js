const { AdaptiveStrategyEngine } = require("./adaptiveStrategyEngine");
const { FallbackStormProtector } = require("./fallbackStormProtector");
const { createPolicyDecision, createTransitionRecord } = require("./policyContract");

class AdaptivePolicy {
  constructor(engine = new AdaptiveStrategyEngine()) {
    this.engine = engine;
  }

  decide({ staticStrategy, health, enabledStages }) {
    const plan = this.engine.decide({ staticStrategy, health, enabledStages });
    return {
      plan,
      decisions: plan.decisions.map((item) => createPolicyDecision({
        policyName: "adaptive-policy",
        decision: item.type,
        reason: item.reason,
        triggeredBy: item.stageName || "site-health",
        resultingTransition: item.stageName || null,
        metadata: item
      }))
    };
  }
}

class StormPolicy {
  constructor(protector = new FallbackStormProtector()) {
    this.protector = protector;
  }

  canEnter({ domain, stageName, health }) {
    const decision = this.protector.canEnter({ domain, stageName, health });
    return {
      allowed: decision.allowed,
      raw: decision,
      policyDecision: createPolicyDecision({
        policyName: "storm-policy",
        decision: decision.allowed ? "allow_stage" : "suppress_stage",
        reason: decision.reason,
        triggeredBy: stageName,
        resultingTransition: decision.allowed ? `enter:${stageName}` : `suppress:${stageName}`,
        suppressionApplied: !decision.allowed,
        fallbackAllowed: decision.allowed,
        metadata: decision
      })
    };
  }

  record(event) {
    this.protector.record(event);
  }
}

class HealthPolicy {
  constructor(siteHealthStore = null) {
    this.siteHealthStore = siteHealthStore;
  }

  async record(site, event) {
    if (!this.siteHealthStore) {
      return createPolicyDecision({
        policyName: "health-policy",
        decision: "skip_health_record",
        reason: "siteHealthStore unavailable",
        triggeredBy: event.stageName || "unknown",
        metadata: event
      });
    }
    await this.siteHealthStore.record(site, event);
    return createPolicyDecision({
      policyName: "health-policy",
      decision: "record_health",
      reason: event.ok ? "stage_success_recorded" : "stage_failure_recorded",
      triggeredBy: event.stageName || "unknown",
      metadata: event
    });
  }
}

class TransitionPolicy {
  transition(trace, { from, to, reason, policyName = "transition-policy", payload = {} }) {
    const record = createTransitionRecord({
      from,
      to,
      policyName,
      reason,
      triggeringFailure: payload.failureCategory || null,
      suppressionStatus: payload.suppressionApplied ?? null,
      fallbackStatus: payload.fallbackAllowed ?? null,
      retryStatus: payload.retryStatus || null,
      metadata: payload
    });
    trace.transition(from, to, {
      reason,
      policyDecision: record,
      ...payload
    });
    return {
      state: to,
      record
    };
  }
}

module.exports = {
  AdaptivePolicy,
  StormPolicy,
  HealthPolicy,
  TransitionPolicy
};
