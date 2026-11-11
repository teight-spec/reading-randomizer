const { ArticlePipeline } = require("./articlePipeline");

const RANDOM_SITE_DISCOVERY_TIMEOUT_MS = 12000;
const DIRECT_SITE_DISCOVERY_TIMEOUT_MS = 22000;
const BACKGROUND_SITE_LIMIT = 16;
const BACKGROUND_READY_PER_SITE = 2;

class ArticlePrefetcher {
  constructor({ siteStore, historyStore, articleCache, extractReaderArticle, siteHealthStore }) {
    this.siteStore = siteStore;
    this.historyStore = historyStore;
    this.articleCache = articleCache;
    this.extractReaderArticle = extractReaderArticle;
    this.siteHealthStore = siteHealthStore;
    this.articlePipeline = new ArticlePipeline({ siteHealthStore });
    this.currentPromise = null;
    this.backgroundPromise = null;
  }

  start() {
    if (!isBackgroundWarmupDisabled()) {
      this.startBackgroundWarmup();
    }
    if (!this.currentPromise) {
      this.currentPromise = this.prepareNext().catch((error) => ({
        site: null,
        article: null,
        readerArticle: null,
        readerError: error.message,
        skippedSites: [{ reason: error.message }],
        sites: []
      }));
    }
    return this.currentPromise;
  }

  invalidate() {
    this.currentPromise = null;
  }

  async consume() {
    const result = await this.start();
    this.currentPromise = null;
    this.start();
    return result;
  }

  async prepareNext() {
    const sites = await this.siteStore.listActiveSites();
    if (!sites.length) {
      return {
        site: null,
        article: null,
        readerArticle: null,
        readerError: "No reading sources yet. Import bookmark folders or add a website.",
        skippedSites: [],
        sites: []
      };
    }
    this.historyStore.setActiveSiteIds(sites.map((site) => site.id));
    const readUrls = await this.getReadUrlSet();
    const cached = await this.articleCache.getAnyReady(sites.map((site) => site.id), readUrls);
    if (cached) {
      await this.recordServed(cached.site, cached.article);
      return {
        site: cached.site,
        article: cached.article,
        readerArticle: cached.readerArticle,
        readerError: null,
        skippedSites: [],
        sites,
        cacheHit: true
      };
    }

    const candidateSites = await this.historyStore.chooseUnusedSites(sites, Math.min(sites.length, 8));
    const skippedSites = [];

    const siteResults = await Promise.allSettled(
      candidateSites.map(async (site) => ({
        site,
        articles: await this.getCandidatesForSite(site, 8, RANDOM_SITE_DISCOVERY_TIMEOUT_MS)
      }))
    );

    for (const result of siteResults) {
      if (result.status !== "fulfilled" || !result.value.articles.length) {
        if (result.status === "fulfilled") {
          skippedSites.push({
            siteTitle: result.value.site.title,
            reason: "No article-level URL found"
          });
        }
        continue;
      }

      const { site, articles } = result.value;
      for (const article of articles.filter((item) => !readUrls.has(item.url))) {
        try {
          const readerArticle = await this.extractAndCache(site, article);
          await this.recordServed(site, article);
          return {
            site,
            article,
            readerArticle,
            readerError: null,
            skippedSites,
            sites
          };
        } catch (error) {
          skippedSites.push({
            siteTitle: site.title,
            articleUrl: article.url,
            reason: error.message
          });
        }
      }
    }

    return {
      site: null,
      article: null,
      readerArticle: null,
      readerError: "No valid article passed extraction filters",
      skippedSites,
      sites
    };
  }

  async prepareForSite(site) {
    const skippedSites = [];
    const sites = await this.siteStore.listActiveSites();
    this.historyStore.setActiveSiteIds(sites.map((item) => item.id));
    const readUrls = await this.getReadUrlSet();
    const cached = await this.articleCache.getReadyForSite(site.id, readUrls);
    if (cached) {
      this.refreshSiteInBackground(site);
      await this.recordServed(cached.site, cached.article);
      return {
        site: cached.site,
        article: cached.article,
        readerArticle: cached.readerArticle,
        readerError: null,
        skippedSites,
        sites: await this.siteStore.listActiveSites(),
        cacheHit: true
      };
    }

    const articles = await this.getCandidatesForSite(site, 10, DIRECT_SITE_DISCOVERY_TIMEOUT_MS);
    for (const article of articles.filter((item) => !readUrls.has(item.url))) {
      try {
        const readerArticle = await this.extractAndCache(site, article);
        await this.recordServed(site, article);
        return {
          site,
          article,
          readerArticle,
          readerError: null,
          skippedSites,
          sites: await this.siteStore.listActiveSites()
        };
      } catch (error) {
        await this.articleCache.putFailed(site, article, error);
        skippedSites.push({
          siteTitle: site.title,
          articleUrl: article.url,
          reason: error.message
        });
      }
    }

    return {
      site: null,
      article: null,
      readerArticle: null,
      readerError: "No valid article found for this site",
      skippedSites,
      sites: await this.siteStore.listActiveSites()
    };
  }

  startBackgroundWarmup() {
    if (this.backgroundPromise) return;
    this.backgroundPromise = this.warmLibrary()
      .catch(() => {})
      .finally(() => {
        this.backgroundPromise = null;
      });
  }

  async warmLibrary() {
    const sites = await this.siteStore.listActiveSites();
    if (!sites.length) return;
    const candidateSites = shuffle(sites).slice(0, BACKGROUND_SITE_LIMIT);
    await settleWithConcurrency(candidateSites, 3, async (site) => {
      const articles = await this.getCandidatesForSite(site, 8, RANDOM_SITE_DISCOVERY_TIMEOUT_MS);
      let readyCount = 0;
      for (const article of articles) {
        if (readyCount >= BACKGROUND_READY_PER_SITE) break;
        const cached = await this.articleCache.getArticle(article.url);
        if (cached) {
          readyCount += 1;
          continue;
        }
        try {
          await this.extractAndCache(site, article);
          readyCount += 1;
        } catch (error) {
          await this.articleCache.putFailed(site, article, error);
        }
      }
    });
  }

  refreshSiteInBackground(site) {
    this.getCandidatesForSite(site, 8, RANDOM_SITE_DISCOVERY_TIMEOUT_MS)
      .then((articles) => settleWithConcurrency(articles.slice(0, 2), 2, (article) => this.extractAndCache(site, article)))
      .catch(() => {});
  }

  async getCandidatesForSite(site, limit, timeoutMs) {
    const hasFreshEntry = await this.articleCache.hasFreshCandidateEntry(site.id);
    const cachedCandidates = await this.articleCache.getFreshCandidates(site.id);
    if (hasFreshEntry && !cachedCandidates.length) return [];
    if (cachedCandidates.length) return cachedCandidates.slice(0, limit);

    const articles = await this.articlePipeline.getCandidates(site, {
      limit,
      timeoutMs,
      enabledStages: shouldUseBrowserDiscovery(site) ? ["feed-sitemap", "browser"] : ["feed-sitemap"]
    });
    if (articles.length) {
      await this.articleCache.putCandidates(site, articles);
    } else {
      await this.articleCache.putCandidates(site, []);
    }
    return articles;
  }

  async extractAndCache(site, article) {
    const cached = await this.articleCache.getArticle(article.url);
    if (cached) return cached.readerArticle;
    const startedAt = Date.now();
    try {
      const readerArticle = await this.extractReaderArticle(article.url);
      await this.articleCache.putReady(site, article, readerArticle);
      await this.siteHealthStore?.record(site, {
        stageName: "article",
        ok: true,
        latencyMs: Date.now() - startedAt,
        strategySource: readerArticle.diagnostics?.parser || "reader",
        parserUsed: readerArticle.diagnostics?.parser || "unknown",
        qualityScore: readerArticle.diagnostics?.quality?.qualityScore ?? null,
        traceId: readerArticle.diagnostics?.traceId || null
      });
      return readerArticle;
    } catch (error) {
      await this.siteHealthStore?.record(site, {
        stageName: "article",
        ok: false,
        latencyMs: Date.now() - startedAt,
        strategySource: "reader",
        failureCategory: error.failureCategory || "parser_failure",
        fallbackReason: error.message
      });
      throw error;
    }
  }

  async getReadUrlSet() {
    const history = await this.historyStore.load();
    return new Set([
      ...(history.readArticles || []).map((item) => item.articleUrl),
      ...(history.openedArticles || []).map((item) => item.articleUrl)
    ]);
  }

  async recordServed(site, article) {
    await this.historyStore.markSiteVisited(site);
    await this.historyStore.markOpened(site, article);
  }
}

function withTimeout(promise, timeoutMs, fallbackValue) {
  return Promise.race([
    promise,
    new Promise((resolve) => {
      setTimeout(() => resolve(fallbackValue), timeoutMs);
    })
  ]);
}

async function settleWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (index < items.length) {
        const currentIndex = index;
        index += 1;
        try {
          results[currentIndex] = {
            status: "fulfilled",
            value: await worker(items[currentIndex])
          };
        } catch (reason) {
          results[currentIndex] = {
            status: "rejected",
            reason
          };
        }
      }
    })
  );
  return results;
}

function shuffle(items) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function shouldUseBrowserDiscovery(site) {
  return ["economist.com", "newyorker.com"].includes(site.domain);
}

function isBackgroundWarmupDisabled() {
  return ["1", "true", "yes"].includes(String(process.env.READER_DISABLE_BACKGROUND_WARMUP || "").toLowerCase());
}

module.exports = {
  ArticlePrefetcher
};
