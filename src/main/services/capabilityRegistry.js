const { getRequestCost } = require("./requestCostModel");
const { discoverArticleCandidatesResult } = require("./articleDiscoveryPipeline");
const { discoverArticlesWithBrowser } = require("./browserArticleDiscovery");
const { resultFromArticles } = require("./capabilityContract");

const CAPABILITIES = [
  {
    name: "feed-sitemap",
    stage: "feed",
    priority: 10,
    supportedDomains: ["*"],
    estimatedCost: getRequestCost("feed"),
    antiBotRisk: "low",
    retryPolicy: {
      maxRetries: 1,
      retryableFailures: ["timeout", "network_error"]
    }
  },
  {
    name: "sitemap",
    stage: "sitemap",
    priority: 20,
    supportedDomains: ["*"],
    estimatedCost: getRequestCost("sitemap"),
    antiBotRisk: "low",
    retryPolicy: {
      maxRetries: 1,
      retryableFailures: ["timeout", "network_error"]
    }
  },
  {
    name: "browser",
    stage: "browser",
    priority: 90,
    supportedDomains: ["*"],
    estimatedCost: getRequestCost("browser"),
    antiBotRisk: "high",
    retryPolicy: {
      maxRetries: 0,
      retryableFailures: []
    }
  },
  {
    name: "archive",
    stage: "archive",
    priority: 100,
    supportedDomains: ["*"],
    estimatedCost: getRequestCost("archive"),
    antiBotRisk: "high",
    retryPolicy: {
      maxRetries: 0,
      retryableFailures: ["timeout"]
    }
  }
];

class CapabilityRegistry {
  constructor(capabilities = CAPABILITIES) {
    this.capabilities = capabilities;
  }

  list({ domain = "" } = {}) {
    return this.capabilities
      .filter((capability) => supportsDomain(capability, domain))
      .sort((a, b) => a.priority - b.priority);
  }

  get(name) {
    return this.capabilities.find((capability) => capability.name === name) || null;
  }

  getForStage(stageName) {
    const capabilityName = stageName === "feed-sitemap" ? "feed-sitemap" : stageName;
    return this.get(capabilityName);
  }

  getHandler(name) {
    return HANDLERS[name] || null;
  }
}

function supportsDomain(capability, domain) {
  if (!domain) return true;
  return capability.supportedDomains.includes("*") || capability.supportedDomains.some((item) => domain === item || domain.endsWith(`.${item}`));
}

module.exports = {
  CapabilityRegistry,
  CAPABILITIES
};

const HANDLERS = {
  "feed-sitemap": async ({ context, input }) => {
    return discoverArticleCandidatesResult(context.site, input.limit, {
      traceId: context.traceId,
      strategySource: context.strategySource
    });
  },
  browser: async ({ context, input }) => {
    const startedAt = Date.now();
    const articles = await discoverArticlesWithBrowser(context.site, input.limit, {
      traceId: context.traceId,
      strategySource: context.strategySource || "browser-fallback",
      fallbackReason: "structured_sources_empty"
    });
    return resultFromArticles({
      capabilityName: "browser",
      stage: "browser",
      strategySource: context.strategySource || "browser-fallback",
      articles,
      url: context.site.url,
      duration: Date.now() - startedAt,
      trace: {
        traceId: context.traceId
      },
      fallbackReason: "browser_discovery_returned_no_article_candidates"
    });
  }
};
