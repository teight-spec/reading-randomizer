const { looksPaywalled } = require("./archive");
const { createRequestGovernance } = require("./requestGovernance");
const { resolveSiteStrategy } = require("./siteStrategies");
const { discoverFeedUrls } = require("./feedDiscovery");
const { looksLikeArticleUrl } = require("./candidateFilter");
const { discoverArticleCandidates } = require("./articleDiscoveryPipeline");
const { discoverSitemapUrls, readSitemap } = require("./sitemapReader");
const { readFeed } = require("./feedReader");

const DISCOVERY_TIMEOUT_MS = 5000;
const requestGovernance = createRequestGovernance({
  minIntervalMs: 900,
  maxRetries: 1
});

async function pickRecentArticle(site) {
  const articles = await pickRecentArticles(site, 1);
  return articles[0] || null;
}

async function pickRecentArticles(site, limit = 12) {
  return discoverArticleCandidates(site, limit);
}

async function inspectArticle(url) {
  try {
    const response = await requestGovernance.request(url, {
      timeoutMs: DISCOVERY_TIMEOUT_MS,
      source: "fallback-probe",
      profile: "article-parser",
      fetchMode: "inspect",
      strategySource: resolveSiteStrategy(url)?.id || "generic"
    });
    return {
      paywalled: looksPaywalled(response.text)
    };
  } catch {
    return {
      paywalled: false
    };
  }
}

module.exports = {
  pickRecentArticle,
  pickRecentArticles,
  inspectArticle,
  discoverFeedUrls,
  discoverSitemapUrls,
  readFeed,
  readSitemap,
  looksLikeArticleUrl
};
