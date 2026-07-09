const crypto = require("node:crypto");
const { createRequestGovernance } = require("./requestGovernance");

const TRANSLATE_TIMEOUT_MS = 12000;
const MAX_CACHE_ITEMS = 500;
const MAX_CHUNK_CHARS = 1200;
const MAX_RETRIES = 2;
const RATE_LIMIT_STATUS = 429;
const translationRequests = createRequestGovernance({
  minIntervalMs: 250,
  maxRetries: 1
});

class Translator {
  constructor({ translationStore } = {}) {
    this.cache = new Map();
    this.translationStore = translationStore || null;
  }

  async translate({ text, direction, articleId, selectionKey }) {
    const trimmed = (text || "").trim();
    if (!trimmed) {
      return {
        translatedText: "",
        provider: "none"
      };
    }

    const target = resolveTargetLanguage(trimmed, direction);
    const source = target === "zh-CN" ? "auto" : "auto";
    const cacheKey = makeTranslationKey({ articleId, selectionKey, source, target, text: trimmed });
    const persisted = await this.getPersisted(cacheKey);
    if (persisted) {
      return {
        ...persisted,
        cached: true
      };
    }
    if (this.cache.has(cacheKey)) {
      return {
        ...this.cache.get(cacheKey),
        cached: true
      };
    }

    try {
      if (process.env.LIBRETRANSLATE_URL) {
        const translatedText = await translateWithLibreTranslate(trimmed, source, target);
        const result = {
          translatedText,
          provider: "libretranslate",
          cached: false
        };
        this.writeCache(cacheKey, result);
        await this.persist(cacheKey, result);
        return result;
      }

      const translatedText = await this.translateChunks(trimmed, source, target);
      const result = {
        translatedText,
        provider: "google-translate",
        cached: false
      };
      this.writeCache(cacheKey, result);
      await this.persist(cacheKey, result);
      return result;
    } catch (error) {
      let myMemoryError = null;
      try {
        const translatedText = await translateWithRetry(() => translateWithMyMemory(trimmed, source, target));
        const result = {
          translatedText,
          provider: "mymemory",
          cached: false
        };
        this.writeCache(cacheKey, result);
        await this.persist(cacheKey, result);
        return result;
      } catch (error) {
        myMemoryError = error;
        // Continue to optional DeepL fallback.
      }

      if (process.env.DEEPL_API_KEY) {
        try {
          const translatedText = await translateWithDeepL(trimmed, target);
          const result = {
            translatedText,
            provider: "deepl",
            cached: false
          };
          this.writeCache(cacheKey, result);
          await this.persist(cacheKey, result);
          return result;
        } catch (deeplError) {
          return {
            translatedText: `Translation unavailable. Google: ${error.message}; DeepL: ${deeplError.message}`,
            provider: "google-translate+deepl",
            cached: false,
            error: deeplError.message
          };
        }
      }

      return {
        translatedText: `Translation unavailable. Google: ${error.message}${myMemoryError ? `; MyMemory: ${myMemoryError.message}` : ""}.`,
        provider: "google-translate",
        cached: false,
        error: error.message
      };
    }
  }

  writeCache(key, value) {
    this.cache.set(key, value);
    if (this.cache.size > MAX_CACHE_ITEMS) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
  }

  async getPersisted(key) {
    if (!this.translationStore) return null;
    try {
      return await this.translationStore.get(key);
    } catch {
      return null;
    }
  }

  async persist(key, value) {
    if (!this.translationStore) return;
    try {
      await this.translationStore.put(key, value);
    } catch {
      // Persisted cache is best-effort.
    }
  }

  async translateChunks(text, source, target) {
    const chunks = splitIntoChunks(text, MAX_CHUNK_CHARS);
    const translatedChunks = [];

    for (const chunk of chunks) {
      const chunkKey = `${source}:${target}:${chunk}`;
      if (this.cache.has(chunkKey)) {
        translatedChunks.push(this.cache.get(chunkKey).translatedText);
        continue;
      }

      const translatedText = await translateWithRetry(() => translateWithGoogle(chunk, source, target));
      const result = {
        translatedText,
        provider: "google-translate",
        cached: false
      };
      this.writeCache(chunkKey, result);
      await this.persist(chunkKey, result);
      translatedChunks.push(translatedText);
    }

    return translatedChunks.join("\n\n");
  }
}

async function translateWithRetry(fn) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < MAX_RETRIES) {
        const delayMs = isRateLimitError(error) ? 1200 * (attempt + 1) : 350 * 2 ** attempt;
        await sleep(delayMs);
      }
    }
  }
  throw lastError;
}

async function translateWithGoogle(text, source, target) {
  const url = new URL("https://translate.googleapis.com/translate_a/single");
  url.searchParams.set("client", "gtx");
  url.searchParams.set("sl", source);
  url.searchParams.set("tl", target);
  url.searchParams.set("dt", "t");
  url.searchParams.set("q", text);

  const data = await requestJson(url.toString());
  const translated = (data[0] || [])
    .map((item) => item[0])
    .filter(Boolean)
    .join("");

  if (!translated) {
    throw new Error("empty translation response");
  }

  return translated;
}

async function translateWithMyMemory(text, source, target) {
  const sourceLang = source === "auto" ? (containsChinese(text) ? "zh-CN" : "en") : source;
  const targetLang = target === "zh-CN" ? "zh-CN" : "en";
  const url = new URL("https://api.mymemory.translated.net/get");
  url.searchParams.set("q", text);
  url.searchParams.set("langpair", `${sourceLang}|${targetLang}`);

  const data = await requestJson(url.toString());
  const translated = data.responseData?.translatedText;
  if (!translated) {
    throw new Error("empty MyMemory response");
  }
  return translated;
}

function resolveTargetLanguage(text, direction = "auto") {
  if (direction === "zh") return "zh-CN";
  if (direction === "en") return "en";
  return containsChinese(text) ? "en" : "zh-CN";
}

async function translateWithDeepL(text, target) {
  const endpoint = process.env.DEEPL_API_URL || "https://api-free.deepl.com/v2/translate";
  const body = new URLSearchParams();
  body.set("auth_key", process.env.DEEPL_API_KEY);
  body.set("text", text);
  body.set("target_lang", target === "zh-CN" ? "ZH" : "EN");

  const data = await requestJson(endpoint, {
    method: "POST",
    body: body.toString(),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    }
  });
  const translated = data.translations?.[0]?.text;
  if (!translated) {
    throw new Error("empty DeepL response");
  }
  return translated;
}

async function translateWithLibreTranslate(text, source, target) {
  const endpoint = new URL("/translate", process.env.LIBRETRANSLATE_URL).toString();
  const body = {
    q: text,
    source: source === "auto" ? "auto" : source,
    target: target === "zh-CN" ? "zh" : target,
    format: "text"
  };
  if (process.env.LIBRETRANSLATE_API_KEY) {
    body.api_key = process.env.LIBRETRANSLATE_API_KEY;
  }

  const data = await requestJson(endpoint, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json"
    }
  });
  const translated = data.translatedText;
  if (!translated) {
    throw new Error("empty LibreTranslate response");
  }
  return translated;
}

function requestJson(url, options = {}) {
  return translationRequests.request(url, {
    method: options.method || "GET",
    body: options.body,
    timeoutMs: TRANSLATE_TIMEOUT_MS,
    source: "translator",
    fetchMode: "translation",
    strategySource: "translation-provider",
    headers: {
      "Accept": "application/json,text/plain,*/*",
      ...(options.headers || {})
    }
  }).then((response) => {
    if (!response.ok) {
      throw makeHttpError(response.status);
    }

    try {
      return JSON.parse(response.text);
    } catch (error) {
      throw new Error(`invalid JSON: ${error.message}`);
    }
  });
}

function makeHttpError(status) {
  const error = new Error(status === RATE_LIMIT_STATUS ? "HTTP 429 rate limited" : `HTTP ${status}`);
  error.status = status;
  error.rateLimited = status === RATE_LIMIT_STATUS;
  return error;
}

function isRateLimitError(error) {
  return error?.rateLimited || error?.status === RATE_LIMIT_STATUS || /HTTP 429|rate limit/i.test(error?.message || "");
}

function splitIntoChunks(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const sentences = text.match(/[^.!?。！？\n]+[.!?。！？]?|\n+/g) || [text];
  const chunks = [];
  let current = "";

  for (const sentence of sentences) {
    if ((current + sentence).length > maxChars && current.trim()) {
      chunks.push(current.trim());
      current = "";
    }

    if (sentence.length > maxChars) {
      for (let index = 0; index < sentence.length; index += maxChars) {
        chunks.push(sentence.slice(index, index + maxChars).trim());
      }
    } else {
      current += sentence;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(Boolean);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function containsChinese(text) {
  return /[\u3400-\u9fff]/.test(text);
}

function makeTranslationKey({ articleId = "global", selectionKey = "", source, target, text }) {
  const material = selectionKey || `${articleId}:${source}:${target}:${text}`;
  return crypto.createHash("sha256").update(material).digest("hex");
}

module.exports = {
  Translator
};
