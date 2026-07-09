function createPolicyDecision({
  policyName,
  decision,
  reason,
  confidence = 1,
  triggeredBy = null,
  resultingTransition = null,
  suppressionApplied = false,
  fallbackAllowed = true,
  metadata = {}
} = {}) {
  return {
    policyName,
    decision,
    reason,
    confidence,
    triggeredBy,
    resultingTransition,
    suppressionApplied: Boolean(suppressionApplied),
    fallbackAllowed: Boolean(fallbackAllowed),
    metadata
  };
}

function createPolicyExecutionContext({
  traceId,
  currentState,
  site,
  strategy = null,
  health = null,
  adaptivePlan = null,
  previousFailures = [],
  qualityScore = null,
  antiBotSignals = [],
  retryState = null,
  stormState = null,
  fallbackChain = []
} = {}) {
  return {
    traceId,
    currentState,
    site,
    strategy,
    health,
    adaptivePlan,
    previousFailures,
    qualityScore,
    antiBotSignals,
    retryState,
    stormState,
    fallbackChain
  };
}

function createTransitionRecord({
  from,
  to,
  policyName = "transition-policy",
  reason,
  triggeringFailure = null,
  suppressionStatus = null,
  fallbackStatus = null,
  retryStatus = null,
  metadata = {}
} = {}) {
  return {
    from,
    to,
    policyName,
    reason,
    triggeringFailure,
    suppressionStatus,
    fallbackStatus,
    retryStatus,
    metadata,
    at: Date.now()
  };
}

module.exports = {
  createPolicyDecision,
  createPolicyExecutionContext,
  createTransitionRecord
};
