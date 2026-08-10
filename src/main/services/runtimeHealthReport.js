function buildRuntimeHealthReport({
  networkErrors = null,
  articleHealth = null,
  siteHealth = null,
  browserMetrics = null,
  replayReports = null
} = {}) {
  const networkCollected = Array.isArray(networkErrors);
  const articleHealthCollected = Boolean(articleHealth && typeof articleHealth === "object");
  const siteHealthCollected = Boolean(siteHealth && typeof siteHealth === "object");
  const browserMetricsCollected = Boolean(browserMetrics && typeof browserMetrics === "object");
  const replayCollected = Array.isArray(replayReports);
  const safeNetworkErrors = networkCollected ? networkErrors : [];
  const safeArticleHealth = articleHealthCollected ? articleHealth : {};
  const safeSiteHealth = siteHealthCollected ? siteHealth : {};
  const safeReplayReports = replayCollected ? replayReports : [];
  const ipcFailures = safeNetworkErrors.filter((event) => event.probableModule === "ipc" || event.channel);
  const requestFailures = safeNetworkErrors.filter((event) => {
    const isIpc = event.probableModule === "ipc" || event.channel;
    return !isIpc && (event.error || event.statusCode >= 400);
  });
  const parserFailures = Object.values(safeArticleHealth).filter((item) => item.lastError);
  const cleanupFailures = browserMetricsCollected ? Number(browserMetrics.cleanupFailures || 0) : null;
  const antiBotSuppression = Object.values(safeSiteHealth.sites || {}).filter((item) => Number(item.botBlockedRate || 0) > 0);
  const replayInconsistencies = safeReplayReports.filter((report) => report?.json?.integrity && !report.json.integrity.ok);
  const extractionQualityFailures = Object.values(safeSiteHealth.sites || {}).filter((item) => {
    return item.avgQualityScore !== null && item.avgQualityScore !== undefined && item.avgQualityScore < 0.52;
  });

  const summary = {
    ipcFailures: networkCollected ? ipcFailures.length : null,
    requestFailures: networkCollected ? requestFailures.length : null,
    parserFailures: articleHealthCollected ? parserFailures.length : null,
    browserCleanupFailures: cleanupFailures,
    antiBotSuppression: siteHealthCollected ? antiBotSuppression.length : null,
    replayInconsistencies: replayCollected ? replayInconsistencies.length : null,
    extractionQualityFailures: siteHealthCollected ? extractionQualityFailures.length : null
  };
  const collectedValues = Object.values(summary).filter((value) => value !== null);
  const complete = collectedValues.length === Object.keys(summary).length;
  const hasIssues = collectedValues.some((value) => value > 0);

  return {
    summary,
    ok: complete && !hasIssues,
    complete,
    hasIssues,
    details: {
      recentRequestFailures: requestFailures.slice(-12),
      parserFailures: parserFailures.slice(0, 12).map((item) => ({
        siteTitle: item.siteTitle,
        domain: item.domain,
        lastError: item.lastError,
        lastDiagnostics: item.lastDiagnostics
      })),
      antiBotSuppression: antiBotSuppression.slice(0, 12).map((item) => ({
        siteTitle: item.siteTitle,
        domain: item.domain,
        botBlockedRate: item.botBlockedRate,
        lastFailureCategory: item.lastFailureCategory
      })),
      replayInconsistencies: replayInconsistencies.slice(0, 12).map((report) => ({
        traceId: report.json.traceId,
        issues: report.json.integrity.issues
      })),
      extractionQualityFailures: extractionQualityFailures.slice(0, 12).map((item) => ({
        siteTitle: item.siteTitle,
        domain: item.domain,
        avgQualityScore: item.avgQualityScore
      })),
      browserMetrics: browserMetricsCollected ? browserMetrics : null
    }
  };
}

function renderRuntimeHealthReport(report) {
  const status = report.hasIssues ? "Needs attention" : report.complete ? "OK" : "Incomplete";
  const lines = [
    "Runtime Health Report",
    "=====================",
    `Status: ${status}`,
    "",
    `IPC failures: ${formatCount(report.summary.ipcFailures)}`,
    `Request failures: ${formatCount(report.summary.requestFailures)}`,
    `Parser failures: ${formatCount(report.summary.parserFailures)}`,
    `Browser cleanup failures: ${formatCount(report.summary.browserCleanupFailures)}`,
    `Anti-bot suppression entries: ${formatCount(report.summary.antiBotSuppression)}`,
    `Replay inconsistencies: ${formatCount(report.summary.replayInconsistencies)}`,
    `Extraction quality failures: ${formatCount(report.summary.extractionQualityFailures)}`
  ];

  if (report.details.recentRequestFailures.length) {
    lines.push("", "Recent request failures:");
    for (const item of report.details.recentRequestFailures) {
      lines.push(`- ${item.error || item.statusCode || "failed"} ${item.url || ""}`);
    }
  }

  if (report.details.parserFailures.length) {
    lines.push("", "Parser failures:");
    for (const item of report.details.parserFailures) {
      lines.push(`- ${item.domain || item.siteTitle}: ${item.lastError}`);
    }
  }

  if (report.details.antiBotSuppression.length) {
    lines.push("", "Anti-bot signals:");
    for (const item of report.details.antiBotSuppression) {
      lines.push(`- ${item.domain || item.siteTitle}: botBlockedRate=${formatRate(item.botBlockedRate)}`);
    }
  }

  if (report.details.extractionQualityFailures.length) {
    lines.push("", "Low extraction quality:");
    for (const item of report.details.extractionQualityFailures) {
      lines.push(`- ${item.domain || item.siteTitle}: avgQualityScore=${item.avgQualityScore}`);
    }
  }

  return lines.join("\n");
}

function formatCount(value) {
  return value === null || value === undefined ? "not collected" : String(value);
}

function formatRate(value) {
  return value === null || value === undefined ? "n/a" : `${Math.round(Number(value) * 100)}%`;
}

module.exports = {
  buildRuntimeHealthReport,
  renderRuntimeHealthReport
};
