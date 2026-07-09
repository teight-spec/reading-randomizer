function createCapabilityExecutionContext({
  traceId,
  site,
  strategy = null,
  health = null,
  adaptivePlan = null,
  trace = null,
  siteHealthStore = null,
  requestGovernance = null,
  cancellationSignal = null,
  qualityEvaluator = null
} = {}) {
  return {
    traceId,
    site,
    strategy,
    health,
    adaptivePlan,
    trace,
    siteHealthStore,
    requestGovernance,
    cancellationSignal,
    qualityEvaluator,
    strategySource: strategy?.id || "generic",
    domain: domainFor(site)
  };
}

function domainFor(site = {}) {
  if (site.domain) return site.domain;
  try {
    return new URL(site.url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

module.exports = {
  createCapabilityExecutionContext,
  domainFor
};
