const DISALLOWED_PATH_PARTS = [
  "/tag/",
  "/tags/",
  "/category/",
  "/categories/",
  "/author/",
  "/authors/",
  "/login",
  "/signin",
  "/sign-in",
  "/register",
  "/subscribe",
  "/subscription",
  "/offers",
  "/v2/offers",
  "/account",
  "/search",
  "/video",
  "/podcast",
  "/shop",
  "/store",
  "/cart",
  "/events",
  "/about",
  "/contact",
  "/privacy",
  "/terms",
  "/newsletter",
  "/topic/",
  "/topics/",
  "/crossword",
  "/puzzle",
  "/games/",
  "/lecturers/"
];
const SPONSORED_PATTERNS = [/sponsored/i, /advertisement/i, /advertorial/i, /paid post/i, /partner content/i, /paid content/i];
const UTILITY_CONTENT_PATTERNS = [/\bcrossword\b/i, /\bdaily puzzle\b/i, /\bword game\b/i, /\bquiz\b/i];

function looksLikeArticleUrl(url) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    const full = `${path}${parsed.search}`.toLowerCase();
    if (path === "/" || path.split("/").filter(Boolean).length < 2) return false;
    if (DISALLOWED_PATH_PARTS.some((part) => full.includes(part))) return false;
    if (/(^|\/)(tag|tags|category|categories|author|authors|login|signin|search|subscribe|shop)(\/|$)/.test(path)) return false;
    if (SPONSORED_PATTERNS.some((pattern) => pattern.test(full))) return false;
    if (UTILITY_CONTENT_PATTERNS.some((pattern) => pattern.test(full))) return false;
    if (/\.(jpg|jpeg|png|gif|webp|svg|pdf|zip|mp4|mp3)$/i.test(path)) return false;
    return (
      /\/20\d{2}\//.test(path) ||
      /\/\d{4}\/\d{2}\//.test(path) ||
      path.includes("/article") ||
      path.includes("/story") ||
      path.includes("/news") ||
      path.includes("/culture") ||
      path.includes("/fashion") ||
      path.includes("/books") ||
      path.includes("/magazine") ||
      path.includes("/essay") ||
      path.includes("/review") ||
      path.includes("/interview") ||
      path.split("/").filter(Boolean).length >= 3
    );
  } catch {
    return false;
  }
}

function isSponsoredLike(title = "", url = "") {
  return [...SPONSORED_PATTERNS, ...UTILITY_CONTENT_PATTERNS]
    .some((pattern) => pattern.test(title) || pattern.test(url));
}

function isHomepageUrl(siteUrl, candidateUrl) {
  try {
    const site = new URL(siteUrl);
    const candidate = new URL(candidateUrl);
    const sameHost = site.hostname.replace(/^www\./, "") === candidate.hostname.replace(/^www\./, "");
    const candidatePath = candidate.pathname.replace(/\/+$/, "") || "/";
    return sameHost && candidatePath === "/";
  } catch {
    return false;
  }
}

module.exports = {
  looksLikeArticleUrl,
  isHomepageUrl,
  isSponsoredLike
};
