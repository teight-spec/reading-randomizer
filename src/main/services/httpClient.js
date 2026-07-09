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
      let body = "";
      response.on("data", (chunk) => {
        body += chunk.toString();
      });
      response.on("end", () => {
        finish(resolve, {
          ok: response.statusCode >= 200 && response.statusCode < 300,
          status: response.statusCode,
          url,
          headers: response.headers,
          text: body
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

    return {
      ok: response.ok,
      status: response.status,
      url: response.url,
      headers: Object.fromEntries(response.headers.entries()),
      text: await response.text()
    };
  } catch (error) {
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

module.exports = {
  requestText,
  sanitizeElectronNetHeaders
};
