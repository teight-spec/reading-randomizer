const fs = require("node:fs/promises");
const path = require("node:path");
const { writeJsonAtomic } = require("./jsonFile");

const MAX_EVENTS = 300;
const EMPTY_DIAGNOSTICS = {
  version: 1,
  events: []
};

class RuntimeDiagnosticsStore {
  constructor(userDataPath) {
    this.filePath = path.join(userDataPath, "runtime-diagnostics.json");
    this.operationPromise = Promise.resolve();
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const data = JSON.parse(raw);
      return {
        version: 1,
        events: Array.isArray(data.events) ? data.events.slice(0, MAX_EVENTS) : []
      };
    } catch (error) {
      if (error.code === "ENOENT") return structuredClone(EMPTY_DIAGNOSTICS);
      throw error;
    }
  }

  async record(event, payload = {}) {
    const operation = this.operationPromise.catch(() => {}).then(async () => {
      const data = await this.load();
      data.events.unshift({
        event: String(event || "unknown").slice(0, 120),
        timestamp: Date.now(),
        payload: sanitizePayload(payload)
      });
      data.events = data.events.slice(0, MAX_EVENTS);
      await writeJsonAtomic(this.filePath, data);
      return data.events[0];
    });
    this.operationPromise = operation.catch(() => {});
    return operation;
  }

  async list() {
    await this.operationPromise.catch(() => {});
    return (await this.load()).events;
  }
}

function sanitizePayload(value) {
  try {
    const serialized = JSON.stringify(value ?? {});
    if (serialized.length > 12_000) {
      return { truncated: true, preview: serialized.slice(0, 2000) };
    }
    return JSON.parse(serialized);
  } catch {
    return { serializationFailed: true };
  }
}

module.exports = {
  RuntimeDiagnosticsStore
};
