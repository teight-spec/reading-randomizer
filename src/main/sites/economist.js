const EconomistStrategy = {
  id: "economist",
  hostnames: ["economist.com"],
  preferredFetchMode: "feed-first",
  parserPriority: ["feed", "sitemap", "browser", "reader"],
  feedEndpoints: ["/rss", "/latest/rss.xml", "/feeds/"],
  sitemapEndpoints: ["/sitemap.xml", "/sitemap_index.xml"],
  articleHints: ["/printedition/", "/news/", "/briefing/", "/finance/", "/books-and-arts/"],
  antiBotHints: ["cloudflare", "captcha", "403", "check your browser"],
  canonicalNormalization: {
    stripQueryParams: ["utm_source", "utm_medium", "utm_campaign", "utm_content"]
  }
};

module.exports = {
  EconomistStrategy
};
