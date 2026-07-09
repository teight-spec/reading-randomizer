const { session } = require("electron");

const BLOCKED_RESOURCE_TYPES = new Set([
  "image",
  "media",
  "font",
  "stylesheet",
  "subFrame",
  "object",
  "ping",
  "cspReport"
]);

const TRACKING_HOST_PATTERNS = [
  "doubleclick.net",
  "googlesyndication.com",
  "google-analytics.com",
  "googletagmanager.com",
  "adservice.google.",
  "facebook.net",
  "connect.facebook.net",
  "scorecardresearch.com",
  "taboola.com",
  "outbrain.com",
  "adsystem.com",
  "adnxs.com",
  "criteo.com",
  "quantserve.com",
  "hotjar.com",
  "segment.io",
  "optimizely.com",
  "chartbeat.com",
  "newrelic.com",
  "sentry.io",
  "datadoghq",
  "adsrvr.org"
];

const BROKEN_OR_INTERNAL_HOSTS = new Set([
  "humstaging"
]);

function createExtractionSession({ label, url }) {
  const partition = `reader-extraction-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const isolatedSession = session.fromPartition(partition);
  const rootHost = safeHost(url);
  const stats = {
    label,
    rootHost,
    blocked: 0,
    allowed: 0,
    blockedByType: {},
    blockedByHost: {},
    blockedSamples: []
  };

  isolatedSession.webRequest.onBeforeRequest((details, callback) => {
    const decision = shouldBlockRequest(details, rootHost);
    if (decision.blocked) {
      stats.blocked += 1;
      stats.blockedByType[details.resourceType] = (stats.blockedByType[details.resourceType] || 0) + 1;
      stats.blockedByHost[decision.host] = (stats.blockedByHost[decision.host] || 0) + 1;
      if (stats.blockedSamples.length < 12) {
        stats.blockedSamples.push({
          url: details.url,
          resourceType: details.resourceType,
          reason: decision.reason
        });
      }
      if (details.resourceType === "subFrame") {
        callback({ redirectURL: "about:blank" });
        return;
      }
      callback({ cancel: true });
      return;
    }

    stats.allowed += 1;
    callback({});
  });

  isolatedSession.webRequest.onErrorOccurred((details) => {
    if (details.error === "net::ERR_BLOCKED_BY_CLIENT") return;
    if (details.error === "net::ERR_ABORTED") return;
    logExtractionNetwork("request_failed", {
      label,
      url: details.url,
      error: details.error,
      resourceType: details.resourceType
    });
  });

  return {
    session: isolatedSession,
    stats,
    async cleanup() {
      try {
        if (typeof isolatedSession.closeAllConnections === "function") {
          await isolatedSession.closeAllConnections();
        }
      } catch {
        // Best-effort socket cleanup.
      }
      try {
        await isolatedSession.clearCache();
      } catch {
        // Best-effort cache cleanup.
      }
      logExtractionNetwork("session_summary", stats);
    }
  };
}

function shouldBlockRequest(details, rootHost) {
  const host = safeHost(details.url);
  const resourceType = details.resourceType;

  if (BROKEN_OR_INTERNAL_HOSTS.has(host)) {
    return { blocked: true, host, reason: "broken-or-internal-host" };
  }

  if (BLOCKED_RESOURCE_TYPES.has(resourceType)) {
    return { blocked: true, host, reason: `resource-type:${resourceType}` };
  }

  if (TRACKING_HOST_PATTERNS.some((pattern) => host.includes(pattern))) {
    return { blocked: true, host, reason: "tracking-or-ad-host" };
  }

  if (resourceType === "script" && rootHost && host && !sameSite(host, rootHost)) {
    return { blocked: true, host, reason: "third-party-script" };
  }

  return { blocked: false, host, reason: "" };
}

function sameSite(host, rootHost) {
  if (host === rootHost) return true;
  return host.endsWith(`.${rootHost}`) || rootHost.endsWith(`.${host}`);
}

function safeHost(url = "") {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function logExtractionNetwork(event, payload) {
  console.info("[extraction-network]", JSON.stringify({
    event,
    timestamp: Date.now(),
    payload
  }));
}

module.exports = {
  createExtractionSession
};
