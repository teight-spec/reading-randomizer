const crypto = require("node:crypto");
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
    this.operationPromise = Promise.resolve();
  }

  async load() {
    await this.writePromise.catch(() => {});
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const data = { ...structuredClone(EMPTY_TRANSLATIONS), ...JSON.parse(raw) };
      const migrated = migratePlaintextKeys(data);
      if (migrated.changed) await this.save(migrated.data);
      return migrated.data;
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
    const operation = this.operationPromise.catch(() => {}).then(async () => {
      const data = await this.load();
      data.items[key] = {
        ...value,
        savedAt: new Date().toISOString()
      };
      await this.save(data);
      return data.items[key];
    });
    this.operationPromise = operation.catch(() => {});
    return operation;
  }
}

function prune(data) {
  const entries = Object.entries(data.items || {})
    .sort((a, b) => Date.parse(b[1].savedAt || 0) - Date.parse(a[1].savedAt || 0));
  data.items = Object.fromEntries(entries.slice(0, MAX_ITEMS));
}

function migratePlaintextKeys(data) {
  const items = {};
  let changed = false;
  for (const [key, value] of Object.entries(data.items || {})) {
    const safeKey = /^[a-f0-9]{64}$/i.test(key)
      ? key.toLowerCase()
      : crypto.createHash("sha256").update(key).digest("hex");
    if (safeKey !== key) changed = true;
    items[safeKey] = value;
  }
  return {
    changed,
    data: {
      ...data,
      items
    }
  };
}

module.exports = {
  TranslationStore
};
