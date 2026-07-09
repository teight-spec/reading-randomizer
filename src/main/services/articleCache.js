const fs = require("node:fs/promises");
const path = require("node:path");

const EMPTY_CACHE = {
  version: 1,
  updatedAt: null,
  candidatesBySite: {},
  articlesByUrl: {},
  healthBySite: {}
};
const MAX_ARTICLES = 500;
const CANDIDATE_TTL_MS = 6 * 60 * 60 * 1000;
const EMPTY_CANDIDATE_TTL_MS = 45 * 60 * 1000;
const ARTICLE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

class ArticleCache {
  constructor(userDataPath) {
    this.filePath = path.join(userDataPath, "article-cache.json");
    this.writePromise = Promise.resolve();
    this.operationPromise = Promise.resolve();
    this.recoveryPromise = null;
  }

  async load() {
    await this.writePromise.catch(() => {});
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      validateCacheShape(parsed);
      return normalizeCache(parsed);
    } catch (error) {
      if (error.code === "ENOENT") return structuredClone(EMPTY_CACHE);
      if (error instanceof SyntaxError || error.code === "CACHE_SCHEMA_INVALID") {
        return this.recoverCorruptedCache(error);
      }
      throw error;
    }
  }

  async save(cache) {
    const normalized = normalizeCache(cache);
    normalized.updatedAt = new Date().toISOString();
    prune(normalized);
    const text = JSON.stringify(normalized, null, 2);
    this.writePromise = this.writePromise.catch(() => {}).then(() => this.writeAtomic(text));
    return this.writePromise;
  }

  async getReadyForSite(siteId, readUrls = new Set()) {
    const cache = await this.load();
    const urls = cache.candidatesBySite[siteId]?.items?.map((item) => item.url) || [];
    const ready = urls
      .map((url) => cache.articlesByUrl[url])
      .filter((item) => isReady(item) && !readUrls.has(item.article.url));
    return randomItem(ready);
  }

  async getAnyReady(siteIds, readUrls = new Set()) {
    const shuffledSiteIds = shuffle(siteIds);
    for (const siteId of shuffledSiteIds) {
      const ready = await this.getReadyForSite(siteId, readUrls);
      if (ready) return ready;
    }
    return null;
  }

  async getFreshCandidates(siteId) {
    const cache = await this.load();
    const entry = cache.candidatesBySite[siteId];
    const ttl = entry?.items?.length ? CANDIDATE_TTL_MS : EMPTY_CANDIDATE_TTL_MS;
    if (!entry || Date.now() - Date.parse(entry.fetchedAt || 0) > ttl) {
      return [];
    }
    return entry.items || [];
  }

  async hasFreshCandidateEntry(siteId) {
    const cache = await this.load();
    const entry = cache.candidatesBySite[siteId];
    const ttl = entry?.items?.length ? CANDIDATE_TTL_MS : EMPTY_CANDIDATE_TTL_MS;
    return Boolean(entry && Date.now() - Date.parse(entry.fetchedAt || 0) <= ttl);
  }

  async putCandidates(site, articles) {
    return this.mutate(async (cache) => {
      cache.candidatesBySite[site.id] = {
        siteId: site.id,
        fetchedAt: new Date().toISOString(),
        items: articles.slice(0, 50)
      };
      updateHealth(cache, site, {
        type: articles.length ? "candidates-ready" : "candidate-empty",
        candidateCount: articles.length
      });
    });
  }

  async putReady(site, article, readerArticle) {
    return this.mutate(async (cache) => {
      cache.articlesByUrl[article.url] = {
        status: "ready",
        site,
        article,
        readerArticle,
        diagnostics: readerArticle.diagnostics || null,
        fetchedAt: new Date().toISOString()
      };
      updateHealth(cache, site, {
        type: "extract-success",
        parser: readerArticle.diagnostics?.parser || "unknown",
        textLength: readerArticle.textContent?.length || 0,
        density: readerArticle.diagnostics?.density || null
      });
      return cache.articlesByUrl[article.url];
    });
  }

  async putFailed(site, article, error) {
    return this.mutate(async (cache) => {
      cache.articlesByUrl[article.url] = {
        status: "failed",
        site: { id: site.id, title: site.title, url: site.url, domain: site.domain },
        article,
        error: error.message || String(error),
        diagnostics: error.diagnostics || null,
        fetchedAt: new Date().toISOString()
      };
      updateHealth(cache, site, {
        type: "extract-failure",
        error: error.message || String(error),
        diagnostics: error.diagnostics || null
      });
    });
  }

  async getArticle(url) {
    const cache = await this.load();
    const item = cache.articlesByUrl[url];
    return isReady(item) ? item : null;
  }

  async getHealth() {
    const cache = await this.load();
    return cache.healthBySite || {};
  }

  async mutate(mutator) {
    const operation = this.operationPromise.catch(() => {}).then(async () => {
      const cache = await this.load();
      const result = await mutator(cache);
      await this.save(cache);
      return result;
    });
    this.operationPromise = operation.catch(() => {});
    return operation;
  }

  async recoverCorruptedCache(error) {
    if (this.recoveryPromise) {
      return this.recoveryPromise;
    }
    this.recoveryPromise = this._recoverCorruptedCache(error).finally(() => {
      this.recoveryPromise = null;
    });
    return this.recoveryPromise;
  }

  async _recoverCorruptedCache(error) {
    const backupPath = await this.backupCorruptedCache(error);
    const empty = structuredClone(EMPTY_CACHE);
    try {
      await this.save(empty);
    } catch (writeError) {
      logCache("cache_rebuild_failed", {
        path: this.filePath,
        backupPath,
        error: error.message,
        writeError: writeError.message
      });
      return empty;
    }
    logCache("cache_corruption_recovered", {
      path: this.filePath,
      backupPath,
      error: error.message
    });
    return empty;
  }

  async backupCorruptedCache(error) {
    const backupPath = `${this.filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.rename(this.filePath, backupPath);
      logCache("cache_corruption_detected", {
        path: this.filePath,
        backupPath,
        error: error.message
      });
      return backupPath;
    } catch (backupError) {
      logCache("cache_corruption_backup_failed", {
        path: this.filePath,
        backupPath,
        error: error.message,
        backupError: backupError.message
      });
      return null;
    }
  }

  async writeAtomic(text) {
    const startedAt = Date.now();
    const dir = path.dirname(this.filePath);
    const tempPath = path.join(
      dir,
      `${path.basename(this.filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
    );
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(tempPath, text, "utf8");
    await fs.rename(tempPath, this.filePath);
    logCache("cache_write_complete", {
      path: this.filePath,
      tempPath,
      bytes: Buffer.byteLength(text, "utf8"),
      durationMs: Date.now() - startedAt,
      writtenAt: new Date().toISOString()
    });
  }
}

function normalizeCache(cache = {}) {
  return {
    ...structuredClone(EMPTY_CACHE),
    ...cache,
    candidatesBySite: isPlainObject(cache.candidatesBySite) ? cache.candidatesBySite : {},
    articlesByUrl: isPlainObject(cache.articlesByUrl) ? cache.articlesByUrl : {},
    healthBySite: isPlainObject(cache.healthBySite) ? cache.healthBySite : {}
  };
}

function validateCacheShape(cache) {
  if (!isPlainObject(cache)) throw schemaError("cache root must be an object");
  if (cache.candidatesBySite !== undefined && !isPlainObject(cache.candidatesBySite)) {
    throw schemaError("candidatesBySite must be an object");
  }
  if (cache.articlesByUrl !== undefined && !isPlainObject(cache.articlesByUrl)) {
    throw schemaError("articlesByUrl must be an object");
  }
  if (cache.healthBySite !== undefined && !isPlainObject(cache.healthBySite)) {
    throw schemaError("healthBySite must be an object");
  }
}

function schemaError(message) {
  const error = new Error(message);
  error.code = "CACHE_SCHEMA_INVALID";
  return error;
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isReady(item) {
  return (
    item?.status === "ready" &&
    item.readerArticle?.content &&
    Date.now() - Date.parse(item.fetchedAt || 0) < ARTICLE_TTL_MS
  );
}

function prune(cache) {
  const entries = Object.entries(cache.articlesByUrl)
    .sort((a, b) => Date.parse(b[1].fetchedAt || 0) - Date.parse(a[1].fetchedAt || 0));
  cache.articlesByUrl = Object.fromEntries(entries.slice(0, MAX_ARTICLES));
}

function updateHealth(cache, site, event) {
  cache.healthBySite = cache.healthBySite || {};
  const current = cache.healthBySite[site.id] || {
    siteId: site.id,
    siteTitle: site.title,
    domain: site.domain,
    checks: 0,
    candidateChecks: 0,
    candidateEmpty: 0,
    extractionAttempts: 0,
    extractionSuccesses: 0,
    extractionFailures: 0,
    parsers: {},
    lastError: null,
    lastDiagnostics: null,
    lastCheckedAt: null
  };

  current.siteTitle = site.title;
  current.domain = site.domain;
  current.checks += 1;
  current.lastCheckedAt = new Date().toISOString();

  if (event.type === "candidates-ready" || event.type === "candidate-empty") {
    current.candidateChecks += 1;
    current.lastCandidateCount = event.candidateCount || 0;
    if (!event.candidateCount) current.candidateEmpty += 1;
  }

  if (event.type === "extract-success") {
    current.extractionAttempts += 1;
    current.extractionSuccesses += 1;
    current.lastTextLength = event.textLength;
    current.lastDensity = event.density;
    current.parsers[event.parser] = (current.parsers[event.parser] || 0) + 1;
    current.lastError = null;
    current.lastDiagnostics = null;
  }

  if (event.type === "extract-failure") {
    current.extractionAttempts += 1;
    current.extractionFailures += 1;
    current.lastError = event.error;
    current.lastDiagnostics = event.diagnostics;
  }

  current.extractionSuccessRate = current.extractionAttempts
    ? Number((current.extractionSuccesses / current.extractionAttempts).toFixed(2))
    : null;
  current.candidateSuccessRate = current.candidateChecks
    ? Number(((current.candidateChecks - current.candidateEmpty) / current.candidateChecks).toFixed(2))
    : null;

  cache.healthBySite[site.id] = current;
}

function randomItem(items) {
  if (!items.length) return null;
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

function logCache(event, payload) {
  console.info("[article-cache]", JSON.stringify({
    event,
    timestamp: Date.now(),
    payload
  }));
}

module.exports = {
  ArticleCache
};
