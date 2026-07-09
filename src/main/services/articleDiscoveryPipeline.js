const { discoverFeedUrls } = require("./feedDiscovery");
const { resolveSiteStrategy } = require("./siteStrategies");
const { looksLikeArticleUrl, isHomepageUrl } = require("./candidateFilter");
const { normalizeArticle } = require("./candidateNormalizer");
const { dedupeArticles, shuffle } = require("./candidateRanker");
const { readFeed } = require("./feedReader");
const { discoverSitemapUrls, readSitemap, resolveStrategyEndpoints } = require("./sitemapReader");
const { resultFromArticles } = require("./capabilityContract");

const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;

async function discoverArticleCandidates(site, limit = 12) {
  const result = await discoverArticleCandidatesResult(site, limit);
  return result.data.articles;
}

async function discoverArticleCandidatesResult(site, limit = 12, context = {}) {
  const startedAt = Date.now();
  const strategy = resolveSiteStrategy(site.url);
  const configuredFeeds = (site.articleSources || []).filter((source) => source.type === "feed").map((source) => source.url);
  const configuredSitemaps = (site.articleSources || []).filter((source) => source.type === "sitemap").map((source) => source.url);
  const strategyFeeds = resolveStrategyEndpoints(site.url, strategy?.feedEndpoints || []);
  const strategySitemaps = resolveStrategyEndpoints(site.url, strategy?.sitemapEndpoints || []);
  const [feedUrls, sitemapUrls] = await Promise.all([
    configuredFeeds.length || strategyFeeds.length ? [] : discoverFeedUrls(site.url),
    configuredFeeds.length || strategySitemaps.length ? [] : discoverSitemapUrls(site.url)
  ]);
  const allFeedUrls = [...new Set([...configuredFeeds, ...strategyFeeds, ...feedUrls])];
  const allSitemapUrls = [...new Set([...configuredSitemaps, ...strategySitemaps, ...sitemapUrls])];
  const articles = [];

  const feedResults = await settleWithConcurrency(allFeedUrls, 4, readFeed);
  for (const result of feedResults) {
    if (result.status === "fulfilled") articles.push(...result.value);
  }

  if (articles.length < 5 && allSitemapUrls.length) {
    const sitemapResults = await settleWithConcurrency(allSitemapUrls, 3, readSitemap);
    for (const result of sitemapResults) {
      if (result.status === "fulfilled") articles.push(...result.value);
    }
  }

  const normalized = normalizeCandidates(site, articles, limit);
  return resultFromArticles({
    capabilityName: "feed-sitemap",
    stage: "feed",
    strategySource: strategy?.id || context.strategySource || "generic",
    articles: normalized,
    url: site.url,
    duration: Date.now() - startedAt,
    trace: {
      traceId: context.traceId || null,
      feedUrlCount: allFeedUrls.length,
      sitemapUrlCount: allSitemapUrls.length,
      rawArticleCount: articles.length
    },
    fallbackReason: "feed_and_sitemap_returned_no_article_candidates"
  });
}

function normalizeCandidates(site, articles, limit) {
  const cutoff = Date.now() - ONE_MONTH_MS;
  const articleLevelCandidates = dedupeArticles(articles)
    .map((article) => normalizeArticle(site.url, article))
    .filter(Boolean)
    .filter((article) => article.url && !isHomepageUrl(site.url, article.url));

  const recentArticles = articleLevelCandidates.filter(
    (article) => !article.publishedAt || new Date(article.publishedAt).getTime() >= cutoff
  );

  return shuffle(recentArticles.length ? recentArticles : articleLevelCandidates).slice(0, limit);
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

module.exports = {
  discoverArticleCandidates,
  discoverArticleCandidatesResult,
  looksLikeArticleUrl
};
