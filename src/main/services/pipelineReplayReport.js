function buildReplayReport(traceSummary = {}) {
  const events = traceSummary.events || [];
  const failures = events.filter((event) => event.failureCategory);
  const fallbacks = events.filter((event) => event.transitionReason || /fallback|failed|empty|timeout/i.test(event.reason || ""));
  const strategyDecisions = events.filter((event) => /strategy|resolve|adaptive/i.test(`${event.reason || ""} ${event.transitionReason || ""}`));
  const capabilityResults = events.map((event) => event.capabilityResult).filter(Boolean);
  const metadata = events.map((event) => event.metadata).filter(Boolean);
  const policyDecisions = events
    .flatMap((event) => [event.policyDecision, event.policyDecision?.metadata?.policyDecision])
    .filter(Boolean);
  const integrity = validateReplayIntegrity(traceSummary);

  return {
    json: {
      traceId: traceSummary.traceId,
      site: traceSummary.site,
      strategy: traceSummary.strategy,
      durationMs: traceSummary.durationMs,
      finalState: traceSummary.state,
      events,
      capabilityResults,
      metadata,
      policyDecisions,
      integrity,
      failureSummary: summarizeFailures(failures),
      fallbackSummary: fallbacks.map((event) => ({
        stage: event.stageName || event.from,
        reason: event.transitionReason || event.reason,
        failureCategory: event.failureCategory || null
      })),
      strategyDecisionSummary: strategyDecisions.map((event) => ({
        from: event.from,
        to: event.to,
        reason: event.reason || event.transitionReason
      })),
      decisionTree: buildDecisionTree(events, policyDecisions)
    },
    text: renderTextReport(traceSummary, failures, fallbacks, strategyDecisions, capabilityResults, policyDecisions, integrity)
  };
}

function validateReplayIntegrity(traceSummary = {}) {
  const events = traceSummary.events || [];
  const issues = [];
  const transitions = events.filter((event) => event.type === "transition");
  const stages = events.filter((event) => event.type === "stage");

  if (!events.length) {
    issues.push({ severity: "high", code: "empty_trace", message: "Trace has no events" });
  }

  if (transitions[0]?.to !== "INIT") {
    issues.push({ severity: "medium", code: "missing_init_transition", message: "Trace does not start with INIT transition" });
  }

  const finalState = traceSummary.state || transitions[transitions.length - 1]?.to;
  if (!["SUCCESS", "FAILURE"].includes(finalState)) {
    issues.push({ severity: "high", code: "missing_terminal_state", message: "Trace has no terminal SUCCESS/FAILURE state" });
  }

  for (let index = 1; index < transitions.length; index += 1) {
    const previous = transitions[index - 1];
    const current = transitions[index];
    if (current.from !== previous.to) {
      issues.push({
        severity: "medium",
        code: "transition_chain_break",
        message: `Transition ${index} starts from ${current.from}, expected ${previous.to}`
      });
    }
  }

  for (const stage of stages) {
    if (!stage.transitionReason && stage.ok === false) {
      issues.push({
        severity: "medium",
        code: "missing_stage_failure_reason",
        message: `Failed stage ${stage.stageName || "unknown"} has no transition reason`
      });
    }
    if (stage.capabilityResult && stage.capabilityResult.success === false && !stage.capabilityResult.failure) {
      issues.push({
        severity: "high",
        code: "missing_capability_failure",
        message: `Capability ${stage.capabilityResult.capabilityName || "unknown"} failed without FailureObject`
      });
    }
  }

  return {
    ok: !issues.some((issue) => issue.severity === "high"),
    issueCount: issues.length,
    issues
  };
}

function summarizeFailures(failures) {
  return failures.reduce((summary, event) => {
    const key = event.failureCategory || "unknown";
    summary[key] = (summary[key] || 0) + 1;
    return summary;
  }, {});
}

function buildDecisionTree(events, policyDecisions = []) {
  return events.map((event) => ({
    type: event.type,
    stage: event.stageName || event.to || "unknown",
    reason: event.transitionReason || event.reason || null,
    success: event.ok ?? null,
    failureCategory: event.failureCategory || event.capabilityResult?.failureCategory || null,
    suppressed: /suppressed|disabled|storm/i.test(event.transitionReason || event.reason || ""),
    costClass: event.metadata?.costClass || event.cost?.latencyClass || null,
    qualityScore: event.qualityScore ?? event.capabilityResult?.qualityScore ?? null,
    policy: event.policyDecision?.policyName || policyDecisions.find((decision) => decision.resultingTransition === event.to)?.policyName || null
  }));
}

function renderTextReport(traceSummary, failures, fallbacks, strategyDecisions, capabilityResults, policyDecisions, integrity) {
  return [
    `Trace: ${traceSummary.traceId || "unknown"}`,
    `Site: ${traceSummary.site?.title || traceSummary.site?.domain || "unknown"}`,
    `Strategy: ${traceSummary.strategy || "generic"}`,
    `Duration: ${traceSummary.durationMs || 0}ms`,
    `Final state: ${traceSummary.state || "unknown"}`,
    `Replay integrity: ${integrity.ok ? "ok" : "failed"} (${integrity.issueCount} issues)`,
    `Failures: ${failures.map((event) => `${event.stageName || event.to}:${event.failureCategory}`).join(", ") || "none"}`,
    `Fallbacks: ${fallbacks.map((event) => `${event.stageName || event.from}->${event.transitionReason || event.reason}`).join(", ") || "none"}`,
    `Strategy decisions: ${strategyDecisions.map((event) => event.reason || event.transitionReason).join(", ") || "none"}`,
    `Capabilities: ${capabilityResults.map((result) => `${result.capabilityName}:${result.success ? "success" : result.failureCategory || "failed"}`).join(", ") || "none"}`,
    `Policy decisions: ${policyDecisions.map((decision) => `${decision.policyName}:${decision.decision}`).join(", ") || "none"}`
  ].join("\n");
}

module.exports = {
  buildReplayReport,
  validateReplayIntegrity
};
