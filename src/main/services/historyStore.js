const fs = require("node:fs/promises");
const path = require("node:path");
const { writeJsonAtomic } = require("./jsonFile");
const { calendarDayDiff, dayKey, SKIP_COOLDOWN_DAYS } = require("./readingLoopState");

const EMPTY_HISTORY = {
  openedArticles: [],
  readArticles: [],
  siteRound: {
    usedSiteIds: []
  }
};

class HistoryStore {
  constructor(userDataPath) {
    this.filePath = path.join(userDataPath, "reading-history.json");
    this.operationPromise = Promise.resolve();
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return { ...EMPTY_HISTORY, ...JSON.parse(raw) };
    } catch (error) {
      if (error.code === "ENOENT") {
        return structuredClone(EMPTY_HISTORY);
      }
      throw error;
    }
  }

  async save(history) {
    await writeJsonAtomic(this.filePath, history);
  }

  async markRead(site, article) {
    return this.mutate((history) => {
      history.readArticles.unshift({
        siteId: site.id,
        siteTitle: site.title,
        siteUrl: site.url,
        articleTitle: article.title,
        articleUrl: article.url,
        readAt: new Date().toISOString()
      });
      history.readArticles = history.readArticles.slice(0, 1000);
      return history;
    });
  }

  async unmarkOpened(articleUrl) {
    return this.mutate((history) => {
      const url = String(articleUrl || "");
      history.openedArticles = (history.openedArticles || []).filter((item) => item.articleUrl !== url);
      return history;
    });
  }

  async markOpened(site, article, now = Date.now()) {
    return this.mutate((history) => {
      history.openedArticles = history.openedArticles || [];
      const openedAt = new Date(now).toISOString();
      const existing = history.openedArticles.find((item) => item.articleUrl === article.url);
      if (existing) {
        existing.openedAt = openedAt;
        history.openedArticles = [
          existing,
          ...history.openedArticles.filter((item) => item.articleUrl !== article.url)
        ];
      } else {
        history.openedArticles.unshift({
          siteId: site.id,
          siteTitle: site.title,
          siteUrl: site.url,
          articleTitle: article.title,
          articleUrl: article.url,
          openedAt
        });
      }
      history.openedArticles = history.openedArticles.slice(0, 2000);
      return history;
    });
  }

  async markSiteVisited(site) {
    return this.mutate(async (history) => {
      const activeSiteIds = await this.getCurrentActiveSiteIds();
      const siteIds = new Set(activeSiteIds.length ? activeSiteIds : [site.id]);
      const usedSiteIds = (history.siteRound?.usedSiteIds || []).filter((id) => siteIds.has(id));
      if (!usedSiteIds.includes(site.id)) usedSiteIds.push(site.id);
      history.siteRound = { usedSiteIds };
      return history;
    });
  }

  setActiveSiteIds(siteIds) {
    this.activeSiteIds = siteIds;
  }

  async getCurrentActiveSiteIds() {
    return this.activeSiteIds || [];
  }

  async chooseUnusedSite(sites) {
    const history = await this.load();
    const siteIds = new Set(sites.map((site) => site.id));
    let usedSiteIds = (history.siteRound?.usedSiteIds || []).filter((id) => siteIds.has(id));

    if (usedSiteIds.length >= sites.length) {
      usedSiteIds = [];
    }

    const usedSet = new Set(usedSiteIds);
    const candidates = sites.filter((site) => !usedSet.has(site.id));
    const selected = randomItem(candidates.length ? candidates : sites);

    if (!selected) {
      return null;
    }

    return selected;
  }

  async chooseUnusedSites(sites, count) {
    const history = await this.load();
    const siteIds = new Set(sites.map((site) => site.id));
    let usedSiteIds = (history.siteRound?.usedSiteIds || []).filter((id) => siteIds.has(id));

    if (usedSiteIds.length >= sites.length) {
      usedSiteIds = [];
    }

    const usedSet = new Set(usedSiteIds);
    const candidates = shuffle(sites.filter((site) => !usedSet.has(site.id)));
    return candidates.slice(0, Math.max(1, count));
  }

  async mutate(mutator) {
    const operation = this.operationPromise.catch(() => {}).then(async () => {
      const history = await this.load();
      const result = await mutator(history);
      await this.save(history);
      return result;
    });
    this.operationPromise = operation.catch(() => {});
    return operation;
  }
}

function randomItem(items) {
  if (!items.length) {
    return null;
  }
  return items[Math.floor(Math.random() * items.length)];
}

function shuffle(items) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function urlsWithinOpenedCooldown(items, now = Date.now(), cooldownDays = SKIP_COOLDOWN_DAYS, atKey = "openedAt") {
  const today = dayKey(now);
  const urls = [];
  for (const item of items || []) {
    if (!item?.articleUrl) continue;
    const raw = item[atKey] || item.openedAt || item.readAt;
    if (!raw) continue;
    const timestamp = Date.parse(raw);
    if (!Number.isFinite(timestamp)) continue;
    const key = dayKey(timestamp);
    if (calendarDayDiff(key, today) < cooldownDays) urls.push(item.articleUrl);
  }
  return urls;
}

module.exports = {
  HistoryStore,
  randomItem,
  urlsWithinOpenedCooldown
};
