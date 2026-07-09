const BLOCKED_HOST_PATTERNS = [
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
  "optimizely.com"
];

const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font"]);

function installRequestBlocker(session) {
  session.webRequest.onBeforeRequest((details, callback) => {
    const host = safeHost(details.url);
    const blockedByHost = BLOCKED_HOST_PATTERNS.some((pattern) => host.includes(pattern));
    const blockedByType = BLOCKED_RESOURCE_TYPES.has(details.resourceType) && blockedByHost;
    callback({ cancel: blockedByHost || blockedByType });
  });
}

function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

module.exports = {
  installRequestBlocker
};
