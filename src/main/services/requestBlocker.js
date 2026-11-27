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
    callback({ cancel: shouldCancelRequest(details) });
  });
}

// Tracker and ad hosts are cancelled for every resource type, including the
// heavy types below. Image, media, and font requests are cancelled only when
// the host itself is on that list. Resource type is never an independent
// reason to cancel, so article images in the reader stay available.
function shouldCancelRequest(details = {}) {
  const host = safeHost(details.url);
  const blockedByHost = Boolean(host) && BLOCKED_HOST_PATTERNS.some((pattern) => host.includes(pattern));
  if (!blockedByHost) return false;
  const heavyResourceOnTracker = BLOCKED_RESOURCE_TYPES.has(details.resourceType);
  return heavyResourceOnTracker || blockedByHost;
}

function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

module.exports = {
  BLOCKED_RESOURCE_TYPES,
  installRequestBlocker,
  shouldCancelRequest
};
