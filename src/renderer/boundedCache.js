(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
    return;
  }
  root.ReaderCache = api;
})(typeof globalThis === "undefined" ? window : globalThis, () => {
  class BoundedCache {
    constructor({ maxSize = 200, ttlMs = 30 * 60 * 1000, now = Date.now } = {}) {
      this.maxSize = Math.max(1, Math.floor(Number(maxSize) || 1));
      this.ttlMs = Math.max(1, Math.floor(Number(ttlMs) || 1));
      this.now = now;
      this.items = new Map();
    }

    has(key) {
      const entry = this.items.get(key);
      if (!entry) return false;
      if (entry.expiresAt <= this.now()) {
        this.items.delete(key);
        return false;
      }
      return true;
    }

    get(key) {
      if (!this.has(key)) return undefined;
      const entry = this.items.get(key);
      this.items.delete(key);
      this.items.set(key, entry);
      return entry.value;
    }

    set(key, value) {
      this.items.delete(key);
      this.items.set(key, {
        value,
        expiresAt: this.now() + this.ttlMs
      });
      while (this.items.size > this.maxSize) {
        this.items.delete(this.items.keys().next().value);
      }
      return this;
    }

    clear() {
      this.items.clear();
    }

    get size() {
      return this.items.size;
    }
  }

  return { BoundedCache };
});
