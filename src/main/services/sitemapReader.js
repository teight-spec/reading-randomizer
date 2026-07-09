const cheerio = require("cheerio");
const { createRequestGovernance } = require("./requestGovernance");
const { resolveSiteStrategy } = require("./siteStrategies");
const { looksLikeArticleUrl } = require("./candidateFilter");
const { cleanText, urlToTitle } = require("./candidateNormalizer");
const { parseDate } = require("./feedReader");

const SITEMAP_TIMEOUT_MS = 5000;
const requestGovernance = createRequestGovernance({
  minIntervalMs: 900,
  maxRetries: 1
});

async function discoverSitemapUrls(siteUrl) {
  const strategy = resolveSiteStrategy(siteUrl);
  if (strategy?.sitemapEndpoints?.length) {
    return resolveStrategyEndpoints(siteUrl, strategy.sitemapEndpoints);
  }
  const urls = new Set();
  urls.add(new URL("/sitemap.xml", siteUrl).toString());
  urls.add(new URL("/sitemap_index.xml", siteUrl).toString());
  urls.add(new URL("/news-sitemap.xml", siteUrl).toString());
  return [...urls];
}

async function readSitemap(sitemapUrl, depth = 0) {
  if (depth > 1) return [];

  const response = await requestGovernance.request(sitemapUrl, {
    timeoutMs: SITEMAP_TIMEOUT_MS,
    source: "sitemap-parser",
    profile: "feed",
    fetchMode: "sitemap",
    strategySource: resolveSiteStrategy(sitemapUrl)?.id || "configured-or-generic"
  });
  if (!response.ok) {
    throw new Error(`Sitemap request failed: ${response.status}`);
  }

  const $ = cheerio.load(response.text, { xmlMode: true });
  const articles = [];

  const childSitemaps = $("sitemap loc")
    .map((_, item) => cleanText($(item).text()))
    .get()
    .slice(0, 10);

  for (const child of childSitemaps) {
    try {
      articles.push(...(await readSitemap(child, depth + 1)));
    } catch {
      // Continue reading other sitemap children.
    }
  }

  $("url").each((_, item) => {
    const node = $(item);
    const url = cleanText(node.find("loc").first().text());
    if (!url || !looksLikeArticleUrl(url)) return;

    articles.push({
      title: urlToTitle(url),
      url,
      publishedAt: parseDate(
        node.find("lastmod").first().text() ||
          node.find("news\\:publication_date").first().text() ||
          node.find("publication_date").first().text()
      ),
      source: sitemapUrl
    });
  });

  return articles;
}

function resolveStrategyEndpoints(siteUrl, endpoints = []) {
  return endpoints
    .map((endpoint) => {
      try {
        return new URL(endpoint, siteUrl).toString();
      } catch {
        return "";
      }
    })
    .filter(Boolean);
}

module.exports = {
  discoverSitemapUrls,
  readSitemap,
  resolveStrategyEndpoints
};
