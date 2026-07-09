const {
  createCapabilityResult,
  createFailureObject,
  createPipelineMetadata,
  validateCapabilityResult,
  validatePipelineMetadata
} = require("./capabilityContract");
const { classifyFailure } = require("./requestClassification");

class CapabilityRunner {
  async run({ capability, context, input = {}, attemptIndex = 0, timeoutMs = 12000, handler }) {
    const stage = capability?.stage || input.stage || "unknown";
    const capabilityName = capability?.name || input.capabilityName || stage;
    const startedAt = Date.now();
    const strategySource = context.strategySource || "generic";
    emitRuntimeEvent("capability_start", {
      traceId: context.traceId,
      capabilityName,
      stage,
      attemptIndex,
      strategySource
    });

    try {
      const raw = await withTimeout(
        Promise.resolve().then(() => handler({ context, input, capability })),
        timeoutMs,
        () => createCapabilityResult({
          success: false,
          capabilityName,
          stage,
          strategySource,
          duration: Date.now() - startedAt,
          failure: {
            category: "timeout",
            stage,
            retryable: true,
            severity: "medium",
            transitionReason: `${stage}_timeout`
          }
        })
      );
      const result = normalizeCapabilityResult(raw, {
        capabilityName,
        stage,
        strategySource,
        duration: Date.now() - startedAt
      });
      const metadata = createPipelineMetadata({
        stage,
        stageStart: startedAt,
        stageEnd: Date.now(),
        strategySource,
        fallbackReason: result.failure?.transitionReason || null,
        attemptIndex,
        stateTransition: `capability:${capabilityName}`,
        traceId: context.traceId
      });
      validateCapabilityResult(result);
      validatePipelineMetadata(metadata);
      emitRuntimeEvent("capability_complete", {
        traceId: context.traceId,
        capabilityName,
        stage,
        success: result.success,
        failureCategory: result.failureCategory,
        duration: metadata.duration
      });
      return {
        result,
        metadata
      };
    } catch (error) {
      const failure = createFailureObject({
        category: classifyFailure(error),
        stage,
        retryable: false,
        severity: "medium",
        originalError: error,
        domain: context.domain,
        strategy: strategySource,
        transitionReason: error.message || "capability_failed"
      });
      const result = createCapabilityResult({
        success: false,
        capabilityName,
        stage,
        strategySource,
        duration: Date.now() - startedAt,
        failure
      });
      const metadata = createPipelineMetadata({
        stage,
        stageStart: startedAt,
        stageEnd: Date.now(),
        strategySource,
        fallbackReason: failure.transitionReason,
        attemptIndex,
        stateTransition: `capability:${capabilityName}`,
        traceId: context.traceId
      });
      validateCapabilityResult(result);
      validatePipelineMetadata(metadata);
      emitRuntimeEvent("capability_failed", {
        traceId: context.traceId,
        capabilityName,
        stage,
        failureCategory: result.failureCategory,
        error: error.message
      });
      return {
        result,
        metadata
      };
    }
  }
}

function normalizeCapabilityResult(raw, defaults) {
  if (raw?.success !== undefined && raw?.capabilityName && raw?.stage) {
    return {
      ...raw,
      duration: typeof raw.duration === "number" ? raw.duration : defaults.duration
    };
  }
  return createCapabilityResult({
    ...defaults,
    success: Boolean(raw?.success),
    data: raw?.data || raw || null,
    failure: raw?.failure || (raw?.success ? null : {
      category: "unknown",
      stage: defaults.stage,
      retryable: false,
      transitionReason: "malformed_capability_output_normalized"
    })
  });
}

function withTimeout(promise, timeoutMs, fallbackFactory) {
  let timer = null;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallbackFactory()), timeoutMs);
    })
  ]);
}

function emitRuntimeEvent(event, payload) {
  console.info("[capability-runtime]", JSON.stringify({
    event,
    timestamp: Date.now(),
    payload
  }));
}

module.exports = {
  CapabilityRunner,
  normalizeCapabilityResult
};
