const GuardianStrategy = {
  id: "guardian",
  hostnames: ["theguardian.com", "guardian.com"],
  preferredFetchMode: "feed-first",
  parserPriority: ["feed", "sitemap", "browser", "reader"],
  feedEndpoints: ["/atom.xml", "/rss"],
  sitemapEndpoints: ["/sitemap.xml", "/sitemap-index.xml"],
  articleHints: ["/world/", "/books/", "/culture/", "/commentisfree/"],
  antiBotHints: ["captcha", "403", "access denied"],
  canonicalNormalization: {}
};

module.exports = {
  GuardianStrategy
};
