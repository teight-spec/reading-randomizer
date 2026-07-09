const path = require("node:path");

const RECENT_LIMIT = 200;
const LOG_THROTTLE_MS = 5000;
const VERBOSE_HTTP_STATUS = process.env.READER_NET_DEBUG === "verbose";
const noisyErrors = new Map();
const logThrottle = new Map();

function installNetworkDiagnostics({ app, session, getWindows }) {
  const userDataPath = app.getPath("userData");
  const netLogPath = path.join(userDataPath, "network-debug-netlog.json");
  const enabledNetLog = process.env.READER_NETLOG === "1";

  if (enabledNetLog) {
    app.netLog.startLogging(netLogPath).catch((error) => {
      logNetworkEvent("netlog_start_failed", { error: error.message });
    });
    app.once("before-quit", () => {
      app.netLog.stopLogging().then((filePath) => {
        logNetworkEvent("netlog_saved", { filePath });
      }).catch(() => {});
    });
  }

  app.on("certificate-error", (event, webContents, url, error, certificate, callback) => {
    event.preventDefault();
    logNetworkEvent("certificate_error", {
      url,
      error,
      subjectName: certificate?.subjectName || "",
      issuerName: certificate?.issuerName || "",
      windowType: classifyWebContents(webContents, getWindows)
    });
    callback(false);
  });

  session.webRequest.onErrorOccurred((details) => {
    if (details.error === "net::ERR_BLOCKED_BY_CLIENT") return;
    const event = {
      url: details.url,
      error: details.error,
      method: details.method,
      resourceType: details.resourceType,
      id: details.id,
      fromCache: details.fromCache,
      windowType: classifyWebContentsById(details.webContentsId, getWindows),
      probableModule: inferModule(details.url, details.resourceType)
    };
    rememberNetworkError(event);
    logNetworkEvent("request_failed", event);
  });

  session.webRequest.onCompleted((details) => {
    if (details.statusCode >= 500 || (VERBOSE_HTTP_STATUS && details.statusCode >= 400)) {
      logNetworkEvent("request_completed_error_status", {
        url: details.url,
        statusCode: details.statusCode,
        method: details.method,
        resourceType: details.resourceType,
        windowType: classifyWebContentsById(details.webContentsId, getWindows),
        probableModule: inferModule(details.url, details.resourceType)
      });
    }
  });

  return {
    netLogPath,
    getRecentErrors: () => [...noisyErrors.values()].slice(-RECENT_LIMIT)
  };
}

function attachWindowDiagnostics(win, label) {
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame && errorDescription === "ERR_BLOCKED_BY_CLIENT") return;
    if (!isMainFrame && errorDescription === "ERR_UNSAFE_REDIRECT") return;
    logNetworkEvent("did_fail_load", {
      label,
      errorCode,
      errorDescription,
      url: validatedURL,
      isMainFrame
    });
  });
}

function rememberNetworkError(event) {
  const key = `${event.error}:${event.url}`;
  const previous = noisyErrors.get(key) || { ...event, count: 0, firstSeenAt: null };
  previous.count += 1;
  previous.lastSeenAt = new Date().toISOString();
  previous.firstSeenAt = previous.firstSeenAt || previous.lastSeenAt;
  noisyErrors.set(key, previous);
  if (noisyErrors.size > RECENT_LIMIT) {
    noisyErrors.delete(noisyErrors.keys().next().value);
  }
}

function logNetworkEvent(event, payload) {
  const throttleKey = `${event}:${payload?.error || payload?.statusCode || ""}:${payload?.url || ""}`;
  const now = Date.now();
  const previous = logThrottle.get(throttleKey);
  if (previous && now - previous.lastLoggedAt < LOG_THROTTLE_MS) {
    previous.suppressed = (previous.suppressed || 0) + 1;
    logThrottle.set(throttleKey, previous);
    return;
  }
  logThrottle.set(throttleKey, {
    lastLoggedAt: now,
    suppressed: previous?.suppressed || 0
  });
  console.info("[network]", JSON.stringify({
    event,
    timestamp: now,
    payload: previous?.suppressed ? { ...payload, suppressedRepeats: previous.suppressed } : payload
  }));
}

function classifyWebContents(webContents, getWindows) {
  if (!webContents) return "unknown";
  const windows = typeof getWindows === "function" ? getWindows() : [];
  const found = windows.find((win) => !win.isDestroyed() && win.webContents.id === webContents.id);
  if (found?.__readerWindowLabel) return found.__readerWindowLabel;
  return "hidden-or-external";
}

function classifyWebContentsById(id, getWindows) {
  const windows = typeof getWindows === "function" ? getWindows() : [];
  const found = windows.find((win) => !win.isDestroyed() && win.webContents.id === id);
  if (found?.__readerWindowLabel) return found.__readerWindowLabel;
  return id ? "hidden-or-external" : "session";
}

function inferModule(url = "", resourceType = "") {
  const host = safeHost(url);
  if (/google\.com$/.test(host) && /s2\/favicons/i.test(url)) return "renderer:favicon";
  if (/translate\.googleapis\.com/i.test(host) || /mymemory\.translated\.net/i.test(host) || /deepl\.com/i.test(host)) return "translator";
  if (/archive\./i.test(host) || /12ft\.io/i.test(host)) return "paywall-bypass";
  if (resourceType === "mainFrame") return "browser-window-load";
  if (["xmlhttprequest", "fetch"].includes(resourceType)) return "fetch-or-electron-net";
  return "chromium-or-page-resource";
}

function safeHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

module.exports = {
  installNetworkDiagnostics,
  attachWindowDiagnostics
};
