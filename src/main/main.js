const path = require("node:path");
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
      nodeIntegration: false
    }
  });
  mainWindow.__readerWindowLabel = "main";
  attachWindowDiagnostics(mainWindow, "main");
  attachRendererLifecycleDiagnostics(mainWindow, "main");

  mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
}

app.whenReady().then(() => {
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
    getWindows: BrowserWindow.getAllWindows
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
    const site = await siteStore.getSite(siteId);
    return articlePrefetcher.prepareForSite(site);
  });

  handleIpc("reading:history", async () => {
    return historyStore.load();
  });

  handleIpc("reading:progress", async (_event, payload) => {
    const cachedItem = await articleCache.getArticle(payload?.articleUrl);
    const result = knowledgeDatabase.recordProgress(payload, cachedItem);
    if (result.newlyCompleted || result.analysisQueued) knowledgeAnalysisQueue.wake();
    return result;
  });

  handleIpc("knowledge:list", async (_event, filters) => {
    return knowledgeDatabase.listArticles(filters || {});
  });

  handleIpc("knowledge:get", async (_event, articleId) => {
    return knowledgeDatabase.getArticle(Number(articleId));
  });

  handleIpc("knowledge:categories", async () => {
    return knowledgeDatabase.listCategories();
  });

  handleIpc("knowledge:stats", async () => {
    return knowledgeDatabase.getStats();
  });

  handleIpc("knowledge:update", async (_event, articleId, patch) => {
    return knowledgeDatabase.updateMetadata(Number(articleId), patch || {});
  });

  handleIpc("knowledge:retry", async (_event, articleId) => {
    const result = knowledgeDatabase.retryArticle(Number(articleId));
    knowledgeAnalysisQueue.wake();
    return result;
  });

  handleIpc("knowledge:settings", async () => {
    return secureSettingsStore.getPublicSettings();
  });

  handleIpc("knowledge:saveApiKey", async (_event, apiKey) => {
    const settings = await secureSettingsStore.saveGroqApiKey(apiKey);
    knowledgeAnalysisQueue.wake();
    return settings;
  });

  handleIpc("article:inspect", async (_event, url) => {
    const result = await inspectArticle(url);
    const bypassUrls = await bypassRegistry.getBypassUrls(url);
    return {
      ...result,
      bypassUrls
    };
  });

  handleIpc("article:readerMode", async (_event, url) => {
    return extractReaderArticle(url);
  });

  handleIpc("article:openExternal", async (_event, url) => {
    assertExternalUrl(url);
    await shell.openExternal(url);
    return true;
  });

  handleIpc("translate:text", async (_event, payload) => {
    return translator.translate(payload);
  });

  handleIpc("translate", async (_event, payload) => {
    return translator.translate(payload);
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

  handleIpc("sites:importChrome", async () => {
    return siteStore.importChromeBookmarks();
  });

  handleIpc("sites:add", async (_event, payload) => {
    return siteStore.addSite(payload);
  });

  handleIpc("sites:update", async (_event, siteId, patch) => {
    return siteStore.updateSite(siteId, patch);
  });

  handleIpc("sites:delete", async (_event, siteId) => {
    return siteStore.deleteSite(siteId);
  });

  handleIpc("sites:addArticleSource", async (_event, siteId, payload) => {
    return siteStore.addArticleSource(siteId, payload);
  });

  handleIpc("sites:deleteArticleSource", async (_event, siteId, sourceUrl) => {
    return siteStore.deleteArticleSource(siteId, sourceUrl);
  });

  handleIpc("bypass:list", async () => {
    return bypassRegistry.listSources();
  });

  handleIpc("bypass:add", async (_event, payload) => {
    return bypassRegistry.addSource(payload);
  });

  handleIpc("bypass:update", async (_event, sourceId, patch) => {
    return bypassRegistry.updateSource(sourceId, patch);
  });

  handleIpc("bypass:delete", async (_event, sourceId) => {
    return bypassRegistry.deleteSource(sourceId);
  });

  handleIpc("bypass:verificationWindow", async (_event, url) => {
    assertExternalUrl(url);
    const verifyWindow = new BrowserWindow({
      width: 1040,
      height: 760,
      title: "Manual verification",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    verifyWindow.__readerWindowLabel = "verification";
    attachWindowDiagnostics(verifyWindow, "verification");
    attachRendererLifecycleDiagnostics(verifyWindow, "verification");
    await verifyWindow.loadURL(url);
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
    logRuntime("renderer_reported_error", payload || {});
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

function assertExternalUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Unsupported external URL protocol: ${parsed.protocol}`);
  }
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
}
