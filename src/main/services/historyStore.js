const fs = require("node:fs/promises");
const path = require("node:path");
const { writeJsonAtomic } = require("./jsonFile");

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
    const history = await this.load();
    history.readArticles.unshift({
      siteId: site.id,
      siteTitle: site.title,
      siteUrl: site.url,
      articleTitle: article.title,
      articleUrl: article.url,
      readAt: new Date().toISOString()
    });
    history.readArticles = history.readArticles.slice(0, 1000);
    await this.save(history);
    return history;
  }

  async markOpened(site, article) {
    const history = await this.load();
    history.openedArticles = history.openedArticles || [];
    if (!history.openedArticles.some((item) => item.articleUrl === article.url)) {
      history.openedArticles.unshift({
        siteId: site.id,
        siteTitle: site.title,
        siteUrl: site.url,
        articleTitle: article.title,
        articleUrl: article.url,
        openedAt: new Date().toISOString()
      });
    }
    history.openedArticles = history.openedArticles.slice(0, 2000);
    await this.save(history);
    return history;
  }

  async markSiteVisited(site) {
    const history = await this.load();
    const siteIds = new Set((await this.getCurrentActiveSiteIds()).length ? await this.getCurrentActiveSiteIds() : [site.id]);
    let usedSiteIds = (history.siteRound?.usedSiteIds || []).filter((id) => siteIds.has(id));

    if (!usedSiteIds.includes(site.id)) {
      usedSiteIds.push(site.id);
    }

    history.siteRound = { usedSiteIds };
    await this.save(history);
    return history;
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

module.exports = {
  HistoryStore,
  randomItem
};
