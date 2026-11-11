const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, ipcMain, safeStorage, session, shell } = require("electron");
const { HistoryStore } = require("./services/historyStore");
const { inspectArticle } = require("./services/articlePicker");
const { Translator } = require("./services/translator");
const { SiteStore } = require("./services/siteStore");
const { BypassRegistry } = require("./services/bypassRegistry");
const { extractReaderArticle } = require("./services/readerMode");
const { installRequestBlocker } = require("./services/requestBlocker");
const { ArticlePrefetcher } = require("./services/articlePrefetcher");
const { ArticleCache } = require("./services/articleCache");
const { TranslationStore } = require("./services/translationStore");
const { installNetworkDiagnostics, attachWindowDiagnostics } = require("./services/networkDiagnostics");
const { SiteHealthStore } = require("./services/siteHealthStore");
const { clearBrowserCaches, getCacheUsage } = require("./services/maintenance");
const { KnowledgeDatabase } = require("./services/knowledgeDatabase");
const { SecureSettingsStore } = require("./services/secureSettingsStore");
const { GroqAnalyzer } = require("./services/groqAnalyzer");
const { KnowledgeAnalysisQueue } = require("./services/knowledgeAnalysisQueue");
const { RuntimeDiagnosticsStore } = require("./services/runtimeDiagnosticsStore");
const { setBrowserDiagnosticRecorder } = require("./services/browserExtractionController");
const {
  boundedId,
  boundedString,
  normalizeHttpUrl,
  positiveInteger,
  validateArticleSourcePayload,
  validateBypassPatch,
  validateBypassSource,
  validateKnowledgeFilters,
  validateKnowledgePatch,
  validateOnboardingSelection,
  validateReadingProgress,
  validateRendererError,
  validateShelfItem,
  validateSitePatch,
  validateSitePayload,
  validateTranslationPayload
} = require("./services/inputValidation");

const DENIED_VERIFICATION_PERMISSIONS = new Set([
  "media",
  "mediaKeySystem",
  "geolocation",
  "notifications",
  "midi",
  "midiSysex",
  "pointerLock",
  "fullscreen",
  "openExternal",
  "idle-detection",
  "display-capture",
  "clipboard-read",
  "serial",
  "hid",
  "usb",
  "bluetooth",
  "fileSystem"
]);
const verificationWebContentsIds = new Set();
let verificationPermissionGuardInstalled = false;

let mainWindow;
let historyStore;
let translator;
let siteStore;
let bypassRegistry;
let articlePrefetcher;
let articleCache;
let translationStore;
let networkDiagnostics;
let siteHealthStore;
let knowledgeDatabase;
let secureSettingsStore;
let knowledgeAnalysisQueue;
let runtimeDiagnosticsStore;

app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-component-update");
app.commandLine.appendSwitch("disable-domain-reliability");
app.commandLine.appendSwitch("disable-features", "AutofillServerCommunication,OptimizationHints,MediaRouter");
app.commandLine.appendSwitch("disable-renderer-backgrounding");

process.on("uncaughtException", (error) => {
  logRuntime("main_uncaught_exception", {
    error: serializeError(error)
  });
});

process.on("unhandledRejection", (reason) => {
  logRuntime("main_unhandled_rejection", {
    error: serializeError(reason)
  });
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    title: "Reading Randomizer",
    icon: path.join(__dirname, "../../assets/app-icon.icns"),
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.__readerWindowLabel = "main";
  attachWindowDiagnostics(mainWindow, "main");
  attachRendererLifecycleDiagnostics(mainWindow, "main");
  secureMainWindow(mainWindow);

  mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
}

app.whenReady().then(() => {
  runtimeDiagnosticsStore = new RuntimeDiagnosticsStore(app.getPath("userData"));
  runtimeDiagnosticsStore.record("runtime_monitoring_started", {
    appVersion: app.getVersion(),
    platform: process.platform
  }).catch(() => {});
  setBrowserDiagnosticRecorder((event, payload) => {
    if (/failed|cleanup/.test(event)) runtimeDiagnosticsStore.record(event, payload).catch(() => {});
  });
  historyStore = new HistoryStore(app.getPath("userData"));
  siteStore = new SiteStore(app.getPath("userData"));
  bypassRegistry = new BypassRegistry(app.getPath("userData"));
  articleCache = new ArticleCache(app.getPath("userData"));
  translationStore = new TranslationStore(app.getPath("userData"));
  siteHealthStore = new SiteHealthStore(app.getPath("userData"));
  knowledgeDatabase = new KnowledgeDatabase(app.getPath("userData"));
  secureSettingsStore = new SecureSettingsStore(app.getPath("userData"), { safeStorage });
  knowledgeAnalysisQueue = new KnowledgeAnalysisQueue({
    database: knowledgeDatabase,
    settingsStore: secureSettingsStore,
    analyzer: new GroqAnalyzer({ settingsStore: secureSettingsStore })
  });
  translator = new Translator({ translationStore });
  articlePrefetcher = new ArticlePrefetcher({
    siteStore,
    historyStore,
    articleCache,
    extractReaderArticle,
    siteHealthStore
  });
  installRequestBlocker(session.defaultSession);
  networkDiagnostics = installNetworkDiagnostics({
    app,
    session: session.defaultSession,
    getWindows: BrowserWindow.getAllWindows,
    recordDiagnostic: (event, payload) => {
      runtimeDiagnosticsStore.record(event, payload).catch(() => {});
    }
  });
  registerIpcHandlers();
  articlePrefetcher.start();
  knowledgeAnalysisQueue.start();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  knowledgeAnalysisQueue?.stop();
  knowledgeDatabase?.close();
});

function registerIpcHandlers() {
  handleIpc("reading:next", async () => {
    return articlePrefetcher.consume();
  });

  handleIpc("reading:site", async (_event, siteId) => {
    const site = await siteStore.getSite(boundedId(siteId, "Site ID"));
    return articlePrefetcher.prepareForSite(site);
  });

  handleIpc("reading:progress", async (_event, payload) => {
    const progress = validateReadingProgress(payload);
    const cachedItem = await articleCache.getArticle(progress.articleUrl);
    const result = knowledgeDatabase.recordProgress(progress, cachedItem);
    if (result.newlyCompleted || result.analysisQueued) knowledgeAnalysisQueue.wake();
    return result;
  });

  handleIpc("reading:saveLater", async (_event, payload) => {
    return knowledgeDatabase.saveForLater(validateShelfItem(payload));
  });

  handleIpc("reading:restoreLater", async (_event, payload) => {
    return knowledgeDatabase.restoreReadLater(validateShelfItem(payload));
  });

  handleIpc("reading:removeShelf", async (_event, kind, url) => {
    const safeKind = kind === "recent" ? "recent" : "later";
    return knowledgeDatabase.removeFromShelf(
      safeKind,
      normalizeHttpUrl(url, { label: "Article URL" })
    );
  });

  handleIpc("reading:listShelf", async () => {
    return {
      later: knowledgeDatabase.listShelf("later", 200),
      recent: knowledgeDatabase.listShelf("recent", 50)
    };
  });

  handleIpc("reading:touchRecent", async (_event, payload) => {
    knowledgeDatabase.touchRecent(validateShelfItem(payload));
    return true;
  });

  handleIpc("reading:resumeOffer", async () => {
    return knowledgeDatabase.getResumeOffer();
  });

  handleIpc("reading:openSaved", async (_event, url) => {
    const articleUrl = normalizeHttpUrl(url, { label: "Article URL" });
    const shelfItem = knowledgeDatabase.findShelfArticle(articleUrl);
    const position = knowledgeDatabase.getReadingPosition(articleUrl);
    const cached = await articleCache.getArticle(articleUrl);
    let readerArticle = cached?.readerArticle || null;
    let readerError = null;
    if (!readerArticle) {
      try {
        readerArticle = await extractReaderArticle(articleUrl);
      } catch (error) {
        readerError = error.message;
      }
    }
    const site = cached?.site || {
      id: shelfItem?.siteId || "",
      title: shelfItem?.siteTitle || shelfItem?.siteDomain || "已保存的文章",
      domain: shelfItem?.siteDomain || "",
      url: articleUrl
    };
    const article = {
      ...(cached?.article || {}),
      title: readerArticle?.title || shelfItem?.articleTitle || cached?.article?.title || articleUrl,
      url: articleUrl,
      source: cached?.article?.source || "saved"
    };
    if (readerArticle) {
      knowledgeDatabase.touchRecent({
        articleUrl,
        articleTitle: article.title,
        siteId: site.id || "",
        siteTitle: site.title || "",
        siteDomain: site.domain || "",
        progressPercent: position?.progressPercent || shelfItem?.progressPercent || 0,
        anchor: position?.anchor || shelfItem?.anchor || null
      });
    }
    return {
      site,
      article,
      readerArticle,
      readerError,
      resume: position,
      unavailable: !readerArticle
    };
  });

  handleIpc("knowledge:list", async (_event, filters) => {
    return knowledgeDatabase.listArticles(validateKnowledgeFilters(filters));
  });

  handleIpc("knowledge:get", async (_event, articleId) => {
    return knowledgeDatabase.getArticle(positiveInteger(articleId, "Article ID"));
  });

  handleIpc("knowledge:categories", async () => {
    return knowledgeDatabase.listCategories();
  });

  handleIpc("knowledge:stats", async () => {
    return knowledgeDatabase.getStats();
  });

  handleIpc("knowledge:update", async (_event, articleId, patch) => {
    return knowledgeDatabase.updateMetadata(
      positiveInteger(articleId, "Article ID"),
      validateKnowledgePatch(patch)
    );
  });

  handleIpc("knowledge:retry", async (_event, articleId) => {
    const result = knowledgeDatabase.retryArticle(positiveInteger(articleId, "Article ID"));
    knowledgeAnalysisQueue.wake();
    return result;
  });

  handleIpc("knowledge:settings", async () => {
    return secureSettingsStore.getPublicSettings();
  });

  handleIpc("knowledge:saveApiKey", async (_event, apiKey) => {
    const settings = await secureSettingsStore.saveGroqApiKey(
      boundedString(apiKey, { label: "Groq API key", maxLength: 512 })
    );
    knowledgeAnalysisQueue.wake();
    return settings;
  });

  handleIpc("privacy:saveTranslationConsent", async (_event, enabled) => {
    if (typeof enabled !== "boolean") throw new Error("Translation consent must be a boolean");
    return secureSettingsStore.saveTranslationConsent(enabled);
  });

  handleIpc("settings:saveReaderPreferences", async (_event, patch) => {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new Error("Reader preferences must be an object");
    }
    return secureSettingsStore.saveReaderPreferences({
      fontSize: Number(patch.fontSize),
      width: Number(patch.width)
    });
  });

  handleIpc("article:inspect", async (_event, url) => {
    const articleUrl = normalizeHttpUrl(url, { label: "Article URL" });
    const result = await inspectArticle(articleUrl);
    const bypassUrls = await bypassRegistry.getBypassUrls(articleUrl);
    return {
      ...result,
      bypassUrls
    };
  });

  handleIpc("article:readerMode", async (_event, url) => {
    return extractReaderArticle(normalizeHttpUrl(url, { label: "Article URL" }));
  });

  handleIpc("article:openExternal", async (_event, url) => {
    await shell.openExternal(normalizeHttpUrl(url, { label: "External URL" }));
    return true;
  });

  handleIpc("translate:text", async (_event, payload) => {
    const settings = await secureSettingsStore.getPublicSettings();
    if (!settings.translationConsent) {
      throw new Error("Remote translation has not been enabled by the user");
    }
    return translator.translate(validateTranslationPayload(payload));
  });

  handleIpc("sites:list", async () => {
    return siteStore.listSites();
  });

  handleIpc("sites:tree", async () => {
    return siteStore.getTree();
  });

  handleIpc("sites:health", async () => {
    return siteHealthStore.load();
  });

  handleIpc("onboarding:state", async () => {
    const state = await siteStore.getOnboardingState();
    const folders = await siteStore.listBookmarkFolders();
    return {
      ...state,
      chromeAvailable: folders.available === true,
      chromeMessage: folders.message || "",
      folders: publicFolderTree(folders.folders || [])
    };
  });

  handleIpc("onboarding:apply", async (_event, payload) => {
    const selection = validateOnboardingSelection(payload);
    const result = await siteStore.applyOnboardingSelection(selection);
    articlePrefetcher.invalidate();
    return result;
  });

  handleIpc("onboarding:complete", async () => {
    return siteStore.completeOnboarding();
  });

  handleIpc("sites:importChrome", async (_event, payload) => {
    const selection = validateOnboardingSelection(payload);
    const result = await siteStore.applyOnboardingSelection({
      ...selection,
      completeOnboarding: true
    });
    articlePrefetcher.invalidate();
    return result;
  });

  handleIpc("sites:add", async (_event, payload) => {
    return siteStore.addSite(validateSitePayload(payload));
  });

  handleIpc("sites:update", async (_event, siteId, patch) => {
    return siteStore.updateSite(boundedId(siteId, "Site ID"), validateSitePatch(patch));
  });

  handleIpc("sites:delete", async (_event, siteId) => {
    return siteStore.deleteSite(boundedId(siteId, "Site ID"));
  });

  handleIpc("sites:addArticleSource", async (_event, siteId, payload) => {
    return siteStore.addArticleSource(
      boundedId(siteId, "Site ID"),
      validateArticleSourcePayload(payload)
    );
  });

  handleIpc("sites:deleteArticleSource", async (_event, siteId, sourceUrl) => {
    return siteStore.deleteArticleSource(
      boundedId(siteId, "Site ID"),
      normalizeHttpUrl(sourceUrl, { label: "Article source URL" })
    );
  });

  handleIpc("bypass:list", async () => {
    return bypassRegistry.listSources();
  });

  handleIpc("bypass:add", async (_event, payload) => {
    return bypassRegistry.addSource(validateBypassSource(payload));
  });

  handleIpc("bypass:update", async (_event, sourceId, patch) => {
    return bypassRegistry.updateSource(
      boundedId(sourceId, "Bypass source ID"),
      validateBypassPatch(patch)
    );
  });

  handleIpc("bypass:delete", async (_event, sourceId) => {
    return bypassRegistry.deleteSource(boundedId(sourceId, "Bypass source ID"));
  });

  handleIpc("bypass:verificationWindow", async (_event, url) => {
    const verificationUrl = normalizeHttpUrl(url, { label: "Verification URL" });
    const verifyWindow = new BrowserWindow({
      width: 1040,
      height: 760,
      title: "Manual verification",
      webPreferences: {
        session: session.defaultSession,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    verifyWindow.__readerWindowLabel = "verification";
    attachWindowDiagnostics(verifyWindow, "verification");
    attachRendererLifecycleDiagnostics(verifyWindow, "verification");
    secureRemoteWindow(verifyWindow);
    installVerificationGuards(verifyWindow);
    await verifyWindow.loadURL(verificationUrl);
    return true;
  });

  handleIpc("network:recentErrors", async () => {
    return networkDiagnostics?.getRecentErrors() || [];
  });

  handleIpc("maintenance:cacheUsage", async () => {
    return getCacheUsage(app.getPath("userData"));
  });

  handleIpc("maintenance:clearBrowserCache", async () => {
    return clearBrowserCaches({
      userDataPath: app.getPath("userData"),
      session: session.defaultSession
    });
  });

  handleIpc("renderer:error", async (_event, payload) => {
    logRuntime("renderer_reported_error", validateRendererError(payload));
    return true;
  });
}

function handleIpc(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    const startedAt = Date.now();
    const senderId = event?.sender?.id || null;
    logRuntime("ipc_start", {
      channel,
      senderId
    });
    try {
      assertTrustedIpcSender(event);
      const result = await handler(event, ...args);
      logRuntime("ipc_success", {
        channel,
        senderId,
        durationMs: Date.now() - startedAt
      });
      return result;
    } catch (error) {
      logRuntime("ipc_failed", {
        channel,
        senderId,
        durationMs: Date.now() - startedAt,
        error: serializeError(error)
      });
      throw error;
    }
  });
}

function secureMainWindow(win) {
  const rendererUrl = pathToFileURL(path.join(__dirname, "../renderer/index.html")).toString();
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (url === rendererUrl) return;
    event.preventDefault();
    openExternalSafely(url);
  });
  win.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
}

function installVerificationGuards(win) {
  const webContentsId = win.webContents.id;
  verificationWebContentsIds.add(webContentsId);
  win.on("closed", () => verificationWebContentsIds.delete(webContentsId));
  if (!verificationPermissionGuardInstalled) {
    verificationPermissionGuardInstalled = true;
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      if (!verificationWebContentsIds.has(webContents?.id)) {
        callback(true);
        return;
      }
      callback(!DENIED_VERIFICATION_PERMISSIONS.has(permission));
    });
  }
  win.webContents.on("will-redirect", (event, url) => {
    guardRemoteNavigation(event, url);
  });
  win.webContents.on("will-frame-navigate", (event, url) => {
    guardRemoteNavigation(event, url);
  });
}

function guardRemoteNavigation(event, url) {
  try {
    normalizeHttpUrl(url, { label: "Navigation URL" });
  } catch {
    event.preventDefault();
  }
}

function publicFolderTree(folders) {
  return (folders || []).map((folder) => ({
    name: folder.name,
    path: folder.path,
    urlCount: folder.urlCount,
    children: publicFolderTree(folder.children)
  }));
}

function secureRemoteWindow(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    try {
      normalizeHttpUrl(url, { label: "Navigation URL" });
    } catch {
      event.preventDefault();
    }
  });
  win.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
}

function openExternalSafely(url) {
  try {
    const externalUrl = normalizeHttpUrl(url, { label: "External URL" });
    shell.openExternal(externalUrl).catch((error) => {
      logRuntime("external_open_failed", { url: redactUrlForLog(externalUrl), error: serializeError(error) });
    });
  } catch {
    // Ignore non-HTTP navigation attempts.
  }
}

function assertTrustedIpcSender(event) {
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error("Main window is unavailable");
  if (event?.sender?.id !== mainWindow.webContents.id) throw new Error("Untrusted IPC sender");
  const senderUrl = event.senderFrame?.url || event.sender?.getURL?.() || "";
  const rendererUrl = pathToFileURL(path.join(__dirname, "../renderer/index.html")).toString();
  if (senderUrl !== rendererUrl) throw new Error("Untrusted IPC origin");
}

function redactUrlForLog(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "[invalid-url]";
  }
}

function attachRendererLifecycleDiagnostics(win, label) {
  win.webContents.on("render-process-gone", (_event, details) => {
    logRuntime("renderer_process_gone", { label, details });
  });
  win.webContents.on("unresponsive", () => {
    logRuntime("renderer_unresponsive", { label });
  });
  win.webContents.on("responsive", () => {
    logRuntime("renderer_responsive", { label });
  });
  win.webContents.on("console-message", (event) => {
    const level = event.level;
    const message = event.message;
    const line = event.lineNumber;
    const sourceId = event.sourceId;
    if (!isConsoleWarningOrError(level)) return;
    logRuntime("renderer_console_error", {
      label,
      level,
      message,
      line,
      sourceId
    });
  });
}

function isConsoleWarningOrError(level) {
  if (typeof level === "number") return level >= 2;
  return ["warning", "error"].includes(String(level).toLowerCase());
}

function serializeError(error) {
  if (!error || typeof error !== "object") {
    return {
      name: "Error",
      message: String(error)
    };
  }
  return {
    name: error.name || "Error",
    message: error.message || String(error),
    code: error.code || null,
    stack: error.stack || null
  };
}

function logRuntime(event, payload = {}) {
  console.info("[runtime]", JSON.stringify({
    event,
    timestamp: Date.now(),
    payload
  }));
  if (shouldPersistRuntimeEvent(event)) {
    runtimeDiagnosticsStore?.record(event, payload).catch(() => {});
  }
}

function shouldPersistRuntimeEvent(event) {
  return /failed|error|exception|rejection|unresponsive|process_gone|renderer_reported_error/.test(String(event));
}
