const { createRequestGovernance } = require("./requestGovernance");
const { classifyFailure, createTraceId } = require("./requestClassification");

const archiveRequests = createRequestGovernance({
  minIntervalMs: 1400,
  maxRetries: 1
});

const PAYWALL_PATTERNS = [
  /subscribe to continue/i,
  /subscription required/i,
  /sign in to continue/i,
  /create an account to continue/i,
  /already a subscriber/i,
  /this article is for subscribers/i,
  /to continue reading/i,
  /paywall/i
];

function looksPaywalled(htmlOrText = "") {
  return PAYWALL_PATTERNS.some((pattern) => pattern.test(htmlOrText));
}

function makeArchiveUrl(url) {
  return `https://archive.ph/newest/${encodeURIComponent(url)}`;
}

async function probeArchiveUrl(url, { strategySource = "archive-fallback", fallbackReason = "paywall_or_blocked", traceId = createTraceId("archive") } = {}) {
  const startedAt = Date.now();
  try {
    const response = await archiveRequests.request(url, {
      timeoutMs: 12000,
      source: "archive-fetch",
      profile: "browser-document",
      fetchMode: "archive",
      strategySource,
      traceId
    });
    logArchive("archive_probe_complete", {
      traceId,
      url,
      strategySource,
      fallbackReason,
      status: response.status,
      ok: response.ok,
      durationMs: Date.now() - startedAt,
      failureCategory: response.ok ? null : classifyFailure(null, response)
    });
    return response;
  } catch (error) {
    logArchive("archive_probe_failed", {
      traceId,
      url,
      strategySource,
      fallbackReason,
      durationMs: Date.now() - startedAt,
      failureCategory: classifyFailure(error),
      error: error.message
    });
    throw error;
  }
}

function logArchive(event, payload) {
  console.info("[archive]", JSON.stringify({
    event,
    timestamp: Date.now(),
    payload
  }));
}

module.exports = {
  looksPaywalled,
  makeArchiveUrl,
  probeArchiveUrl
};
