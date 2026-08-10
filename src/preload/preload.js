const { contextBridge, ipcRenderer } = require("electron");

const api = {
  getNextReading: () => ipcRenderer.invoke("reading:next"),
  readSite: (siteId) => ipcRenderer.invoke("reading:site", siteId),
  getHistory: () => ipcRenderer.invoke("reading:history"),
  saveReadingProgress: (payload) => ipcRenderer.invoke("reading:progress", payload),
  inspectArticle: (url) => ipcRenderer.invoke("article:inspect", url),
  extractReaderMode: (url) => ipcRenderer.invoke("article:readerMode", url),
  openExternalArticle: (url) => ipcRenderer.invoke("article:openExternal", url),
  translateText: (payload) => ipcRenderer.invoke("translate:text", payload),
  listSites: () => ipcRenderer.invoke("sites:list"),
  getSiteTree: () => ipcRenderer.invoke("sites:tree"),
  importChromeSites: () => ipcRenderer.invoke("sites:importChrome"),
  addSite: (payload) => ipcRenderer.invoke("sites:add", payload),
  updateSite: (siteId, patch) => ipcRenderer.invoke("sites:update", siteId, patch),
  deleteSite: (siteId) => ipcRenderer.invoke("sites:delete", siteId),
  addArticleSource: (siteId, payload) => ipcRenderer.invoke("sites:addArticleSource", siteId, payload),
  deleteArticleSource: (siteId, sourceUrl) => ipcRenderer.invoke("sites:deleteArticleSource", siteId, sourceUrl),
  listBypassSources: () => ipcRenderer.invoke("bypass:list"),
  addBypassSource: (payload) => ipcRenderer.invoke("bypass:add", payload),
  updateBypassSource: (sourceId, patch) => ipcRenderer.invoke("bypass:update", sourceId, patch),
  deleteBypassSource: (sourceId) => ipcRenderer.invoke("bypass:delete", sourceId),
  openVerificationWindow: (url) => ipcRenderer.invoke("bypass:verificationWindow", url),
  getNetworkRecentErrors: () => ipcRenderer.invoke("network:recentErrors"),
  getCacheUsage: () => ipcRenderer.invoke("maintenance:cacheUsage"),
  clearBrowserCache: () => ipcRenderer.invoke("maintenance:clearBrowserCache"),
  listKnowledge: (filters) => ipcRenderer.invoke("knowledge:list", filters),
  getKnowledgeArticle: (articleId) => ipcRenderer.invoke("knowledge:get", articleId),
  listKnowledgeCategories: () => ipcRenderer.invoke("knowledge:categories"),
  getKnowledgeStats: () => ipcRenderer.invoke("knowledge:stats"),
  updateKnowledgeArticle: (articleId, patch) => ipcRenderer.invoke("knowledge:update", articleId, patch),
  retryKnowledgeAnalysis: (articleId) => ipcRenderer.invoke("knowledge:retry", articleId),
  getKnowledgeSettings: () => ipcRenderer.invoke("knowledge:settings"),
  saveGroqApiKey: (apiKey) => ipcRenderer.invoke("knowledge:saveApiKey", apiKey),
  reportRendererError: (payload) => ipcRenderer.invoke("renderer:error", payload)
};

contextBridge.exposeInMainWorld("readerApi", api);
contextBridge.exposeInMainWorld("electronAPI", {
  translate: (payload) => ipcRenderer.invoke("translate:text", payload)
});
