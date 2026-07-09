const cheerio = require("cheerio");
const { createRequestGovernance } = require("./requestGovernance");
const { resolveSiteStrategy } = require("./siteStrategies");
const { cleanText } = require("./candidateNormalizer");

const FEED_TIMEOUT_MS = 5000;
const requestGovernance = createRequestGovernance({
  minIntervalMs: 900,
  maxRetries: 1
});

async function readFeed(feedUrl) {
  const response = await requestGovernance.request(feedUrl, {
    timeoutMs: FEED_TIMEOUT_MS,
    source: "feed-fetcher",
    profile: "feed",
    fetchMode: "feed",
    strategySource: resolveSiteStrategy(feedUrl)?.id || "configured-or-generic"
  });
  if (!response.ok) {
    throw new Error(`Feed request failed: ${response.status}`);
  }

  const $ = cheerio.load(response.text, { xmlMode: true });
  const articles = [];

  $("item").each((_, item) => {
    const node = $(item);
    articles.push({
      title: cleanText(node.find("title").first().text()),
      url: cleanText(node.find("link").first().text()) || cleanText(node.find("guid").first().text()),
      publishedAt: parseDate(node.find("pubDate").first().text()),
      source: feedUrl
    });
  });

  $("entry").each((_, entry) => {
    const node = $(entry);
    const href = node.find("link[rel='alternate']").attr("href") || node.find("link").first().attr("href");
    articles.push({
      title: cleanText(node.find("title").first().text()),
      url: href ? new URL(href, feedUrl).toString() : "",
      publishedAt: parseDate(node.find("updated").first().text() || node.find("published").first().text()),
      source: feedUrl
    });
  });

  return articles;
}

function parseDate(text) {
  const time = Date.parse(text);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

module.exports = {
  readFeed,
  parseDate
};
