const fs = require("node:fs/promises");
const path = require("node:path");
const { writeJsonAtomic } = require("./jsonFile");
const { createState } = require("./readingLoopState");

class ReadingLoopStore {
  constructor(userDataPath) {
    this.filePath = path.join(userDataPath, "reading-loop.json");
    this.operationPromise = Promise.resolve();
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      return { ...createState(), ...(parsed && typeof parsed === "object" ? parsed : {}) };
    } catch (error) {
      if (error.code === "ENOENT") return createState();
      throw error;
    }
  }

  async save(state) {
    await writeJsonAtomic(this.filePath, state || createState());
    return state;
  }

  async mutate(mutator) {
    const operation = this.operationPromise.catch(() => {}).then(async () => {
      const current = await this.load();
      const result = await mutator(current);
      const next = result?.state || result || current;
      await this.save(next);
      return result && Object.prototype.hasOwnProperty.call(result, "state") ? result : { state: next };
    });
    this.operationPromise = operation.catch(() => {});
    return operation;
  }
}

module.exports = {
  ReadingLoopStore
};
