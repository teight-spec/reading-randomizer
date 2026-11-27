const { JSDOM, VirtualConsole } = require("jsdom");
const { Readability } = require("@mozilla/readability");
const { createRequestGovernance, classifyFailure } = require("./requestGovernance");
const { resolveSiteStrategy } = require("./siteStrategies");
const { evaluateExtractionQuality } = require("./extractionQualityEvaluator");
const { BrowserExtractionController, isWindowUsable } = require("./browserExtractionController");
const { sanitizeArticleHtml } = require("./htmlSanitizer");

const READER_TIMEOUT_MS = 9000;
const BROWSER_STABILIZE_TIMEOUT_MS = 2500;
const BROWSER_SECOND_PASS_DELAY_MS = 900;
const MIN_TEXT_LENGTH = 850;
const DOMAIN_MIN_TEXT_LENGTH = {
  "anothermanmag.com": 700
};
const MIN_CONTENT_DENSITY = 0.1;
const BAD_CONTENT_PATTERNS = [/sponsored/i, /advertisement/i, /advertorial/i, /partner content/i];
const virtualConsole = new VirtualConsole();
const requestGovernance = createRequestGovernance({
  minIntervalMs: 900,
  maxRetries: 1
});
const browserController = new BrowserExtractionController({
  maxConcurrent: 1
});

async function extractReaderArticle(url) {
  const diagnostics = {
    url,
    stage: "fetch",
    fetched: false,
    status: null,
    htmlBytes: 0,
    variants: [],
    parser: null,
    selectorMatches: [],
    textLength: 0,
    density: 0,
    errors: []
  };
  const first = await fetchHtml(url, diagnostics);
  const candidateUrls = discoverArticleVariants(first.html, url);
  const errors = [];

  for (const candidateUrl of candidateUrls) {
    diagnostics.variants.push(candidateUrl);
    try {
      diagnostics.stage = "extract";
      const html = candidateUrl === url ? first.html : (await fetchHtml(candidateUrl, diagnostics)).html;
      return withDiagnostics(extractFromHtml(candidateUrl, html, diagnostics), diagnostics);
    } catch (error) {
      errors.push(`${candidateUrl}: ${error.message}`);
      diagnostics.errors.push({
        url: candidateUrl,
        message: error.message
      });
    }
  }

  const error = new Error(`Could not extract valid article. ${errors.slice(0, 3).join(" | ")}`);
  error.diagnostics = diagnostics;
  throw error;
}

async function fetchHtml(url, diagnostics) {
  const response = await requestGovernance.request(url, {
    timeoutMs: READER_TIMEOUT_MS,
    source: "article-fetch",
    profile: "article-parser",
    fetchMode: "article",
    strategySource: resolveSiteStrategy(url)?.id || "generic"
  });
  if (diagnostics) {
    diagnostics.fetched = true;
    diagnostics.status = response.status;
    diagnostics.htmlBytes = Math.max(diagnostics.htmlBytes || 0, Buffer.byteLength(response.text || "", "utf8"));
  }
  if (!response.ok) {
    if (shouldTryBrowserHtml(url, response.status)) {
      return fetchHtmlWithBrowser(url, diagnostics);
    }
    const error = new Error(`Reader mode request failed: ${response.status}`);
    error.failureCategory = classifyFailure(error, response);
    if (diagnostics) error.diagnostics = diagnostics;
    throw error;
  }

  return {
    url,
    html: response.text
  };
}

async function fetchHtmlWithBrowser(url, diagnostics) {
  return browserController.run({
    url,
    label: `reader:${safeHost(url)}`,
    traceId: diagnostics?.traceId || null,
    timeoutMs: READER_TIMEOUT_MS,
    onLoaded: async (win) => {
      await primeBrowserArticleDom(win);
    },
    worker: async (win, extractionSession) => {
      const firstPassHtml = await captureBrowserHtml(win);
      const secondPassHtml = await captureBrowserHtmlWithMutationWait(win);
      const html = chooseBetterHtml(firstPassHtml, secondPassHtml);
      if (diagnostics) {
        diagnostics.stage = "browser-html";
        diagnostics.fetched = true;
        diagnostics.status = 200;
        diagnostics.htmlBytes = Math.max(diagnostics.htmlBytes || 0, Buffer.byteLength(html || "", "utf8"));
        diagnostics.browserPasses = {
          firstPass: Buffer.byteLength(firstPassHtml || "", "utf8"),
          secondPass: Buffer.byteLength(secondPassHtml || "", "utf8"),
          usedSecondPass: html === secondPassHtml && firstPassHtml !== secondPassHtml
        };
        diagnostics.extractionNetwork = extractionSession.stats;
        diagnostics.usedSecondPass = diagnostics.browserPasses.usedSecondPass;
      }
      return {
        url,
        html
      };
    }
  });
}

async function primeBrowserArticleDom(win) {
  try {
    await safeExecuteJavaScript(win, `
      (() => {
        const scrollStep = Math.max(900, Math.floor(window.innerHeight * 1.5));
        let y = 0;
        const maxY = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
        const limit = Math.min(maxY + 1500, 22000);
        while (y < limit) {
          window.scrollTo(0, y);
          y += scrollStep;
        }
        window.scrollTo(0, 0);
        return true;
      })()
    `);
    await new Promise((resolve) => setTimeout(resolve, BROWSER_SECOND_PASS_DELAY_MS));
  } catch {
    // Best effort only.
  }
}

async function captureBrowserHtml(win) {
  return safeExecuteJavaScript(win, "document.documentElement.outerHTML");
}

async function captureBrowserHtmlWithMutationWait(win) {
  try {
    await safeExecuteJavaScript(win, `
      (() => new Promise((resolve) => {
        const target = document.body || document.documentElement;
        let timer = null;
        const finish = () => {
          observer.disconnect();
          resolve(true);
        };
        const observer = new MutationObserver(() => {
          clearTimeout(timer);
          timer = setTimeout(finish, ${BROWSER_STABILIZE_TIMEOUT_MS});
        });
        observer.observe(target, { subtree: true, childList: true, characterData: true });
        timer = setTimeout(finish, ${BROWSER_STABILIZE_TIMEOUT_MS});
      }))()
    `);
  } catch {
    // Ignore and fall back to immediate snapshot.
  }
  return captureBrowserHtml(win);
}

function safeExecuteJavaScript(win, script) {
  if (!isWindowUsable(win)) {
    const error = new Error("browser extraction window is no longer available");
    error.failureCategory = "browser_lifecycle";
    throw error;
  }
  return win.webContents.executeJavaScript(script);
}

function chooseBetterHtml(firstPassHtml = "", secondPassHtml = "") {
  return Buffer.byteLength(secondPassHtml || "", "utf8") > Buffer.byteLength(firstPassHtml || "", "utf8")
    ? secondPassHtml
    : firstPassHtml;
}

function shouldTryBrowserHtml(url, status) {
  const domain = (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  })();
  return [401, 403, 429].includes(Number(status)) && ["economist.com", "newyorker.com"].includes(domain);
}

function extractFromHtml(url, html, diagnostics = {}) {
  const publishedAt = extractPublishedAt(html);
  const structuredArticle = extractStructuredArticle(url, html, publishedAt, diagnostics);
  const heuristicArticle = extractHeuristicArticle(url, html, publishedAt, diagnostics);
  const mergedArticle = extractMergedArticle(url, html, publishedAt, diagnostics);
  const dom = new JSDOM(html, { url, virtualConsole });
  removeKnownNoise(dom.window.document);
  normalizeMedia(dom.window.document);
  const article = new Readability(dom.window.document).parse();

  if (!article?.content) {
    if (structuredArticle) return structuredArticle;
    if (mergedArticle) return mergedArticle;
    if (heuristicArticle) return heuristicArticle;
    throw new Error("Could not extract readable article content");
  }

  const result = {
    title: article.title || url,
    byline: article.byline || "",
    excerpt: article.excerpt || "",
    content: article.content,
    publishedAt,
    textContent: article.textContent || "",
    length: article.length || 0,
    url
  };

  try {
    validateArticle(result, diagnostics, "readability");
    result.diagnostics = {
      ...diagnostics,
      parser: "readability"
    };
    return result;
  } catch (error) {
    if (structuredArticle) return structuredArticle;
    if (mergedArticle) return mergedArticle;
    if (heuristicArticle) return heuristicArticle;
    throw error;
  }
}

function discoverArticleVariants(html, baseUrl) {
  const $ = require("cheerio").load(html);
  const urls = [];
  rememberArticleUrl(urls, baseUrl);
  const selectors = [
    "link[rel='canonical']",
    "link[rel='amphtml']",
    "a[href]"
  ];

  for (const selector of selectors) {
    $(selector).each((_, element) => {
      const text = $(element).text();
      const rel = ($(element).attr("rel") || "").toLowerCase();
      const href = $(element).attr("href");
      if (!href) return;

      const isReadMore =
        /read more|continue reading|keep reading|阅读全文|继续阅读/i.test(text) ||
        rel.includes("canonical") ||
        rel.includes("amphtml");
      if (!isReadMore) return;

      try {
        rememberArticleUrl(urls, new URL(href, baseUrl).toString());
      } catch {
        // Ignore malformed candidate URLs.
      }
    });
  }

  return urls.slice(0, 5);
}

function rememberArticleUrl(urls, value) {
  if (!isSafeArticleUrl(value) || urls.includes(value)) return;
  urls.push(value);
}

function isSafeArticleUrl(value) {
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    if (parsed.username || parsed.password) return false;
    return true;
  } catch {
    return false;
  }
}

function validateArticle(article, diagnostics = {}, parser = "unknown") {
  const text = (article.textContent || "").replace(/\s+/g, " ").trim();
  const htmlText = stripHtml(article.content);
  const density = htmlText.length / Math.max(article.content.length, 1);
  diagnostics.parser = parser;
  diagnostics.textLength = text.length;
  diagnostics.density = Number(density.toFixed(3));
  diagnostics.debug = {
    url: diagnostics.url,
    containersFound: diagnostics.containersFound || 0,
    primarySelector: diagnostics.primarySelector || null,
    nodesExtracted: diagnostics.nodesExtracted || 0,
    textLength: text.length,
    usedSecondPass: Boolean(diagnostics.usedSecondPass)
  };

  if (BAD_CONTENT_PATTERNS.some((pattern) => pattern.test(article.title) || pattern.test(text.slice(0, 500)))) {
    throw new Error("article appears to be sponsored or advertising content");
  }

  const minTextLength = getMinTextLength(article.url || diagnostics.url);
  if (text.length < minTextLength) {
    throw new Error(`article text too short (${text.length} chars)`);
  }

  if (density < MIN_CONTENT_DENSITY) {
    throw new Error(`article content density too low (${density.toFixed(2)})`);
  }
}

function extractStructuredArticle(url, html, fallbackPublishedAt, diagnostics = {}) {
  const $ = require("cheerio").load(html);
  const candidates = [];

  $("script[type='application/ld+json']").each((_, element) => {
    const raw = $(element).contents().text();
    for (const item of parseJsonLd(raw)) {
      candidates.push(...flattenJsonLd(item));
    }
  });

  const article = candidates.find((item) => {
    const type = Array.isArray(item["@type"]) ? item["@type"].join(" ") : item["@type"];
    return /article|newsarticle|blogposting|review/i.test(type || "") && item.articleBody;
  });

  if (!article) return null;
  diagnostics.selectorMatches.push({
    parser: "json-ld",
    matches: candidates.length
  });

  const text = cleanText(article.articleBody);
  if (text.length < MIN_TEXT_LENGTH) return null;

  const paragraphs = text
    .split(/\n{2,}|(?<=\.|\?|!|。|？|！)\s+(?=[A-Z"“])/)
    .map((paragraph) => cleanText(paragraph))
    .filter((paragraph) => paragraph.length > 40)
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join("");

  const result = {
    title: cleanText(article.headline || $("meta[property='og:title']").attr("content") || $("title").text()) || url,
    byline: normalizeAuthor(article.author),
    excerpt: cleanText(article.description || $("meta[name='description']").attr("content")),
    content: paragraphs,
    publishedAt: parseDate(article.datePublished || article.dateCreated || article.dateModified) || fallbackPublishedAt,
    textContent: text,
    length: text.length,
    url
  };

  validateArticle(result, diagnostics, "json-ld");
  result.diagnostics = {
    ...diagnostics,
    parser: "json-ld"
  };
  return result;
}

function extractHeuristicArticle(url, html, fallbackPublishedAt, diagnostics = {}) {
  const $ = require("cheerio").load(html);
  removeCheerioNoise($);

  const selectors = [
    "main article",
    "article",
    "[data-testid='BodyWrapper']",
    "[data-testid='ArticleBody']",
    "[data-testid='article-body']",
    ".article__body",
    ".article-body",
    ".body__inner-container",
    ".body__content",
    ".content__article-body",
    ".story-body",
    ".post-content",
    ".entry-content",
    ".c-entry-content",
    "[class*='ArticleBody']",
    "[class*='articleBody']",
    "[class*='article-body']"
  ];

  const blocks = [];
  for (const selector of selectors) {
    let matches = 0;
    $(selector).each((_, element) => {
      matches += 1;
      const node = $(element);
      const paragraphs = extractParagraphs($, node);
      const text = cleanText(paragraphs.map((paragraph) => paragraph.text).join(" "));
      if (text.length >= MIN_TEXT_LENGTH / 2) {
        blocks.push({
          selector,
          text,
          paragraphs,
          length: text.length,
          domIndex: domOrderIndex(node)
        });
      }
    });
    if (matches) {
      diagnostics.selectorMatches.push({
        parser: "heuristic",
        selector,
        matches
      });
    }
  }

  const merged = mergeContentBlocks(blocks);
  if (!merged || merged.text.length < MIN_TEXT_LENGTH) return null;
  diagnostics.containersFound = Math.max(diagnostics.containersFound || 0, blocks.length);
  diagnostics.primarySelector = merged.primarySelector || blocks[0]?.selector || null;
  diagnostics.nodesExtracted = Math.max(diagnostics.nodesExtracted || 0, merged.paragraphs.length);

  const title = cleanText(
    $("meta[property='og:title']").attr("content") ||
      $("meta[name='twitter:title']").attr("content") ||
      $("h1").first().text() ||
      $("title").text()
  );
  const byline = cleanText(
    $("[rel='author']").first().text() ||
      $("[class*='byline']").first().text() ||
      $("[data-testid*='Byline']").first().text()
  );
  const content = merged.paragraphs
    .filter((paragraph) => paragraph.text.length > 30)
    .map((paragraph) => paragraph.html || `<p>${escapeHtml(paragraph.text)}</p>`)
    .join("");

  const result = {
    title: title || url,
    byline,
    excerpt: cleanText($("meta[name='description']").attr("content") || $("meta[property='og:description']").attr("content")),
    content,
    publishedAt: fallbackPublishedAt,
    textContent: merged.text,
    length: merged.text.length,
    url
  };

  validateArticle(result, diagnostics, "heuristic");
  result.diagnostics = {
    ...diagnostics,
    parser: "heuristic",
    containersFound: blocks.length,
    usedMergedBlocks: blocks.length > 1
  };
  return result;
}

function extractMergedArticle(url, html, fallbackPublishedAt, diagnostics = {}) {
  const $ = require("cheerio").load(html);
  removeCheerioNoise($);
  const candidates = [
    "article",
    "main",
    "[role='main']",
    ".post-content",
    ".article-body",
    ".entry-content",
    ".story-body",
    ".content__article-body",
    ".body__content",
    ".body__inner-container"
  ];

  const blocks = [];
  for (const selector of candidates) {
    $(selector).each((_, element) => {
      const node = $(element);
      const paragraphs = extractParagraphs($, node);
      const text = cleanText(paragraphs.map((paragraph) => paragraph.text).join(" "));
      if (text.length >= MIN_TEXT_LENGTH / 2) {
        blocks.push({
          selector,
          text,
          paragraphs,
          length: text.length,
          domIndex: domOrderIndex(node)
        });
      }
    });
  }

  const merged = mergeContentBlocks(blocks);
  if (!merged || merged.text.length < MIN_TEXT_LENGTH) return null;
  diagnostics.containersFound = Math.max(diagnostics.containersFound || 0, blocks.length);
  diagnostics.primarySelector = merged.primarySelector || blocks[0]?.selector || null;
  diagnostics.nodesExtracted = Math.max(diagnostics.nodesExtracted || 0, merged.paragraphs.length);

  const title = cleanText(
    $("meta[property='og:title']").attr("content") ||
      $("meta[name='twitter:title']").attr("content") ||
      $("h1").first().text() ||
      $("title").text()
  );
  const byline = cleanText(
    $("[rel='author']").first().text() ||
      $("[class*='byline']").first().text() ||
      $("[data-testid*='Byline']").first().text()
  );
  const content = merged.paragraphs
    .filter((paragraph) => paragraph.text.length > 30)
    .map((paragraph) => paragraph.html || `<p>${escapeHtml(paragraph.text)}</p>`)
    .join("");

  const result = {
    title: title || url,
    byline,
    excerpt: cleanText($("meta[name='description']").attr("content") || $("meta[property='og:description']").attr("content")),
    content,
    publishedAt: fallbackPublishedAt,
    textContent: merged.text,
    length: merged.text.length,
    url
  };

  validateArticle(result, diagnostics, "merged-heuristic");
  result.diagnostics = {
    ...diagnostics,
    parser: "merged-heuristic",
    containersFound: blocks.length,
    usedMergedBlocks: blocks.length > 1
  };
  return result;
}

function withDiagnostics(article, diagnostics) {
  article.content = sanitizeArticleHtml(article.content, article.url);
  const quality = evaluateExtractionQuality(article);
  article.diagnostics = {
    ...diagnostics,
    parser: article.diagnostics?.parser || diagnostics.parser,
    quality
  };
  return article;
}

function removeCheerioNoise($) {
  $(
    [
      "script",
      "style",
      "noscript",
      "iframe",
      "aside",
      "nav",
      "footer",
      "[class*='advert']",
      "[class*='paywall']",
      "[class*='modal']",
      "[class*='newsletter']",
      "[class*='related']",
      "[class*='recommend']",
      "[id*='advert']",
      "[id*='paywall']",
      "[id*='modal']"
    ].join(",")
  ).remove();
}

function extractParagraphs($, node) {
  const paragraphs = [];
  node.find("p, h2, h3, blockquote, li").each((_, element) => {
    const child = $(element);
    const text = cleanText(child.text());
    if (!text || isBoilerplateText(text)) return;
    paragraphs.push({
      text,
      html: $.html(child)
    });
  });

  if (paragraphs.length) return paragraphs;

  return cleanText(node.text())
    .split(/\n{2,}|(?<=\.|\?|!|。|？|！)\s+(?=[A-Z"“])/)
    .map((text) => cleanText(text))
    .filter((text) => text.length > 40 && !isBoilerplateText(text))
    .map((text) => ({
      text,
      html: `<p>${escapeHtml(text)}</p>`
    }));
}

function mergeContentBlocks(blocks = []) {
  const sorted = [...blocks]
    .filter((block) => block?.text?.length)
    .sort((a, b) => a.domIndex - b.domIndex || b.length - a.length);
  if (!sorted.length) return null;

  const seen = new Set();
  const paragraphs = [];
  const pieces = [];

  for (const block of sorted) {
    const signature = block.text.slice(0, 120);
    if (seen.has(signature)) continue;
    seen.add(signature);
    pieces.push(block.text);
    for (const paragraph of block.paragraphs || []) {
      const paragraphKey = paragraph.text.slice(0, 120);
      if (seen.has(paragraphKey)) continue;
      seen.add(paragraphKey);
      paragraphs.push(paragraph);
    }
  }

  return {
    text: cleanText(pieces.join(" ")),
    paragraphs,
    primarySelector: sorted[0]?.selector || null
  };
}

function domOrderIndex(node) {
  try {
    const el = node.get(0);
    if (!el || !el.ownerDocument) return Number.MAX_SAFE_INTEGER;
    const walker = el.ownerDocument.createTreeWalker(el.ownerDocument.body || el.ownerDocument.documentElement, 1);
    let index = 0;
    while (walker.nextNode()) {
      if (walker.currentNode === el) return index;
      index += 1;
    }
  } catch {
    // Ignore and fall back.
  }
  return Number.MAX_SAFE_INTEGER;
}

function isBoilerplateText(text) {
  return /subscribe|sign in|newsletter|cookie|advertisement|privacy policy|all rights reserved/i.test(text);
}

function parseJsonLd(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function flattenJsonLd(item) {
  if (!item || typeof item !== "object") return [];
  const graph = Array.isArray(item["@graph"]) ? item["@graph"] : [];
  return [item, ...graph.flatMap((entry) => flattenJsonLd(entry))];
}

function normalizeAuthor(author) {
  if (!author) return "";
  if (typeof author === "string") return cleanText(author);
  if (Array.isArray(author)) return author.map(normalizeAuthor).filter(Boolean).join(", ");
  return cleanText(author.name || "");
}

function removeKnownNoise(document) {
  const selectors = [
    "script",
    "style",
    "noscript",
    "iframe",
    "[class*='cookie']",
    "[id*='cookie']",
    "[class*='banner']",
    "[id*='banner']",
    "[class*='subscribe']",
    "[id*='subscribe']",
    "[class*='newsletter']",
    "[id*='newsletter']",
    "[class*='paywall']",
    "[id*='paywall']",
    "[class*='modal']",
    "[id*='modal']",
    "[class*='advert']",
    "[id*='advert']",
    "[class*='recommend']",
    "[id*='recommend']",
    "[class*='related']",
    "[id*='related']",
    "[class*='social']",
    "[id*='social']",
    "[aria-label*='advertisement' i]",
    "aside",
    "nav",
    "footer"
  ];

  for (const element of document.querySelectorAll(selectors.join(","))) {
    element.remove();
  }
}

function normalizeMedia(document) {
  for (const img of document.querySelectorAll("img")) {
    img.removeAttribute("width");
    img.removeAttribute("height");
    img.removeAttribute("style");
    const dataSrc = img.getAttribute("data-src") || img.getAttribute("data-original") || img.getAttribute("data-lazy-src");
    if (dataSrc && !img.getAttribute("src")) {
      img.setAttribute("src", dataSrc);
    }
  }
}

function extractPublishedAt(html) {
  const $ = require("cheerio").load(html);
  const candidates = [
    $("meta[property='article:published_time']").attr("content"),
    $("meta[name='article:published_time']").attr("content"),
    $("meta[name='pubdate']").attr("content"),
    $("meta[name='publishdate']").attr("content"),
    $("time[datetime]").first().attr("datetime"),
    $("time").first().text()
  ].filter(Boolean);

  for (const candidate of candidates) {
    const time = Date.parse(candidate);
    if (!Number.isNaN(time)) {
      return new Date(time).toISOString();
    }
  }

  return null;
}

function stripHtml(html = "") {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function cleanText(text = "") {
  return String(text).replace(/\s+/g, " ").trim();
}

function parseDate(value) {
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function safeHost(url = "") {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

function getMinTextLength(url = "") {
  return DOMAIN_MIN_TEXT_LENGTH[safeHost(url)] || MIN_TEXT_LENGTH;
}

function escapeHtml(text = "") {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

module.exports = {
  discoverArticleVariants,
  extractReaderArticle,
  isSafeArticleUrl,
  _extractFromHtml: extractFromHtml
};
