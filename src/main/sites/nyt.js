const NytStrategy = {
  id: "nyt",
  hostnames: ["nytimes.com", "nyt.com"],
  preferredFetchMode: "feed-first",
  parserPriority: ["feed", "sitemap", "browser", "reader"],
  feedEndpoints: ["/rss", "/svc/collections/v1/publish/www/sectionfronts/all.xml"],
  sitemapEndpoints: ["/sitemap.xml", "/sitemap-news.xml"],
  articleHints: ["/202", "/live/", "/interactive/"],
  antiBotHints: ["captcha", "403", "access denied"],
  canonicalNormalization: {}
};

module.exports = {
  NytStrategy
};
