const cheerio = require("cheerio");
const { RequestGovernor } = require("./requestGovernor");
const { detectAntiBot } = require("./antiBot");

const governor = new RequestGovernor({
  minIntervalMs: 1400,
  maxRetries: 1,
  successTtlMs: 6 * 60 * 60 * 1000,
  negativeTtlMs: 60 * 60 * 1000,
  errorTtlMs: 10 * 60 * 1000
});

const FALLBACK_ENDPOINTS = ["/feed", "/rss.xml", "/feed.xml"];

const DiscoveryStatus = Object.freeze({
  FOUND: "FOUND",
  NOT_FOUND: "NOT_FOUND",
  ANTI_BOT: "ANTI_BOT",
  TIMEOUT: "TIMEOUT",
  NETWORK_FAILURE: "NETWORK_FAILURE",
  ABORTED: "ABORTED",
  BLOCKED: "BLOCKED"
});

async function discoverFeedUrls(siteUrl) {
  const result = await discoverFeeds(siteUrl);
  return result.feeds;
}

async function discoverFeeds(siteUrl) {
  const rootUrl = toRootUrl(siteUrl);
  const diagnostics = {
    source: "feed-discovery",
    rootUrl,
    homepageFetched: false,
    alternateLinks: 0,
    fallbackAttempts: [],
    status: DiscoveryStatus.NOT_FOUND,
    resultCount: 0
  };

  let homepageResponse = null;
  let homepageBody = "";
  try {
    homepageResponse = await governor.request(rootUrl, {
      source: "feed-discovery:homepage",
      profile: "browser-document",
      timeoutMs: 12000
    });
    diagnostics.homepageFetched = true;
    homepageBody = homepageResponse.text || "";
  } catch (error) {
    const classification = classifyError(error, null);
    diagnostics.homepageError = classification;
    diagnostics.status = classification.status;
    logFeedDiscovery("homepage_failed", diagnostics);
    if (classification.status === DiscoveryStatus.ANTI_BOT || classification.status === DiscoveryStatus.BLOCKED) {
      return finalizeResult([], diagnostics);
    }
    if (classification.status === DiscoveryStatus.TIMEOUT || classification.status === DiscoveryStatus.ABORTED || classification.status === DiscoveryStatus.NETWORK_FAILURE) {
      return finalizeResult([], diagnostics);
    }
  }

  const homepageAntibot = detectResponseAntiBot(homepageResponse);
  if (homepageAntibot.status) {
    diagnostics.antiBot = homepageAntibot;
    diagnostics.status = homepageAntibot.status;
    logFeedDiscovery("anti_bot_detected", diagnostics);
    return finalizeResult([], diagnostics);
  }

  const homepageFeeds = extractAlternateFeeds(homepageBody, rootUrl);
  if (homepageFeeds.length) {
    diagnostics.alternateLinks = homepageFeeds.length;
    diagnostics.status = DiscoveryStatus.FOUND;
    return finalizeResult(homepageFeeds, diagnostics);
  }

  for (const endpoint of FALLBACK_ENDPOINTS) {
    const fallbackUrl = new URL(endpoint, rootUrl).toString();
    diagnostics.fallbackAttempts.push(endpoint);
    try {
      const response = await governor.request(fallbackUrl, {
        source: "feed-discovery:fallback",
        profile: "feed",
        timeoutMs: 12000
      });
      const responseAntiBot = detectResponseAntiBot(response);
      if (responseAntiBot.status) {
        diagnostics.lastFallbackError = responseAntiBot;
        diagnostics.status = responseAntiBot.status;
        logFeedDiscovery("anti_bot_detected", diagnostics);
        return finalizeResult([], diagnostics);
      }
      if (!response.ok) {
        const blockedStatus = classifyHttpStatus(response.status);
        if (blockedStatus === DiscoveryStatus.BLOCKED) {
          diagnostics.lastFallbackError = {
            status: blockedStatus,
            code: response.status,
            message: `HTTP ${response.status}`
          };
          diagnostics.status = blockedStatus;
          return finalizeResult([], diagnostics);
        }
        continue;
      }
      const feeds = extractFeedLinks(response.text, fallbackUrl);
      if (feeds.length) {
        diagnostics.status = DiscoveryStatus.FOUND;
        return finalizeResult(feeds, diagnostics);
      }
      if (looksLikeFeedDocument(response.text)) {
        diagnostics.status = DiscoveryStatus.FOUND;
        return finalizeResult([fallbackUrl], diagnostics);
      }
    } catch (error) {
      const classification = classifyError(error, fallbackUrl);
      diagnostics.lastFallbackError = classification;
      diagnostics.status = classification.status;
      if (classification.status === DiscoveryStatus.ANTI_BOT || classification.status === DiscoveryStatus.BLOCKED) {
        logFeedDiscovery("anti_bot_detected", diagnostics);
        return finalizeResult([], diagnostics);
      }
      if (classification.status === DiscoveryStatus.TIMEOUT || classification.status === DiscoveryStatus.ABORTED) {
        continue;
      }
    }
  }

  diagnostics.status = diagnostics.status === DiscoveryStatus.NOT_FOUND ? DiscoveryStatus.NOT_FOUND : diagnostics.status;
  return finalizeResult([], diagnostics);
}

function finalizeResult(feeds, diagnostics) {
  const deduped = dedupe(feeds);
  const status = deduped.length ? DiscoveryStatus.FOUND : diagnostics.status || DiscoveryStatus.NOT_FOUND;
  const result = {
    status,
    feeds: deduped,
    diagnostics: {
      ...diagnostics,
      status,
      resultCount: deduped.length
    }
  };
  logFeedDiscovery("feed_discovery_complete", result.diagnostics);
  return result;
}

function detectResponseAntiBot(response) {
  if (!response) return null;
  const detector = detectAntiBot(response);
  if (!detector.antiBot && !detector.blocked) return null;
  if (detector.antiBot) {
    return {
      status: DiscoveryStatus.ANTI_BOT,
      code: response.status,
      indicators: detector.indicators,
      message: "anti-bot challenge detected"
    };
  }
  if (detector.blocked) {
    return {
      status: response.status === 403 ? DiscoveryStatus.BLOCKED : DiscoveryStatus.BLOCKED,
      code: response.status,
      indicators: detector.indicators,
      message: `blocked with HTTP ${response.status}`
    };
  }
  return null;
}

function classifyError(error, url) {
  const kind = error?.kind || (error?.code === "ABORT_ERR" ? "aborted" : error?.code === "ETIMEDOUT" ? "timeout" : "network");
  const mappedStatus =
    kind === "timeout"
      ? DiscoveryStatus.TIMEOUT
      : kind === "aborted"
        ? DiscoveryStatus.ABORTED
        : kind === "blocked"
          ? DiscoveryStatus.BLOCKED
          : DiscoveryStatus.NETWORK_FAILURE;
  return {
    status: mappedStatus,
    code: error?.code || "UNKNOWN",
    url,
    kind,
    message: error?.message || "unknown"
  };
}

function classifyHttpStatus(status) {
  if (status === 401 || status === 403 || status === 429 || status === 451) return DiscoveryStatus.BLOCKED;
  return null;
}

function extractAlternateFeeds(html, baseUrl) {
  const $ = cheerio.load(html);
  return $("link[rel='alternate']")
    .map((_, element) => {
      const type = ($(element).attr("type") || "").toLowerCase();
      const href = $(element).attr("href");
      if (!href || (!type.includes("rss") && !type.includes("atom") && !type.includes("xml"))) return "";
      try {
        return new URL(href, baseUrl).toString();
      } catch {
        return "";
      }
    })
    .get()
    .filter(Boolean);
}

function extractFeedLinks(html, baseUrl) {
  const $ = cheerio.load(html, { xmlMode: true });
  const links = [];
  $("link[rel='alternate'], feed, rss")
    .each((_, element) => {
      const href = $(element).attr("href");
      if (!href) return;
      try {
        links.push(new URL(href, baseUrl).toString());
      } catch {
        // ignore
      }
    });
  return links;
}

function looksLikeFeedDocument(text = "") {
  const value = text.trim();
  if (!value) return false;
  return /<(rss|feed|rdf:RDF)\b/i.test(value) && /<(item|entry)\b/i.test(value);
}

function dedupe(items) {
  return [...new Set(items)];
}

function toRootUrl(siteUrl) {
  const parsed = new URL(siteUrl);
  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function logFeedDiscovery(event, payload) {
  console.info("[feed-discovery]", JSON.stringify({
    event,
    timestamp: Date.now(),
    payload
  }));
}

module.exports = {
  DiscoveryStatus,
  discoverFeeds,
  discoverFeedUrls
};
