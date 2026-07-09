const { requestText } = require("./httpClient");
const { classifyFailure, createTraceId } = require("./requestClassification");

const DEFAULT_SUCCESS_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_NEGATIVE_TTL_MS = 45 * 60 * 1000;
const DEFAULT_ERROR_TTL_MS = 5 * 60 * 1000;

class RequestGovernor {
  constructor({
    minIntervalMs = 1200,
    maxRetries = 1,
    successTtlMs = DEFAULT_SUCCESS_TTL_MS,
    negativeTtlMs = DEFAULT_NEGATIVE_TTL_MS,
    errorTtlMs = DEFAULT_ERROR_TTL_MS
  } = {}) {
    this.minIntervalMs = minIntervalMs;
    this.maxRetries = maxRetries;
    this.successTtlMs = successTtlMs;
    this.negativeTtlMs = negativeTtlMs;
    this.errorTtlMs = errorTtlMs;
    this.inflight = new Map();
    this.cache = new Map();
    this.domainNextAvailableAt = new Map();
  }

  async request(url, options = {}) {
    const key = normalizeUrl(url);
    const domain = safeHost(key);
    const cacheKey = `${options.source || "unknown"}:${key}`;
    const traceId = options.traceId || createTraceId(options.source || "request");

    const cached = this.cache.get(cacheKey);
    if (cached && !isExpired(cached)) {
      logRequest("request_cache_hit", {
        traceId,
        url: key,
        domain,
        source: options.source,
        fetchMode: options.fetchMode || options.profile || "unknown",
        status: cached.kind === "success" ? cached.value?.status : cached.error?.kind || "error"
      });
      if (cached.kind === "success") {
        return cached.value;
      }
      throw cached.error;
    }

    if (this.inflight.has(cacheKey)) {
      logRequest("request_deduped", {
        traceId,
        url: key,
        domain,
        source: options.source,
        fetchMode: options.fetchMode || options.profile || "unknown"
      });
      return this.inflight.get(cacheKey);
    }

    const promise = this._requestWithGovernance(key, domain, {
      ...options,
      traceId
    })
      .then((result) => {
        this.cache.set(cacheKey, {
          kind: "success",
          value: result,
          expiresAt: Date.now() + ttlForResult(result, this.successTtlMs, this.negativeTtlMs)
        });
        return result;
      })
      .catch((error) => {
        this.cache.set(cacheKey, {
          kind: "error",
          error,
          expiresAt: Date.now() + ttlForError(error, this.errorTtlMs)
        });
        throw error;
      })
      .finally(() => {
        this.inflight.delete(cacheKey);
      });

    this.inflight.set(cacheKey, promise);
    return promise;
  }

  async _requestWithGovernance(url, domain, options) {
    const waitMs = this._getWaitMs(domain);
    if (waitMs > 0) {
      await sleep(waitMs);
    }

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const startedAt = Date.now();
      try {
        logRequest("request_start", {
          traceId: options.traceId,
          url,
          domain,
          source: options.source,
          fetchMode: options.fetchMode || options.profile || "unknown",
          strategySource: options.strategySource || "generic",
          attempt
        });
        const result = await requestText(url, {
          ...options,
          source: options.source
        });
        this._bumpDomain(domain);
        logRequest("request_success", {
          traceId: options.traceId,
          url,
          domain,
          source: options.source,
          fetchMode: options.fetchMode || options.profile || "unknown",
          strategySource: options.strategySource || "generic",
          durationMs: Date.now() - startedAt,
          retryCount: attempt,
          status: result.status,
          bytes: Buffer.byteLength(result.text || "", "utf8")
        });
        return result;
      } catch (error) {
        const classification = classifyError(error);
        logRequest("request_failed", {
          traceId: options.traceId,
          url,
          domain,
          source: options.source,
          fetchMode: options.fetchMode || options.profile || "unknown",
          strategySource: options.strategySource || "generic",
          durationMs: Date.now() - startedAt,
          retryCount: attempt,
          attempt,
          kind: classification.kind,
          code: classification.code,
          failureCategory: classifyFailure(error),
          message: error.message
        });
        this._bumpDomain(domain);
        if (attempt >= this.maxRetries || classification.kind === "aborted") {
          throw error;
        }
        await sleep(backoffMs(attempt, classification.kind));
      }
    }

    throw new Error(`Request failed: ${url}`);
  }

  _getWaitMs(domain) {
    const next = this.domainNextAvailableAt.get(domain) || 0;
    return Math.max(0, next - Date.now());
  }

  _bumpDomain(domain) {
    this.domainNextAvailableAt.set(domain, Date.now() + this.minIntervalMs);
  }
}

function ttlForResult(result, successTtlMs, negativeTtlMs) {
  if (!result?.ok) {
    return negativeTtlMs;
  }
  return successTtlMs;
}

function ttlForError(error, errorTtlMs) {
  return error?.kind === "aborted" ? 30 * 1000 : errorTtlMs;
}

function classifyError(error) {
  if (!error) return { kind: "network", code: "UNKNOWN" };
  if (error.kind) return { kind: error.kind, code: error.code || "UNKNOWN" };
  if (error.code === "ETIMEDOUT" || /timed out/i.test(error.message || "")) {
    return { kind: "timeout", code: error.code || "ETIMEDOUT" };
  }
  if (error.code === "ABORT_ERR" || /aborted|canceled|cancelled/i.test(error.message || "")) {
    return { kind: "aborted", code: error.code || "ABORT_ERR" };
  }
  return { kind: "network", code: error.code || "UNKNOWN" };
}

function backoffMs(attempt, kind) {
  const base = kind === "timeout" ? 900 : 450;
  return base * 2 ** attempt;
}

function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function safeHost(url = "") {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isExpired(entry) {
  return Date.now() > entry.expiresAt;
}

function logRequest(event, payload) {
  console.info("[request]", JSON.stringify({
    event,
    timestamp: Date.now(),
    payload
  }));
}

module.exports = {
  RequestGovernor
};
