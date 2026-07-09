const fs = require("node:fs/promises");
const path = require("node:path");
const { writeJsonAtomic } = require("./jsonFile");

const DEFAULT_BYPASS_SOURCES = [
  {
    id: "archive-ph",
    name: "archive.ph",
    template: "https://archive.ph/newest/{url}",
    enabled: true,
    priority: 1
  },
  {
    id: "archive-today",
    name: "archive.today",
    template: "https://archive.today/newest/{url}",
    enabled: true,
    priority: 2
  },
  {
    id: "webcache",
    name: "Google Webcache",
    template: "https://webcache.googleusercontent.com/search?q=cache:{url}",
    enabled: false,
    priority: 3
  }
];

class BypassRegistry {
  constructor(userDataPath) {
    this.filePath = path.join(userDataPath, "paywall-bypass.json");
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return JSON.parse(raw);
    } catch (error) {
      if (error.code === "ENOENT") {
        const data = { sources: DEFAULT_BYPASS_SOURCES };
        await this.save(data);
        return data;
      }
      throw error;
    }
  }

  async save(data) {
    data.sources.sort((a, b) => Number(a.priority || 0) - Number(b.priority || 0));
    await writeJsonAtomic(this.filePath, data);
  }

  async listSources() {
    const data = await this.load();
    return data.sources;
  }

  async addSource({ name, template }) {
    if (!name?.trim() || !template?.includes("{url}")) {
      throw new Error("Bypass source needs a name and a template containing {url}");
    }

    const data = await this.load();
    const maxPriority = Math.max(0, ...data.sources.map((source) => Number(source.priority || 0)));
    const source = {
      id: Buffer.from(`${name}:${template}`).toString("base64url"),
      name: name.trim(),
      template: template.trim(),
      enabled: true,
      priority: maxPriority + 1
    };
    data.sources.push(source);
    await this.save(data);
    return source;
  }

  async updateSource(sourceId, patch) {
    const data = await this.load();
    const source = data.sources.find((item) => item.id === sourceId);
    if (!source) {
      throw new Error("Bypass source not found");
    }

    if (typeof patch.name === "string") source.name = patch.name.trim() || source.name;
    if (typeof patch.template === "string" && patch.template.includes("{url}")) source.template = patch.template.trim();
    if (typeof patch.enabled === "boolean") source.enabled = patch.enabled;
    if (Number.isFinite(Number(patch.priority))) source.priority = Number(patch.priority);

    await this.save(data);
    return source;
  }

  async deleteSource(sourceId) {
    const data = await this.load();
    data.sources = data.sources.filter((source) => source.id !== sourceId);
    await this.save(data);
    return data.sources;
  }

  async getBypassUrls(articleUrl) {
    const data = await this.load();
    return data.sources
      .filter((source) => source.enabled)
      .sort((a, b) => Number(a.priority || 0) - Number(b.priority || 0))
      .map((source) => ({
        ...source,
        url: source.template.replace("{url}", encodeURIComponent(articleUrl))
      }));
  }
}

module.exports = {
  BypassRegistry,
  DEFAULT_BYPASS_SOURCES
};
