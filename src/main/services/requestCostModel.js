const COSTS = {
  feed: {
    estimatedCost: 1,
    latencyClass: "low",
    antiBotRisk: "low",
    memoryImpact: "low"
  },
  sitemap: {
    estimatedCost: 2,
    latencyClass: "medium",
    antiBotRisk: "low",
    memoryImpact: "low"
  },
  article: {
    estimatedCost: 3,
    latencyClass: "medium",
    antiBotRisk: "medium",
    memoryImpact: "medium"
  },
  archive: {
    estimatedCost: 7,
    latencyClass: "high",
    antiBotRisk: "high",
    memoryImpact: "medium"
  },
  browser: {
    estimatedCost: 10,
    latencyClass: "very_high",
    antiBotRisk: "high",
    memoryImpact: "very_high"
  }
};

function getRequestCost(fetchMode = "article") {
  return COSTS[fetchMode] || COSTS.article;
}

function shouldThrottleExpensiveStage(stageName, health = {}) {
  if (!["browser", "archive"].includes(stageName)) return false;
  if (health.botBlockedRate !== null && health.botBlockedRate >= 0.35) return true;
  if (stageName === "browser" && health.browserSuccessRate !== null && health.browserSuccessRate <= 0.2) return true;
  if (stageName === "archive" && health.archiveSuccessRate !== null && health.archiveSuccessRate <= 0.2) return true;
  return false;
}

module.exports = {
  COSTS,
  getRequestCost,
  shouldThrottleExpensiveStage
};
