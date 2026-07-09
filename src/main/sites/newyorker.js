const NewYorkerStrategy = {
  id: "newyorker",
  hostnames: ["newyorker.com"],
  preferredFetchMode: "feed-first",
  parserPriority: ["feed", "sitemap", "browser", "reader"],
  feedEndpoints: [
    "https://www.newyorker.com/feed/magazine/reporting/rss",
    "https://www.newyorker.com/feed/magazine/rss",
    "https://www.newyorker.com/feed/culture/rss",
    "https://www.newyorker.com/feed/news/rss"
  ],
  sitemapEndpoints: ["/sitemap.xml", "/sitemap_index.xml"],
  articleHints: ["/magazine/", "/news/", "/culture/", "/books/", "/cartoons/"],
  antiBotHints: ["cloudflare", "captcha", "403", "access denied"],
  canonicalNormalization: {
    stripQueryParams: ["utm_source", "utm_medium", "utm_campaign", "mbid"]
  }
};

module.exports = {
  NewYorkerStrategy
};
