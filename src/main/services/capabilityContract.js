const { classifyFailure } = require("./requestClassification");
const { getRequestCost } = require("./requestCostModel");

function createFailureObject({
  category,
  subcategory = null,
  stage = "unknown",
  retryable = false,
  severity = "medium",
  originalError = null,
  domain = null,
  strategy = "generic",
  transitionReason = null
} = {}) {
  const inferredCategory = category || classifyFailure(originalError || {});
  return {
    category: inferredCategory,
    subcategory,
    stage,
    retryable: Boolean(retryable),
    severity,
    originalError: serializeError(originalError),
    domain,
    strategy,
    transitionReason: transitionReason || inferredCategory
  };
}

function createPipelineMetadata({
  stage,
  stageStart = Date.now(),
  stageEnd = null,
  duration = null,
  strategySource = "generic",
  costClass = null,
  fallbackReason = null,
  attemptIndex = 0,
  stateTransition = null,
  traceId = null
} = {}) {
  const cost = getRequestCost(stage);
  const end = stageEnd || Date.now();
  return {
    stage,
    stageStart,
    stageEnd: end,
    duration: duration ?? Math.max(0, end - stageStart),
    strategySource,
    costClass: costClass || cost.latencyClass,
    fallbackReason,
    attemptIndex,
    stateTransition,
    traceId,
    cost
  };
}

function createCapabilityResult({
  success = false,
  capabilityName,
  stage,
  strategySource = "generic",
  url = null,
  normalizedUrl = null,
  duration = 0,
  qualityScore = null,
  failure = null,
  retryable = false,
  antiBotDetected = false,
  contentMetadata = {},
  trace = {},
  data = null
} = {}) {
  const failureObject = failure
    ? createFailureObject({
        ...failure,
        stage,
        retryable: failure.retryable ?? retryable,
        strategy: strategySource,
        transitionReason: failure.transitionReason || failure.category
      })
    : null;

  return {
    success: Boolean(success),
    capabilityName,
    stage,
    strategySource,
    url,
    normalizedUrl: normalizedUrl || url,
    duration,
    qualityScore,
    failureCategory: failureObject?.category || null,
    retryable: Boolean(retryable),
    antiBotDetected: Boolean(antiBotDetected),
    contentMetadata,
    trace,
    failure: failureObject,
    data
  };
}

function validateCapabilityResult(result) {
  const errors = [];
  if (!result || typeof result !== "object") errors.push("result must be an object");
  if (typeof result?.success !== "boolean") errors.push("success must be boolean");
  if (!result?.capabilityName) errors.push("capabilityName is required");
  if (!result?.stage) errors.push("stage is required");
  if (!result?.strategySource) errors.push("strategySource is required");
  if (typeof result?.duration !== "number") errors.push("duration must be number");
  if ("failure" in (result || {}) && result.failure !== null) {
    errors.push(...validateFailureObject(result.failure).map((error) => `failure.${error}`));
  }
  if (errors.length) {
    const error = new Error(`Invalid CapabilityResult: ${errors.join("; ")}`);
    error.validationErrors = errors;
    throw error;
  }
  return true;
}

function validateFailureObject(failure) {
  const errors = [];
  if (!failure || typeof failure !== "object") return ["failure must be an object"];
  if (!failure.category) errors.push("category is required");
  if (!failure.stage) errors.push("stage is required");
  if (typeof failure.retryable !== "boolean") errors.push("retryable must be boolean");
  if (!failure.severity) errors.push("severity is required");
  if (!failure.strategy) errors.push("strategy is required");
  if (!failure.transitionReason) errors.push("transitionReason is required");
  return errors;
}

function validatePipelineMetadata(metadata) {
  const errors = [];
  if (!metadata || typeof metadata !== "object") errors.push("metadata must be an object");
  if (!metadata?.stage) errors.push("stage is required");
  if (typeof metadata?.stageStart !== "number") errors.push("stageStart must be number");
  if (typeof metadata?.stageEnd !== "number") errors.push("stageEnd must be number");
  if (typeof metadata?.duration !== "number") errors.push("duration must be number");
  if (!metadata?.strategySource) errors.push("strategySource is required");
  if (!metadata?.costClass) errors.push("costClass is required");
  if (typeof metadata?.attemptIndex !== "number") errors.push("attemptIndex must be number");
  if (errors.length) {
    const error = new Error(`Invalid PipelineMetadata: ${errors.join("; ")}`);
    error.validationErrors = errors;
    throw error;
  }
  return true;
}

function resultFromArticles({ capabilityName, stage, strategySource, articles, url = null, duration = 0, trace = {}, fallbackReason = null }) {
  const success = Boolean(articles?.length);
  return createCapabilityResult({
    success,
    capabilityName,
    stage,
    strategySource,
    url,
    duration,
    contentMetadata: {
      articleCount: articles?.length || 0
    },
    trace,
    data: {
      articles: articles || []
    },
    failure: success
      ? null
      : {
          category: "empty_content",
          stage,
          retryable: true,
          severity: "low",
          transitionReason: fallbackReason || `${stage}_returned_no_article_candidates`
        }
  });
}

function serializeError(error) {
  if (!error) return null;
  return {
    name: error.name || "Error",
    message: error.message || String(error),
    code: error.code || null,
    kind: error.kind || null,
    status: error.status || null
  };
}

module.exports = {
  createCapabilityResult,
  createFailureObject,
  createPipelineMetadata,
  resultFromArticles,
  validateCapabilityResult,
  validateFailureObject,
  validatePipelineMetadata
};
