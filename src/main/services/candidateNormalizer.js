const { looksLikeArticleUrl, isSponsoredLike } = require("./candidateFilter");

function normalizeArticle(siteUrl, article) {
  try {
    const url = normalizeArticleUrl(new URL(article.url, siteUrl).toString());
    if (!looksLikeArticleUrl(url)) return null;
    if (isSponsoredLike(article.title, url)) return null;
    return {
      ...article,
      title: cleanText(article.title) || urlToTitle(url),
      url
    };
  } catch {
    return null;
  }
}

function normalizeArticleUrl(url) {
  const parsed = new URL(url);
  parsed.hash = "";
  const trackingParams = [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "utm_brand",
    "gad_source",
    "gclid",
    "fbclid",
    "mc_cid",
    "mc_eid"
  ];
  for (const param of trackingParams) {
    parsed.searchParams.delete(param);
  }
  return parsed.toString();
}

function cleanText(text = "") {
  return text.replace(/\s+/g, " ").trim();
}

function urlToTitle(url) {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop() || url;
    return last.replace(/[-_]+/g, " ").replace(/\.\w+$/, "");
  } catch {
    return url;
  }
}

module.exports = {
  normalizeArticle,
  normalizeArticleUrl,
  cleanText,
  urlToTitle
};
