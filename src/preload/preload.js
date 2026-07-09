const { contextBridge, ipcRenderer } = require("electron");

const api = {
  getNextReading: () => ipcRenderer.invoke("reading:next"),
  readSite: (siteId) => ipcRenderer.invoke("reading:site", siteId),
  markRead: (site, article) => ipcRenderer.invoke("reading:markRead", { site, article }),
  getHistory: () => ipcRenderer.invoke("reading:history"),
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
  reportRendererError: (payload) => ipcRenderer.invoke("renderer:error", payload)
};

contextBridge.exposeInMainWorld("readerApi", api);
contextBridge.exposeInMainWorld("electronAPI", {
  translate: (payload) => ipcRenderer.invoke("translate:text", payload)
});
