const { looksLikeArticleUrl } = require("./articlePicker");
const { BrowserExtractionController, isWindowUsable } = require("./browserExtractionController");

const BROWSER_DISCOVERY_TIMEOUT_MS = 18000;
const browserController = new BrowserExtractionController({
  maxConcurrent: 1
});

async function discoverArticlesWithBrowser(site, limit = 12, context = {}) {
  const pages = getDiscoveryPages(site);
  const articles = [];

  for (const pageUrl of pages) {
    try {
      logBrowserDiscovery("browser_stage_start", {
        traceId: context.traceId || null,
        strategySource: context.strategySource || "browser-fallback",
        fallbackReason: context.fallbackReason || null,
        pageUrl
      });
      const pageArticles = await discoverFromPage(site, pageUrl, limit - articles.length, context);
      articles.push(...pageArticles);
    } catch (error) {
      logBrowserDiscovery("browser_stage_failed", {
        traceId: context.traceId || null,
        strategySource: context.strategySource || "browser-fallback",
        pageUrl,
        error: error.message
      });
      // Keep trying other likely index pages. A single dynamic route can fail while others work.
    }
    if (articles.length >= limit) break;
  }

  return dedupe(articles).slice(0, limit);
}

async function discoverFromPage(site, pageUrl, limit, context = {}) {
  return browserController.run({
    url: pageUrl,
    label: `browser-discovery:${site.domain || host(site.url)}`,
    traceId: context.traceId || null,
    timeoutMs: BROWSER_DISCOVERY_TIMEOUT_MS,
    onLoaded: async () => {
      await new Promise((resolve) => setTimeout(resolve, getSettleDelay(site)));
    },
    worker: async (win) => {
      const links = await safeExecuteJavaScript(win, `
        Array.from(document.querySelectorAll("a[href]"))
          .map((anchor) => ({
            title: (anchor.innerText || anchor.getAttribute("aria-label") || anchor.getAttribute("title") || "").replace(/\\s+/g, " ").trim(),
            url: anchor.href
          }))
          .filter((item) => item.url && item.title.length > 8)
          .slice(0, 300)
      `);

      return links
        .filter((item) => sameHostname(site.url, item.url))
        .filter((item) => looksLikeArticleUrl(item.url))
        .slice(0, limit)
        .map((item) => ({
          title: item.title,
          url: item.url,
          publishedAt: null,
          source: `browser-index:${pageUrl}`,
          traceId: context.traceId || null
        }));
    }
  });
}

function safeExecuteJavaScript(win, script) {
  if (!isWindowUsable(win)) {
    const error = new Error("browser discovery window is no longer available");
    error.failureCategory = "browser_lifecycle";
    throw error;
  }
  return win.webContents.executeJavaScript(script);
}

function getDiscoveryPages(site) {
  return [new URL("/", site.url).toString()];
}

function getSettleDelay(site) {
  return site.domain === "economist.com" ? 500 : 1800;
}

function sameHostname(baseUrl, candidateUrl) {
  return host(baseUrl) === host(candidateUrl);
}

function host(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function dedupe(items) {
  const byUrl = new Map();
  for (const item of items) {
    if (!byUrl.has(item.url)) byUrl.set(item.url, item);
  }
  return [...byUrl.values()];
}

function logBrowserDiscovery(event, payload) {
  console.info("[browser-discovery]", JSON.stringify({
    event,
    timestamp: Date.now(),
    payload
  }));
}

module.exports = {
  discoverArticlesWithBrowser,
  browserController
};
