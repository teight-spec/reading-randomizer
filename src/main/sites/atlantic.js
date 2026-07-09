const AtlanticStrategy = {
  id: "atlantic",
  hostnames: ["theatlantic.com"],
  preferredFetchMode: "feed-first",
  parserPriority: ["feed", "sitemap", "browser", "reader"],
  feedEndpoints: ["https://www.theatlantic.com/feed/all/", "https://www.theatlantic.com/feed/channel/world/"],
  sitemapEndpoints: ["/sitemap.xml"],
  articleHints: ["/ideas/", "/politics/", "/culture/", "/technology/"],
  antiBotHints: ["captcha", "403", "access denied"],
  canonicalNormalization: {}
};

module.exports = {
  AtlanticStrategy
};
