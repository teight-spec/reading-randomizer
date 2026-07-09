const PulitzerStrategy = {
  id: "pulitzer",
  hostnames: ["pulitzer.org"],
  preferredFetchMode: "feed-first",
  parserPriority: ["feed", "sitemap", "browser", "reader"],
  feedEndpoints: ["https://www.pulitzer.org/news.xml"],
  sitemapEndpoints: ["/sitemap.xml"],
  articleHints: ["/news/", "/winner/", "/prize/"],
  antiBotHints: ["403", "access denied", "captcha"],
  canonicalNormalization: {}
};

module.exports = {
  PulitzerStrategy
};
