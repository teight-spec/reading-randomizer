const fs = require("node:fs/promises");
const path = require("node:path");
const { writeJsonAtomic } = require("./jsonFile");

const EMPTY_HEALTH = {
  version: 1,
  sites: {}
};
const MAX_EVENTS = 80;

class SiteHealthStore {
  constructor(userDataPath) {
    this.filePath = path.join(userDataPath, "site-health.json");
    this.writePromise = Promise.resolve();
    this.operationPromise = Promise.resolve();
  }

  async load() {
    await this.writePromise.catch(() => {});
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return { ...structuredClone(EMPTY_HEALTH), ...JSON.parse(raw) };
    } catch (error) {
      if (error.code === "ENOENT") return structuredClone(EMPTY_HEALTH);
      throw error;
    }
  }

  async save(data) {
    this.writePromise = this.writePromise.catch(() => {}).then(() => writeJsonAtomic(this.filePath, data));
    return this.writePromise;
  }

  async getSiteHealth(site) {
    const data = await this.load();
    return data.sites[siteKey(site)] || createEmptyHealth(site);
  }

  async record(site, event) {
    const operation = this.operationPromise.catch(() => {}).then(async () => {
      const data = await this.load();
      const key = siteKey(site);
      const current = data.sites[key] || createEmptyHealth(site);
      current.domain = domainFor(site);
      current.siteId = site.id || current.siteId;
      current.siteTitle = site.title || current.siteTitle;
      current.events = [
        {
          stageName: event.stageName || "unknown",
          ok: Boolean(event.ok),
          latencyMs: Number(event.latencyMs || 0),
          strategySource: event.strategySource || "generic",
          failureCategory: event.failureCategory || null,
          fallbackReason: event.fallbackReason || null,
          parserUsed: event.parserUsed || null,
          qualityScore: event.qualityScore ?? null,
          cost: event.cost ?? null,
          antiBotType: event.antiBotType || null,
          traceId: event.traceId || null,
          at: new Date().toISOString()
        },
        ...(current.events || [])
      ].slice(0, MAX_EVENTS);
      recompute(current);
      data.sites[key] = current;
      await this.save(data);
      return current;
    });
    this.operationPromise = operation.catch(() => {});
    return operation;
  }
}

function createEmptyHealth(site) {
  return {
    siteId: site.id || null,
    siteTitle: site.title || "",
    domain: domainFor(site),
    successRate: null,
    feedSuccessRate: null,
    sitemapSuccessRate: null,
    articleSuccessRate: null,
    browserSuccessRate: null,
    archiveSuccessRate: null,
    botBlockedRate: null,
    avgQualityScore: null,
    avgRequestCost: null,
    avgLatency: null,
    lastSuccessfulStrategy: null,
    lastFailureCategory: null,
    lastUpdated: null,
    events: []
  };
}

function recompute(health) {
  const events = health.events || [];
  const successes = events.filter((event) => event.ok);
  const failures = events.filter((event) => !event.ok);
  health.successRate = ratio(successes.length, events.length);
  health.feedSuccessRate = stageRatio(events, "feed");
  health.sitemapSuccessRate = stageRatio(events, "sitemap");
  health.articleSuccessRate = stageRatio(events, "article");
  health.browserSuccessRate = stageRatio(events, "browser");
  health.archiveSuccessRate = stageRatio(events, "archive");
  health.botBlockedRate = ratio(events.filter((event) => event.failureCategory === "blocked_by_bot").length, events.length);
  health.avgQualityScore = average(events.map((event) => event.qualityScore).filter((value) => Number.isFinite(value)));
  health.avgRequestCost = average(events.map((event) => event.cost).filter((value) => Number.isFinite(value)));
  health.avgLatency = events.length
    ? Math.round(events.reduce((sum, event) => sum + Number(event.latencyMs || 0), 0) / events.length)
    : null;
  health.lastSuccessfulStrategy = successes[0]?.stageName || health.lastSuccessfulStrategy || null;
  health.lastFailureCategory = failures[0]?.failureCategory || null;
  health.lastUpdated = new Date().toISOString();
}

function average(values) {
  return values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2)) : null;
}

function stageRatio(events, stageName) {
  const stageEvents = events.filter((event) => event.stageName === stageName);
  return ratio(stageEvents.filter((event) => event.ok).length, stageEvents.length);
}

function ratio(part, total) {
  return total ? Number((part / total).toFixed(2)) : null;
}

function siteKey(site) {
  return site.id || domainFor(site);
}

function domainFor(site) {
  if (site.domain) return site.domain;
  try {
    return new URL(site.url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

module.exports = {
  SiteHealthStore
};
