let electronNet = null;

try {
  electronNet = require("electron").net;
} catch {
  electronNet = null;
}

const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache",
  "DNT": "1"
};

const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;

const HEADER_PROFILES = {
  "browser-document": {
    "Accept":
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Sec-CH-UA": "\"Chromium\";v=\"124\", \"Not-A.Brand\";v=\"24\", \"Google Chrome\";v=\"124\"",
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": "\"macOS\""
  },
  feed: {
    "Accept": "application/rss+xml,application/atom+xml,application/xml;q=0.9,text/xml;q=0.8,*/*;q=0.7",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "Sec-CH-UA": "\"Chromium\";v=\"124\", \"Not-A.Brand\";v=\"24\", \"Google Chrome\";v=\"124\"",
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": "\"macOS\""
  },
  "article-parser": {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-CH-UA": "\"Chromium\";v=\"124\", \"Not-A.Brand\";v=\"24\", \"Google Chrome\";v=\"124\"",
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": "\"macOS\""
  }
};

async function requestText(url, options = {}) {
  if (electronNet) {
    return requestTextWithElectronNet(url, options);
  }
  return requestTextWithFetch(url, options);
}

function requestTextWithElectronNet(url, options = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const maxBodyBytes = resolveMaxBodyBytes(options);
    const request = electronNet.request({
      method: options.method || "GET",
      url
    });
    const timeout = setTimeout(() => {
      request.abort();
      const error = new Error("request timed out");
      error.code = "ETIMEDOUT";
      error.kind = "timeout";
      error.source = options.source || "unknown";
      finish(reject, error);
    }, options.timeoutMs || 9000);

    function finish(callback, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
    }

    const headers = {
      ...DEFAULT_HEADERS,
      ...headersForProfile(options.profile),
      ...(options.headers || {})
    };
    for (const [key, value] of Object.entries(sanitizeElectronNetHeaders(headers))) {
      request.setHeader(key, value);
    }

    request.on("response", (response) => {
      const chunks = [];
      let received = 0;
      response.on("data", (chunk) => {
        if (settled) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += buffer.length;
        if (received > maxBodyBytes) {
          request.abort();
          finish(reject, responseTooLargeError(maxBodyBytes, options.source));
          return;
        }
        chunks.push(buffer);
      });
      response.on("end", () => {
        finish(resolve, {
          ok: response.statusCode >= 200 && response.statusCode < 300,
          status: response.statusCode,
          url,
          headers: response.headers,
          text: Buffer.concat(chunks).toString("utf8")
        });
      });
    });

    request.on("error", (error) => {
      error.source = options.source || "unknown";
      finish(reject, error);
    });

    if (options.body) request.write(options.body);
    request.end();
  });
}

function sanitizeElectronNetHeaders(headers = {}) {
  const blocked = new Set([
    "accept-encoding",
    "connection",
    "content-length",
    "host",
    "sec-ch-ua",
    "sec-ch-ua-mobile",
    "sec-ch-ua-platform",
    "sec-fetch-dest",
    "sec-fetch-mode",
    "sec-fetch-site",
    "sec-fetch-user",
    "upgrade-insecure-requests"
  ]);
  return Object.fromEntries(
    Object.entries(headers).filter(([key, value]) => {
      if (value === undefined || value === null) return false;
      return !blocked.has(String(key).toLowerCase());
    })
  );
}

async function requestTextWithFetch(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), options.timeoutMs || 9000);
  if (options.signal) {
    if (options.signal.aborted) {
      const error = new Error("request canceled");
      error.code = "ABORT_ERR";
      error.kind = "canceled";
      error.source = options.source || "unknown";
      throw error;
    }
    options.signal.addEventListener("abort", () => controller.abort("canceled"), { once: true });
  }

  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      body: options.body,
      headers: {
        ...DEFAULT_HEADERS,
        ...headersForProfile(options.profile),
        ...(options.headers || {})
      },
      signal: controller.signal
    });
    const maxBodyBytes = resolveMaxBodyBytes(options);
    const text = await readResponseTextWithCap(response, maxBodyBytes, controller);

    return {
      ok: response.ok,
      status: response.status,
      url: response.url,
      headers: Object.fromEntries(response.headers.entries()),
      text
    };
  } catch (error) {
    if (error?.kind === "response_too_large") throw error;
    if (controller.signal.aborted) {
      const reason = controller.signal.reason || "canceled";
      const abortError = new Error(reason === "timeout" ? "request timed out" : "request canceled");
      abortError.code = reason === "timeout" ? "ETIMEDOUT" : "ABORT_ERR";
      abortError.kind = reason === "timeout" ? "timeout" : "canceled";
      abortError.source = options.source || "unknown";
      throw abortError;
    }
    error.source = options.source || "unknown";
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function headersForProfile(profile) {
  return HEADER_PROFILES[profile] || {};
}

function resolveMaxBodyBytes(options = {}) {
  const value = Number(options.maxBodyBytes);
  if (Number.isFinite(value) && value > 0) return Math.floor(value);
  return DEFAULT_MAX_BODY_BYTES;
}

function responseTooLargeError(maxBodyBytes, source) {
  const error = new Error(`response body exceeded ${maxBodyBytes} bytes`);
  error.code = "ERR_RESPONSE_TOO_LARGE";
  error.kind = "response_too_large";
  error.source = source || "unknown";
  return error;
}

async function readResponseTextWithCap(response, maxBodyBytes, controller) {
  if (!response.body || typeof response.body.getReader !== "function") {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBodyBytes) {
      throw responseTooLargeError(maxBodyBytes);
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const buffer = Buffer.from(value);
    received += buffer.length;
    if (received > maxBodyBytes) {
      await reader.cancel().catch(() => {});
      controller.abort("response_too_large");
      throw responseTooLargeError(maxBodyBytes);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

module.exports = {
  DEFAULT_MAX_BODY_BYTES,
  requestText,
  resolveMaxBodyBytes,
  sanitizeElectronNetHeaders
};
