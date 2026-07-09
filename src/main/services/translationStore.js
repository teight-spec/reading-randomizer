const fs = require("node:fs/promises");
const path = require("node:path");
const { writeJsonAtomic } = require("./jsonFile");

const EMPTY_TRANSLATIONS = {
  version: 1,
  items: {}
};
const MAX_ITEMS = 1500;
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

class TranslationStore {
  constructor(userDataPath) {
    this.filePath = path.join(userDataPath, "translation-cache.json");
    this.writePromise = Promise.resolve();
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return { ...structuredClone(EMPTY_TRANSLATIONS), ...JSON.parse(raw) };
    } catch (error) {
      if (error.code === "ENOENT") return structuredClone(EMPTY_TRANSLATIONS);
      throw error;
    }
  }

  async save(data) {
    prune(data);
    this.writePromise = this.writePromise.catch(() => {}).then(() => writeJsonAtomic(this.filePath, data));
    return this.writePromise;
  }

  async get(key) {
    const data = await this.load();
    const item = data.items[key];
    if (!item) return null;
    if (Date.now() - Date.parse(item.savedAt || 0) > TTL_MS) return null;
    return item;
  }

  async put(key, value) {
    const data = await this.load();
    data.items[key] = {
      ...value,
      savedAt: new Date().toISOString()
    };
    await this.save(data);
    return data.items[key];
  }
}

function prune(data) {
  const entries = Object.entries(data.items || {})
    .sort((a, b) => Date.parse(b[1].savedAt || 0) - Date.parse(a[1].savedAt || 0));
  data.items = Object.fromEntries(entries.slice(0, MAX_ITEMS));
}

module.exports = {
  TranslationStore
};
