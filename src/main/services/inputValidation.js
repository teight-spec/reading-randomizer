const MAX_URL_LENGTH = 4096;

function normalizeHttpUrl(value, { label = "URL", allowCredentials = false } = {}) {
  const raw = boundedString(value, { label, maxLength: MAX_URL_LENGTH, required: true });
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`${label} must use HTTP or HTTPS`);
  }
  if (!allowCredentials && (parsed.username || parsed.password)) {
    throw new Error(`${label} must not contain credentials`);
  }
  parsed.hash = "";
  return parsed.toString();
}

function validateSitePayload(value) {
  const payload = objectValue(value, "Site payload");
  return {
    title: boundedString(payload.title, { label: "Site title", maxLength: 300 }),
    url: normalizeHttpUrl(payload.url, { label: "Site URL" }),
    folderPath: boundedString(payload.folderPath, { label: "Folder", maxLength: 300 }),
    feedUrl: payload.feedUrl
      ? normalizeHttpUrl(payload.feedUrl, { label: "Feed URL" })
      : ""
  };
}

function validateSitePatch(value) {
  const patch = objectValue(value, "Site patch");
  const result = {};
  if (patch.title !== undefined) {
    result.title = boundedString(patch.title, { label: "Site title", maxLength: 300 });
  }
  if (patch.folderPath !== undefined) {
    result.folderPath = boundedString(patch.folderPath, { label: "Folder", maxLength: 300 });
  }
  if (patch.paused !== undefined) {
    if (typeof patch.paused !== "boolean") throw new Error("Paused must be a boolean");
    result.paused = patch.paused;
  }
  return result;
}

function validateArticleSourcePayload(value) {
  const payload = objectValue(value, "Article source payload");
  const type = boundedString(payload.type || "feed", { label: "Source type", maxLength: 30 });
  if (!["feed", "sitemap"].includes(type)) throw new Error("Unsupported article source type");
  return {
    type,
    url: normalizeHttpUrl(payload.url, { label: "Article source URL" }),
    title: boundedString(payload.title, { label: "Article source title", maxLength: 300 })
  };
}

function validateTranslationPayload(value) {
  const payload = objectValue(value, "Translation payload");
  const direction = boundedString(payload.direction || "auto", { label: "Translation direction", maxLength: 10 });
  if (!["auto", "zh", "en"].includes(direction)) throw new Error("Unsupported translation direction");
  return {
    text: boundedString(payload.text, { label: "Translation text", maxLength: 5000 }),
    direction,
    articleId: boundedString(payload.articleId, { label: "Article ID", maxLength: MAX_URL_LENGTH }),
    selectionKey: boundedString(payload.selectionKey, { label: "Selection key", maxLength: 256 })
  };
}

function validateKnowledgeFilters(value) {
  const filters = value === undefined ? {} : objectValue(value, "Knowledge filters");
  return {
    query: boundedString(filters.query, { label: "Search query", maxLength: 500 }),
    category: boundedString(filters.category, { label: "Category", maxLength: 80 }),
    status: boundedString(filters.status, { label: "Status", maxLength: 80 }),
    limit: boundedInteger(filters.limit, { label: "Limit", min: 1, max: 100, fallback: 50 }),
    offset: boundedInteger(filters.offset, { label: "Offset", min: 0, max: 100_000, fallback: 0 })
  };
}

function validateKnowledgePatch(value) {
  const patch = objectValue(value, "Knowledge patch");
  const result = {};
  if (patch.categorySlug !== undefined) {
    result.categorySlug = boundedString(patch.categorySlug, { label: "Category", maxLength: 80 });
  }
  if (patch.tags !== undefined) {
    if (!Array.isArray(patch.tags)) throw new Error("Tags must be an array");
    result.tags = patch.tags.slice(0, 12).map((tag) => boundedString(tag, { label: "Tag", maxLength: 80 })).filter(Boolean);
  }
  return result;
}

function validateReadingProgress(value) {
  const payload = objectValue(value, "Reading progress");
  return {
    sessionId: boundedString(payload.sessionId, { label: "Reading session ID", maxLength: 128, required: true }),
    articleUrl: normalizeHttpUrl(payload.articleUrl, { label: "Article URL" }),
    articleTitle: boundedString(payload.articleTitle, { label: "Article title", maxLength: 500 }),
    siteId: boundedString(payload.siteId, { label: "Site ID", maxLength: 512 }),
    siteTitle: boundedString(payload.siteTitle, { label: "Site title", maxLength: 300 }),
    siteDomain: boundedString(payload.siteDomain, { label: "Site domain", maxLength: 255 }),
    startedAt: boundedString(payload.startedAt, { label: "Started at", maxLength: 64 }),
    activeMs: boundedInteger(payload.activeMs, { label: "Active reading time", min: 0, max: 86_400_000, fallback: 0 }),
    maxScrollDepth: boundedUnit(payload.maxScrollDepth, { label: "Scroll depth", fallback: 0 }),
    bottomDwellMs: boundedInteger(payload.bottomDwellMs, { label: "Bottom dwell", min: 0, max: 3_600_000, fallback: 0 }),
    progressPercent: boundedNumber(payload.progressPercent, { label: "Reading progress", min: 0, max: 100, fallback: 0 }),
    anchor: validateReadingAnchor(payload.anchor)
  };
}

function validateReadingAnchor(value) {
  if (value === undefined || value === null || value === "") return null;
  const anchor = objectValue(value, "Reading anchor");
  const kind = boundedString(anchor.kind, { label: "Anchor kind", maxLength: 32, required: true });
  if (!["paragraph", "percentage"].includes(kind)) throw new Error("Unsupported reading anchor");
  const result = {
    kind,
    progressPercent: boundedNumber(anchor.progressPercent, { label: "Anchor progress", min: 0, max: 100, fallback: 0 })
  };
  if (kind === "paragraph") {
    result.paragraphIndex = boundedInteger(anchor.paragraphIndex, {
      label: "Paragraph index",
      min: 0,
      max: 100_000,
      fallback: 0
    });
    result.charOffset = boundedInteger(anchor.charOffset, {
      label: "Paragraph offset",
      min: 0,
      max: 200_000,
      fallback: 0
    });
    result.paragraphCount = boundedInteger(anchor.paragraphCount, {
      label: "Paragraph count",
      min: 0,
      max: 100_000,
      fallback: 0
    });
  }
  return result;
}

function validateShelfItem(value) {
  const payload = objectValue(value, "Shelf item");
  return {
    articleUrl: normalizeHttpUrl(payload.articleUrl, { label: "Article URL" }),
    articleTitle: boundedString(payload.articleTitle, { label: "Article title", maxLength: 500 }),
    siteId: boundedString(payload.siteId, { label: "Site ID", maxLength: 512 }),
    siteTitle: boundedString(payload.siteTitle, { label: "Site title", maxLength: 300 }),
    siteDomain: boundedString(payload.siteDomain, { label: "Site domain", maxLength: 255 }),
    progressPercent: boundedNumber(payload.progressPercent, { label: "Reading progress", min: 0, max: 100, fallback: 0 }),
    anchor: validateReadingAnchor(payload.anchor)
  };
}

function validateOnboardingSelection(value) {
  const payload = value === undefined ? {} : objectValue(value, "Onboarding selection");
  const folderPaths = Array.isArray(payload.folderPaths) ? payload.folderPaths : [];
  const packIds = Array.isArray(payload.packIds) ? payload.packIds : [];
  return {
    folderPaths: folderPaths.slice(0, 200).map((item) => boundedString(item, {
      label: "Bookmark folder",
      maxLength: 500,
      required: true
    })),
    packIds: packIds.slice(0, 20).map((item) => boundedString(item, {
      label: "Source pack",
      maxLength: 80,
      required: true
    }))
  };
}

function validateBypassSource(value) {
  const payload = objectValue(value, "Bypass source");
  return {
    name: boundedString(payload.name, { label: "Bypass source name", maxLength: 100, required: true }),
    template: normalizeBypassTemplate(payload.template)
  };
}

function validateBypassPatch(value) {
  const patch = objectValue(value, "Bypass patch");
  const result = {};
  if (patch.name !== undefined) {
    result.name = boundedString(patch.name, { label: "Bypass source name", maxLength: 100, required: true });
  }
  if (patch.template !== undefined) result.template = normalizeBypassTemplate(patch.template);
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== "boolean") throw new Error("Enabled must be a boolean");
    result.enabled = patch.enabled;
  }
  if (patch.priority !== undefined) {
    const priority = Number(patch.priority);
    if (!Number.isFinite(priority) || priority < 0 || priority > 10_000) throw new Error("Priority is invalid");
    result.priority = priority;
  }
  return result;
}

function normalizeBypassTemplate(value) {
  const template = boundedString(value, { label: "Bypass template", maxLength: MAX_URL_LENGTH, required: true });
  if (!template.includes("{url}")) throw new Error("Bypass template must contain {url}");
  normalizeHttpUrl(template.replace("{url}", encodeURIComponent("https://example.com/article")), {
    label: "Bypass template"
  });
  return template;
}

function validateRendererError(value) {
  const payload = objectValue(value, "Renderer error");
  const metadata = safeMetadata(payload.metadata);
  return {
    event: boundedString(payload.event, { label: "Renderer event", maxLength: 120 }),
    timestamp: boundedInteger(payload.timestamp, { label: "Renderer timestamp", min: 0, max: Number.MAX_SAFE_INTEGER, fallback: Date.now() }),
    message: boundedString(payload.message, { label: "Renderer message", maxLength: 2000 }),
    name: boundedString(payload.name, { label: "Renderer error name", maxLength: 120 }),
    stack: boundedString(payload.stack, { label: "Renderer stack", maxLength: 12_000 }),
    articleUrl: payload.articleUrl ? normalizeHttpUrl(payload.articleUrl, { label: "Article URL" }) : null,
    siteId: boundedString(payload.siteId, { label: "Site ID", maxLength: 512 }),
    metadata
  };
}

function safeMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length > 4000) return { truncated: true };
    return JSON.parse(serialized);
  } catch {
    return {};
  }
}

function boundedId(value, label = "ID") {
  return boundedString(value, { label, maxLength: 512, required: true });
}

function positiveInteger(value, label = "ID") {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label} is invalid`);
  return number;
}

function boundedString(value, { label = "Value", maxLength, required = false } = {}) {
  const normalized = String(value ?? "").trim();
  if (required && !normalized) throw new Error(`${label} is required`);
  if (maxLength && normalized.length > maxLength) throw new Error(`${label} is too long`);
  return normalized;
}

function boundedInteger(value, { label = "Value", min, max, fallback } = {}) {
  if ((value === undefined || value === null || value === "") && fallback !== undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`${label} is invalid`);
  return number;
}

function boundedNumber(value, { label = "Value", min, max, fallback } = {}) {
  if ((value === undefined || value === null || value === "") && fallback !== undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw new Error(`${label} is invalid`);
  return number;
}

function boundedUnit(value, { label = "Value", fallback = 0 } = {}) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) throw new Error(`${label} is invalid`);
  return number;
}

function objectValue(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

module.exports = {
  boundedId,
  boundedString,
  normalizeBypassTemplate,
  normalizeHttpUrl,
  positiveInteger,
  validateArticleSourcePayload,
  validateBypassPatch,
  validateBypassSource,
  validateKnowledgeFilters,
  validateKnowledgePatch,
  validateOnboardingSelection,
  validateReadingAnchor,
  validateReadingProgress,
  validateRendererError,
  validateShelfItem,
  validateSitePatch,
  validateSitePayload,
  validateTranslationPayload
};
