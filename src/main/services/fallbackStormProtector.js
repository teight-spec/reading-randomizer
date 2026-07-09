const { getRequestCost } = require("./requestCostModel");

const DEFAULT_DOMAIN_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_EXPENSIVE_BUDGET = 18;

class FallbackStormProtector {
  constructor({ windowMs = DEFAULT_DOMAIN_WINDOW_MS, expensiveBudget = DEFAULT_EXPENSIVE_BUDGET } = {}) {
    this.windowMs = windowMs;
    this.expensiveBudget = expensiveBudget;
    this.eventsByDomain = new Map();
    this.disabledUntil = new Map();
  }

  canEnter({ domain, stageName, health = null }) {
    const now = Date.now();
    const siteHealth = health || {};
    this.prune(domain, now);
    const disabledKey = `${domain}:${stageName}`;
    const disabledUntil = this.disabledUntil.get(disabledKey) || 0;
    if (disabledUntil > now) {
      return {
        allowed: false,
        reason: "stage_temporarily_disabled",
        retryAfterMs: disabledUntil - now
      };
    }

    const cost = getRequestCost(stageName);
    const events = this.eventsByDomain.get(domain) || [];
    const recentCost = events.reduce((sum, event) => sum + Number(event.cost || 0), 0);
    if (["browser", "archive"].includes(stageName) && recentCost + cost.estimatedCost > this.expensiveBudget) {
      return {
        allowed: false,
        reason: "expensive_fallback_budget_exceeded",
        recentCost,
        budget: this.expensiveBudget
      };
    }

    if (stageName === "browser" && siteHealth.browserSuccessRate !== null && siteHealth.browserSuccessRate <= 0.15) {
      this.disabledUntil.set(disabledKey, now + this.windowMs);
      return {
        allowed: false,
        reason: "browser_low_success_rate_cutoff",
        retryAfterMs: this.windowMs
      };
    }

    if (siteHealth.botBlockedRate !== null && siteHealth.botBlockedRate >= 0.45 && ["browser", "archive"].includes(stageName)) {
      this.disabledUntil.set(disabledKey, now + this.windowMs);
      return {
        allowed: false,
        reason: "anti_bot_escalation_cooldown",
        retryAfterMs: this.windowMs
      };
    }

    return {
      allowed: true,
      reason: "allowed"
    };
  }

  record({ domain, stageName, ok, failureCategory = null, qualityScore = null }) {
    const now = Date.now();
    this.prune(domain, now);
    const cost = getRequestCost(stageName);
    const events = this.eventsByDomain.get(domain) || [];
    events.unshift({
      at: now,
      stageName,
      ok: Boolean(ok),
      failureCategory,
      qualityScore,
      cost: cost.estimatedCost
    });
    this.eventsByDomain.set(domain, events);

    const recentFailures = events.filter((event) => event.stageName === stageName && !event.ok).slice(0, 3);
    if (recentFailures.length >= 3 && ["browser", "archive"].includes(stageName)) {
      this.disabledUntil.set(`${domain}:${stageName}`, now + this.windowMs);
    }
  }

  prune(domain, now = Date.now()) {
    const events = this.eventsByDomain.get(domain) || [];
    this.eventsByDomain.set(domain, events.filter((event) => now - event.at <= this.windowMs));
  }
}

module.exports = {
  FallbackStormProtector
};
