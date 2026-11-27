const fs = require("node:fs/promises");
const path = require("node:path");
const { writeJsonAtomic } = require("./jsonFile");

const DEFAULT_MODEL = "qwen/qwen3.6-27b";

class SecureSettingsStore {
  constructor(userDataPath, { safeStorage } = {}) {
    this.filePath = path.join(userDataPath, "secure-settings.json");
    this.safeStorage = safeStorage || null;
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      return {
        version: 1,
        groqEncryptedKey: typeof parsed.groqEncryptedKey === "string" ? parsed.groqEncryptedKey : "",
        groqModel: typeof parsed.groqModel === "string" && parsed.groqModel ? parsed.groqModel : DEFAULT_MODEL,
        translationConsent: parsed.translationConsent === true,
        readerFontSize: clampNumber(parsed.readerFontSize, 16, 28, 20),
        readerWidth: clampNumber(parsed.readerWidth, 560, 1040, 720)
      };
    } catch (error) {
      if (error.code === "ENOENT") {
        return {
          version: 1,
          groqEncryptedKey: "",
          groqModel: DEFAULT_MODEL,
          translationConsent: false,
          readerFontSize: 20,
          readerWidth: 720
        };
      }
      throw error;
    }
  }

  async getGroqApiKey() {
    const environmentKey = String(process.env.GROQ_API_KEY || "").trim();
    if (environmentKey) return environmentKey;
    const settings = await this.load();
    if (!settings.groqEncryptedKey || !this.canEncrypt()) return "";
    try {
      return this.safeStorage.decryptString(Buffer.from(settings.groqEncryptedKey, "base64"));
    } catch {
      return "";
    }
  }

  async saveGroqApiKey(apiKey) {
    const normalized = String(apiKey || "").trim();
    if (normalized && (normalized.length < 20 || /\s/.test(normalized))) {
      throw new Error("Groq API key format is invalid");
    }
    if (normalized && !this.canEncrypt()) {
      throw new Error("Secure credential storage is unavailable; use GROQ_API_KEY instead");
    }
    const settings = await this.load();
    settings.groqEncryptedKey = normalized
      ? this.safeStorage.encryptString(normalized).toString("base64")
      : "";
    await writeJsonAtomic(this.filePath, settings);
    await fs.chmod(this.filePath, 0o600);
    return this.getPublicSettings();
  }

  async getModel() {
    return String(process.env.GROQ_MODEL || "").trim() || (await this.load()).groqModel || DEFAULT_MODEL;
  }

  async saveTranslationConsent(enabled) {
    if (typeof enabled !== "boolean") throw new Error("Translation consent must be a boolean");
    const settings = await this.load();
    settings.translationConsent = enabled;
    await writeJsonAtomic(this.filePath, settings);
    await fs.chmod(this.filePath, 0o600);
    return this.getPublicSettings();
  }

  async saveReaderPreferences(patch = {}) {
    const settings = await this.load();
    if (patch.fontSize !== undefined) {
      settings.readerFontSize = clampNumber(patch.fontSize, 16, 28, settings.readerFontSize);
    }
    if (patch.width !== undefined) {
      settings.readerWidth = clampNumber(patch.width, 560, 1040, settings.readerWidth);
    }
    await writeJsonAtomic(this.filePath, settings);
    await fs.chmod(this.filePath, 0o600);
    return this.getPublicSettings();
  }

  async getPublicSettings() {
    const environmentConfigured = Boolean(String(process.env.GROQ_API_KEY || "").trim());
    const settings = await this.load();
    return {
      configured: environmentConfigured || Boolean(settings.groqEncryptedKey && this.canEncrypt()),
      source: environmentConfigured ? "environment" : settings.groqEncryptedKey ? "secure-storage" : "none",
      model: String(process.env.GROQ_MODEL || "").trim() || settings.groqModel || DEFAULT_MODEL,
      secureStorageAvailable: this.canEncrypt(),
      translationConsent: settings.translationConsent === true,
      readerPreferences: {
        fontSize: clampNumber(settings.readerFontSize, 16, 28, 20),
        width: clampNumber(settings.readerWidth, 560, 1040, 720)
      }
    };
  }

  canEncrypt() {
    const hasCryptoMethods = Boolean(
      this.safeStorage?.encryptString &&
      this.safeStorage?.decryptString
    );
    if (!hasCryptoMethods) return false;
    if (typeof this.safeStorage.isEncryptionAvailable === "function") {
      try {
        return Boolean(this.safeStorage.isEncryptionAvailable());
      } catch {
        return false;
      }
    }
    return ["darwin", "win32"].includes(process.platform);
  }
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

module.exports = {
  SecureSettingsStore,
  DEFAULT_MODEL
};
