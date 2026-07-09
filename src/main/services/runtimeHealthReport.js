function buildRuntimeHealthReport({
  networkErrors = [],
  articleHealth = {},
  siteHealth = {},
  browserMetrics = {},
  replayReports = []
} = {}) {
  const ipcFailures = networkErrors.filter((event) => event.probableModule === "ipc" || event.channel);
  const requestFailures = networkErrors.filter((event) => event.error || event.statusCode >= 400);
  const parserFailures = Object.values(articleHealth).filter((item) => item.lastError);
  const cleanupFailures = Number(browserMetrics.cleanupFailures || 0);
  const antiBotSuppression = Object.values(siteHealth.sites || {}).filter((item) => Number(item.botBlockedRate || 0) > 0);
  const replayInconsistencies = replayReports.filter((report) => report?.json?.integrity && !report.json.integrity.ok);
  const extractionQualityFailures = Object.values(siteHealth.sites || {}).filter((item) => {
    return item.avgQualityScore !== null && item.avgQualityScore !== undefined && item.avgQualityScore < 0.52;
  });

  const summary = {
    ipcFailures: ipcFailures.length,
    requestFailures: requestFailures.length,
    parserFailures: parserFailures.length,
    browserCleanupFailures: cleanupFailures,
    antiBotSuppression: antiBotSuppression.length,
    replayInconsistencies: replayInconsistencies.length,
    extractionQualityFailures: extractionQualityFailures.length
  };

  return {
    summary,
    ok: Object.values(summary).every((value) => value === 0),
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
      browserMetrics
    }
  };
}

function renderRuntimeHealthReport(report) {
  const lines = [
    "Runtime Health Report",
    "=====================",
    `Status: ${report.ok ? "OK" : "Needs attention"}`,
    "",
    `IPC failures: ${report.summary.ipcFailures}`,
    `Request failures: ${report.summary.requestFailures}`,
    `Parser failures: ${report.summary.parserFailures}`,
    `Browser cleanup failures: ${report.summary.browserCleanupFailures}`,
    `Anti-bot suppression entries: ${report.summary.antiBotSuppression}`,
    `Replay inconsistencies: ${report.summary.replayInconsistencies}`,
    `Extraction quality failures: ${report.summary.extractionQualityFailures}`
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

function formatRate(value) {
  return value === null || value === undefined ? "n/a" : `${Math.round(Number(value) * 100)}%`;
}

module.exports = {
  buildRuntimeHealthReport,
  renderRuntimeHealthReport
};
