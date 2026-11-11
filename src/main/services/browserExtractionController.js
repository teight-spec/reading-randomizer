const { createExtractionSession } = require("./extractionSession");
const { normalizeHttpUrl } = require("./inputValidation");
const { formatUrlForLog } = require("./requestGovernor");

const DEFAULT_TIMEOUT_MS = 18000;
const DEFAULT_MAX_CONCURRENT = 1;
let diagnosticRecorder = null;

class BrowserExtractionController {
  constructor({
    BrowserWindowImpl = null,
    createSession = createExtractionSession,
    attachDiagnostics,
    maxConcurrent = DEFAULT_MAX_CONCURRENT
  } = {}) {
    this.BrowserWindowImpl = BrowserWindowImpl || getElectronBrowserWindow();
    this.createSession = createSession;
    this.attachDiagnostics = attachDiagnostics === undefined ? getAttachDiagnostics() : attachDiagnostics;
    this.maxConcurrent = maxConcurrent;
    this.activeCount = 0;
    this.queue = [];
    this.metrics = {
      launched: 0,
      completed: 0,
      failed: 0,
      canceled: 0,
      cleanupFailures: 0,
      maxConcurrentObserved: 0
    };
  }

  async run({ url, label, traceId = null, timeoutMs = DEFAULT_TIMEOUT_MS, windowOptions = {}, onLoaded = null, worker }) {
    if (!this.BrowserWindowImpl) {
      throw new Error("BrowserWindow is unavailable in this runtime");
    }

    return this.enqueue(async () => {
      const startedAt = Date.now();
      const logUrl = formatUrlForLog(url);
      const extractionSession = this.createSession({ label, url });
      const win = new this.BrowserWindowImpl({
        show: false,
        width: 1280,
        height: 900,
        ...windowOptions,
        webPreferences: {
          session: extractionSession.session,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          images: false,
          plugins: false,
          backgroundThrottling: false,
          ...(windowOptions.webPreferences || {})
        }
      });
      win.__readerWindowLabel = label;
      secureHiddenExtractionWindow(win);
      this.metrics.launched += 1;
      this.metrics.maxConcurrentObserved = Math.max(this.metrics.maxConcurrentObserved, this.activeCount);
      if (this.attachDiagnostics) this.attachDiagnostics(win, label);

      try {
        await loadBestEffort(win, url, timeoutMs);
        if (onLoaded) await onLoaded(win, extractionSession);
        const result = await worker(win, extractionSession);
        this.metrics.completed += 1;
        logBrowserController("browser_extraction_complete", {
          traceId,
          label,
          url: logUrl,
          durationMs: Date.now() - startedAt,
          extractionNetwork: extractionSession.stats
        });
        return result;
      } catch (error) {
        this.metrics.failed += 1;
        logBrowserController("browser_extraction_failed", {
          traceId,
          label,
          url: logUrl,
          durationMs: Date.now() - startedAt,
          error: error.message
        });
        throw error;
      } finally {
        await this.cleanupWindow(win, extractionSession, { traceId, label, url: logUrl });
      }
    });
  }

  async enqueue(task) {
    if (this.activeCount >= this.maxConcurrent) {
      await new Promise((resolve) => this.queue.push(resolve));
    }
    this.activeCount += 1;
    try {
      return await task();
    } finally {
      this.activeCount -= 1;
      const next = this.queue.shift();
      if (next) next();
    }
  }

  async cleanupWindow(win, extractionSession, context) {
    try {
      if (isWindowUsable(win)) {
        win.webContents.stop();
      }
    } catch (error) {
      this.metrics.cleanupFailures += 1;
      logBrowserController("browser_extraction_stop_failed", {
        ...context,
        error: error.message
      });
    }
    await sleep(80);
    try {
      if (!win.isDestroyed()) {
        win.destroy();
      }
    } catch (error) {
      this.metrics.cleanupFailures += 1;
      logBrowserController("browser_extraction_destroy_failed", {
        ...context,
        error: error.message
      });
    }
    try {
      await extractionSession.cleanup();
    } catch (error) {
      this.metrics.cleanupFailures += 1;
      logBrowserController("browser_extraction_cleanup_failed", {
        ...context,
        error: error.message
      });
    }
  }

  getMetrics() {
    return {
      ...this.metrics,
      activeCount: this.activeCount,
      queued: this.queue.length
    };
  }
}

function loadBestEffort(win, url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(resolve), timeoutMs);

    function finish(callback, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupListeners();
      callback(value);
    }

    function onDomReady() {
      finish(resolve);
    }

    function onFinishLoad() {
      finish(resolve);
    }

    function onFailLoad(_event, code, description, failedUrl, isMainFrame) {
      if (isMainFrame) {
        finish(reject, new Error(`${description} (${code}) loading '${formatUrlForLog(failedUrl || url)}'`));
      }
    }

    function cleanupListeners() {
      try {
        win.webContents.removeListener("dom-ready", onDomReady);
        win.webContents.removeListener("did-finish-load", onFinishLoad);
        win.webContents.removeListener("did-fail-load", onFailLoad);
      } catch {
        // Best-effort listener cleanup only.
      }
    }

    win.webContents.once("dom-ready", onDomReady);
    win.webContents.once("did-finish-load", onFinishLoad);
    win.webContents.once("did-fail-load", onFailLoad);
    win.loadURL(url).catch((error) => finish(reject, error));
  });
}

function secureHiddenExtractionWindow(win) {
  const contents = win?.webContents;
  if (!contents) return;
  if (typeof contents.setWindowOpenHandler === "function") {
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
  }
  if (typeof contents.on !== "function") return;
  contents.on("will-navigate", (event, url) => {
    if (!isAllowedRemoteNavigation(url)) event.preventDefault();
  });
  contents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
}

function isAllowedRemoteNavigation(url) {
  try {
    normalizeHttpUrl(url, { label: "Navigation URL" });
    return true;
  } catch {
    return false;
  }
}

function isWindowUsable(win) {
  if (!win || win.isDestroyed?.()) return false;
  if (!win.webContents) return false;
  if (typeof win.webContents.isDestroyed === "function" && win.webContents.isDestroyed()) return false;
  return true;
}

function getElectronBrowserWindow() {
  try {
    return require("electron").BrowserWindow;
  } catch {
    return null;
  }
}

function getAttachDiagnostics() {
  try {
    return require("./networkDiagnostics").attachWindowDiagnostics;
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logBrowserController(event, payload) {
  console.info("[browser-extraction]", JSON.stringify({
    event,
    timestamp: Date.now(),
    payload
  }));
  diagnosticRecorder?.(event, payload);
}

function setBrowserDiagnosticRecorder(recorder) {
  diagnosticRecorder = typeof recorder === "function" ? recorder : null;
}

module.exports = {
  BrowserExtractionController,
  isAllowedRemoteNavigation,
  loadBestEffort,
  isWindowUsable,
  secureHiddenExtractionWindow,
  setBrowserDiagnosticRecorder
};
