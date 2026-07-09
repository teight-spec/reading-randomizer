const { shouldThrottleExpensiveStage } = require("./requestCostModel");

class AdaptiveStrategyEngine {
  decide({ staticStrategy = null, health = null, enabledStages = [] } = {}) {
    const decisions = [];
    let stages = [...enabledStages];
    const siteHealth = health || {};

    if (siteHealth.lastSuccessfulStrategy) {
      const preferred = privateStageName(siteHealth.lastSuccessfulStrategy);
      if (stages.includes(preferred)) {
        stages = [preferred, ...stages.filter((stage) => stage !== preferred)];
        decisions.push({
          type: "prefer_last_successful_strategy",
          stageName: preferred,
          reason: `lastSuccessfulStrategy=${siteHealth.lastSuccessfulStrategy}`
        });
      }
    }

    if (siteHealth.feedSuccessRate !== null && siteHealth.feedSuccessRate >= 0.7 && stages.includes("feed-sitemap")) {
      stages = ["feed-sitemap", ...stages.filter((stage) => stage !== "feed-sitemap")];
      decisions.push({
        type: "prefer_feed",
        stageName: "feed-sitemap",
        reason: `feedSuccessRate=${siteHealth.feedSuccessRate}`
      });
    }

    if (siteHealth.botBlockedRate !== null && siteHealth.botBlockedRate >= 0.35) {
      decisions.push({
        type: "anti_bot_cooldown",
        reason: `botBlockedRate=${siteHealth.botBlockedRate}`,
        cooldownRecommendationMs: 30 * 60 * 1000
      });
    }

    stages = stages.filter((stageName) => {
      const shouldSkip = shouldThrottleExpensiveStage(publicStageName(stageName), siteHealth);
      if (shouldSkip) {
        decisions.push({
          type: "skip_expensive_stage",
          stageName,
          reason: "low historical success or high anti-bot risk"
        });
      }
      return !shouldSkip;
    });

    if (!stages.length) {
      stages = ["feed-sitemap"];
      decisions.push({
        type: "restore_minimum_stage",
        stageName: "feed-sitemap",
        reason: "adaptive filtering removed every stage"
      });
    }

    return {
      stages,
      parserPriority: staticStrategy?.parserPriority || [],
      reduceConcurrency: Boolean(siteHealth.botBlockedRate !== null && siteHealth.botBlockedRate >= 0.25),
      cooldownRecommendationMs: decisions.find((item) => item.type === "anti_bot_cooldown")?.cooldownRecommendationMs || 0,
      decisions
    };
  }
}

function privateStageName(stageName) {
  if (stageName === "feed") return "feed-sitemap";
  return stageName;
}

function publicStageName(stageName) {
  if (stageName === "feed-sitemap") return "feed";
  return stageName;
}

module.exports = {
  AdaptiveStrategyEngine
};
