const fs = require("node:fs/promises");
const path = require("node:path");
const { readChromeBookmarks } = require("./bookmarks");
const { writeJsonAtomic } = require("./jsonFile");
const { normalizeHttpUrl } = require("./inputValidation");

const EMPTY_SOURCES = {
  sites: [],
  importedChromeAt: null
};

class SiteStore {
  constructor(userDataPath) {
    this.filePath = path.join(userDataPath, "sites.json");
    this.operationPromise = Promise.resolve();
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const data = { ...EMPTY_SOURCES, ...JSON.parse(raw) };
      const migrated = migrateData(data);
      if (migrated.changed) {
        await this.save(migrated.data);
      }
      return migrated.data;
    } catch (error) {
      if (error.code === "ENOENT") {
        const data = structuredClone(EMPTY_SOURCES);
        await this.save(data);
        return data;
      }
      throw error;
    }
  }

  async save(data) {
    await writeJsonAtomic(this.filePath, data);
  }

  async listSites() {
    const data = await this.load();
    return data.sites;
  }

  async listActiveSites() {
    const sites = await this.listSites();
    return sites.filter((site) => !site.paused);
  }

  async getSite(siteId) {
    const sites = await this.listSites();
    const site = sites.find((item) => item.id === siteId);
    if (!site) throw new Error("Site not found");
    return site;
  }

  async importChromeBookmarks() {
    const bookmarks = await readChromeBookmarks();
    return this.mutate((data) => {
      const existingUrls = new Set(data.sites.map((site) => normalizeUrl(site.url)));
      const importedSites = [];

      for (const site of bookmarks.sites) {
        const normalized = normalizeUrl(site.url);
        if (!normalized || existingUrls.has(normalized)) continue;
        importedSites.push({
          ...site,
          url: normalized,
          domain: getDomain(normalized),
          folderPath: normalizeFolderPath(site.folderPath),
          articleSources: guessDefaultSources(normalized),
          source: "chrome-bookmark",
          paused: false,
          createdAt: new Date().toISOString()
        });
        existingUrls.add(normalized);
      }

      data.sites.push(...importedSites);
      data.importedChromeAt = new Date().toISOString();
      return {
        ...bookmarks,
        importedCount: importedSites.length,
        totalSites: data.sites.length
      };
    });
  }

  async addSite({ title, url, folderPath, feedUrl }) {
    const normalized = normalizeUrl(url);
    if (!normalized) throw new Error("Invalid URL");
    return this.mutate((data) => {
      const existing = data.sites.find((site) => normalizeUrl(site.url) === normalized);
      if (existing) return existing;
      const site = {
        id: stableSiteId(normalized),
        title: title?.trim() || getDomain(normalized),
        url: normalized,
        domain: getDomain(normalized),
        folderPath: normalizeFolderPath(folderPath || "Manual"),
        articleSources: feedUrl ? [{ type: "feed", url: normalizeUrl(feedUrl), title: "Manual feed" }] : guessDefaultSources(normalized),
        source: "manual",
        paused: false,
        createdAt: new Date().toISOString()
      };
      data.sites.push(site);
      return site;
    });
  }

  async updateSite(siteId, patch) {
    return this.mutate((data) => {
      const site = data.sites.find((item) => item.id === siteId);
      if (!site) throw new Error("Site not found");
      if (typeof patch.title === "string") site.title = patch.title.trim() || site.title;
      if (typeof patch.paused === "boolean") site.paused = patch.paused;
      if (typeof patch.folderPath === "string") site.folderPath = normalizeFolderPath(patch.folderPath);
      return site;
    });
  }

  async addArticleSource(siteId, { type = "feed", url, title }) {
    const normalized = normalizeUrl(url);
    if (!normalized) throw new Error("Invalid article source URL");
    return this.mutate((data) => {
      const site = data.sites.find((item) => item.id === siteId);
      if (!site) throw new Error("Site not found");
      site.articleSources = site.articleSources || [];
      if (!site.articleSources.some((source) => source.url === normalized)) {
        site.articleSources.push({
          type,
          url: normalized,
          title: title?.trim() || normalized,
          createdAt: new Date().toISOString()
        });
      }
      return site;
    });
  }

  async deleteArticleSource(siteId, sourceUrl) {
    return this.mutate((data) => {
      const site = data.sites.find((item) => item.id === siteId);
      if (!site) throw new Error("Site not found");
      site.articleSources = (site.articleSources || []).filter((source) => source.url !== sourceUrl);
      return site;
    });
  }

  async getTree() {
    const sites = await this.listSites();
    const folders = new Map();
    for (const site of sites) {
      const folderName = normalizeFolderPath(site.folderPath || "Unfiled");
      if (!folders.has(folderName)) {
        folders.set(folderName, { name: folderName, sites: [] });
      }
      folders.get(folderName).sites.push(site);
    }
    return [...folders.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async deleteSite(siteId) {
    return this.mutate((data) => {
      data.sites = data.sites.filter((site) => site.id !== siteId);
      return data.sites;
    });
  }

  async mutate(mutator) {
    const operation = this.operationPromise.catch(() => {}).then(async () => {
      const data = await this.load();
      const result = await mutator(data);
      await this.save(data);
      return result;
    });
    this.operationPromise = operation.catch(() => {});
    return operation;
  }
}

function normalizeUrl(url) {
  try {
    return normalizeHttpUrl(url);
  } catch {
    return "";
  }
}

function stableSiteId(url) {
  return Buffer.from(url).toString("base64url");
}

function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function normalizeFolderPath(folderPath = "Unfiled") {
  const firstFolder = String(folderPath)
    .replace(/^书签栏\/?/u, "")
    .split("/")
    .filter(Boolean)[0] || "Unfiled";

  const labels = {
    english: "English",
    fashion: "Fashion",
    "literary award": "Literary Awards",
    manual: "Library",
    unfiled: "Library"
  };
  return labels[firstFolder.toLowerCase()] || titleCase(firstFolder);
}

function guessDefaultSources(url) {
  try {
    const knownSources = getKnownArticleSources(url);
    if (knownSources.length) return knownSources;
    return [
      { type: "feed", url: new URL("/feed", url).toString(), title: "Default feed" },
      { type: "feed", url: new URL("/rss", url).toString(), title: "RSS" },
      { type: "sitemap", url: new URL("/sitemap.xml", url).toString(), title: "Default sitemap" }
    ];
  } catch {
    return [];
  }
}

function migrateData(data) {
  let changed = false;
  const sites = (data.sites || []).map((site) => {
    const next = { ...site };
    const folderPath = normalizeFolderPath(next.folderPath || "Library");
    if (folderPath !== next.folderPath) {
      next.folderPath = folderPath;
      changed = true;
    }

    if (!next.domain) {
      next.domain = getDomain(next.url);
      changed = true;
    }

    const existingSources = Array.isArray(next.articleSources) ? next.articleSources : [];
    const knownSources = getKnownArticleSources(next.url);
    const fallbackSources = existingSources.length ? [] : guessDefaultSources(next.url);
    const mergedSources = mergeArticleSources([...knownSources, ...existingSources, ...fallbackSources]);

    if (JSON.stringify(mergedSources) !== JSON.stringify(existingSources)) {
      next.articleSources = mergedSources;
      changed = true;
    }

    if (isUtilitySource(next.url) && !next.paused) {
      next.paused = true;
      changed = true;
    }

    return next;
  });

  return {
    changed,
    data: {
      ...data,
      sites
    }
  };
}

function mergeArticleSources(sources) {
  const byUrl = new Map();
  for (const source of sources) {
    const normalized = normalizeUrl(source.url);
    if (!normalized || byUrl.has(normalized)) continue;
    byUrl.set(normalized, {
      type: source.type || "feed",
      url: normalized,
      title: source.title || source.type || "Article source"
    });
  }
  return [...byUrl.values()];
}

function getKnownArticleSources(url) {
  const domain = getDomain(url);
  const known = {
    "newyorker.com": [
      ["feed", "https://www.newyorker.com/feed/magazine/reporting/rss", "Reporting & Essays"],
      ["feed", "https://www.newyorker.com/feed/magazine/rss", "Magazine Articles"],
      ["feed", "https://www.newyorker.com/feed/culture/rss", "Books & Culture"],
      ["feed", "https://www.newyorker.com/feed/news/rss", "News"]
    ],
    "theatlantic.com": [
      ["feed", "https://www.theatlantic.com/feed/all/", "All articles"],
      ["feed", "https://www.theatlantic.com/feed/channel/world/", "World"]
    ],
    "wired.com": [["feed", "https://www.wired.com/feed/rss", "Latest"]],
    "vogue.com": [["feed", "https://www.vogue.com/feed/rss", "Latest"]],
    "gq.com": [["feed", "https://www.gq.com/feed/rss", "Latest"]],
    "vanityfair.com": [["feed", "https://www.vanityfair.com/feed/rss", "Latest"]],
    "nybooks.com": [["feed", "https://www.nybooks.com/feed/", "Latest"]],
    "harpers.org": [["feed", "https://harpers.org/feed/", "Latest"]],
    "aeon.co": [["feed", "https://aeon.co/feed.rss", "Latest"]],
    "slate.com": [["feed", "https://slate.com/feeds/all.rss", "Latest"]],
    "salon.com": [["feed", "https://www.salon.com/feed/", "Latest"]],
    "npr.org": [["feed", "https://feeds.npr.org/1001/rss.xml", "News"]],
    "granta.com": [["feed", "https://granta.com/feed/", "Latest"]],
    "lrb.co.uk": [["feed", "https://www.lrb.co.uk/feeds/rss", "Latest"]],
    "theparisreview.org": [["feed", "https://www.theparisreview.org/blog/feed/", "Latest"]],
    "worldliteraturetoday.org": [["feed", "https://worldliteraturetoday.org/feed", "Latest"]],
    "kenyonreview.org": [["feed", "https://kenyonreview.org/feed/", "Latest"]],
    "agnionline.bu.edu": [["feed", "https://agnionline.bu.edu/feed/", "Latest"]],
    "bombmagazine.org": [["feed", "https://bombmagazine.org/feed/", "Latest"]],
    "pshares.org": [["feed", "https://pshares.org/feed/", "Latest"]],
    "tinhouse.com": [["feed", "https://tinhouse.com/feed/", "Latest"]],
    "mcsweeneys.net": [["feed", "https://www.mcsweeneys.net/feeds/daily", "Latest"]],
    "thebookerprizes.com": [["feed", "https://thebookerprizes.com/rss.xml", "Latest"]],
    "pulitzer.org": [["feed", "https://www.pulitzer.org/news.xml", "News"]],
    "nationalbook.org": [["feed", "https://www.nationalbook.org/feed/", "Latest"]]
  };

  return (known[domain] || []).map(([type, sourceUrl, title]) => ({
    type,
    url: sourceUrl,
    title
  }));
}

function isUtilitySource(url) {
  const domain = getDomain(url);
  const path = (() => {
    try {
      return new URL(url).pathname.toLowerCase();
    } catch {
      return "";
    }
  })();

  return (
    domain === "archive.ph" ||
    domain === "github.com" ||
    domain.includes("magdownload") ||
    domain.includes("freemagazines") ||
    domain.includes("pdfmagazines") ||
    domain.includes("worldmags") ||
    domain.includes("vocabulary.com") ||
    domain.includes("oxfordlearnersdictionaries.com") ||
    domain.includes("thefreedictionary.com") ||
    path.includes("/offers/") ||
    path.includes("/subscription")
  );
}

function titleCase(value) {
  return String(value)
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

module.exports = {
  SiteStore
};
