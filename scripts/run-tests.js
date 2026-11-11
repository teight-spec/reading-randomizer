const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

test("failure classification covers timeout, dns and blocked responses", () => {
  const { classifyFailure } = require("../src/main/services/requestClassification");
  assert.equal(classifyFailure({ kind: "timeout", message: "request timed out" }), "timeout");
  assert.equal(classifyFailure({ code: "ENOTFOUND", message: "host missing" }), "dns_failure");
  assert.equal(classifyFailure({}, { status: 403, text: "Access denied" }), "blocked_by_bot");
  assert.equal(classifyFailure({ message: "net::ERR_CONNECTION_REFUSED" }), "connection_refused");
  assert.equal(classifyFailure({ message: "net::ERR_CONNECTION_CLOSED" }), "remote_closed");
});

test("site strategy resolver matches declared publisher domains", () => {
  const { resolveSiteStrategy } = require("../src/main/services/siteStrategies");
  assert.equal(resolveSiteStrategy("https://www.newyorker.com/")?.id, "newyorker");
  assert.equal(resolveSiteStrategy("https://www.economist.com/")?.id, "economist");
  assert.equal(resolveSiteStrategy("https://example.invalid/"), null);
});

test("adaptive strategy prefers historical success and skips expensive failing browser stage", () => {
  const { AdaptiveStrategyEngine } = require("../src/main/services/adaptiveStrategyEngine");
  const engine = new AdaptiveStrategyEngine();
  const decision = engine.decide({
    enabledStages: ["feed-sitemap", "browser"],
    health: {
      lastSuccessfulStrategy: "feed",
      feedSuccessRate: 0.8,
      browserSuccessRate: 0.1,
      botBlockedRate: 0.4
    }
  });
  assert.deepEqual(decision.stages, ["feed-sitemap"]);
  assert.equal(decision.reduceConcurrency, true);
  assert.ok(decision.cooldownRecommendationMs > 0);
});

test("site health store persists rolling success and failure metrics", async () => {
  const { SiteHealthStore } = require("../src/main/services/siteHealthStore");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reader-health-"));
  const store = new SiteHealthStore(dir);
  const site = { id: "site-1", title: "Site", url: "https://example.com/", domain: "example.com" };
  await store.record(site, { stageName: "feed", ok: true, latencyMs: 100, strategySource: "test" });
  await store.record(site, { stageName: "browser", ok: false, failureCategory: "blocked_by_bot", latencyMs: 500 });
  const health = await store.getSiteHealth(site);
  assert.equal(health.successRate, 0.5);
  assert.equal(health.feedSuccessRate, 1);
  assert.equal(health.browserSuccessRate, 0);
  assert.equal(health.botBlockedRate, 0.5);
});

test("site health store serializes concurrent records without losing events", async () => {
  const { SiteHealthStore } = require("../src/main/services/siteHealthStore");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reader-health-concurrent-"));
  const store = new SiteHealthStore(dir);
  const site = { id: "site-1", title: "Site", url: "https://example.com/", domain: "example.com" };
  await Promise.all(Array.from({ length: 20 }, (_, index) => store.record(site, {
    stageName: "feed",
    ok: index % 2 === 0,
    latencyMs: index,
    failureCategory: index % 2 === 0 ? null : "network"
  })));
  const data = JSON.parse(await fs.readFile(store.filePath, "utf8"));
  assert.equal(data.sites[site.id].events.length, 20);
  assert.equal((await store.getSiteHealth(site)).successRate, 0.5);
});

test("ArticleCache recovers from corrupted JSON and backs it up", async () => {
  const { ArticleCache } = require("../src/main/services/articleCache");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reader-cache-corrupt-"));
  const cache = new ArticleCache(dir);
  await fs.writeFile(cache.filePath, "{\"version\":1,\"articlesByUrl\":{\"broken\":\"unterminated", "utf8");
  const data = await cache.load();
  const files = await fs.readdir(dir);
  assert.deepEqual(data.articlesByUrl, {});
  assert.equal(files.some((file) => file.includes("article-cache.json.corrupt-")), true);
  assert.doesNotThrow(() => JSON.parse(require("node:fs").readFileSync(cache.filePath, "utf8")));
});

test("ArticleCache deduplicates concurrent corruption recovery", async () => {
  const { ArticleCache } = require("../src/main/services/articleCache");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reader-cache-corrupt-race-"));
  const cache = new ArticleCache(dir);
  await fs.writeFile(cache.filePath, "{\"version\":1,\"articlesByUrl\":{\"broken\":\"unterminated", "utf8");
  await Promise.all(Array.from({ length: 5 }, () => cache.load()));
  const files = await fs.readdir(dir);
  assert.equal(files.filter((file) => file.includes("article-cache.json.corrupt-")).length, 1);
  assert.doesNotThrow(() => JSON.parse(require("node:fs").readFileSync(cache.filePath, "utf8")));
});

test("ArticleCache recovers from malformed schema", async () => {
  const { ArticleCache } = require("../src/main/services/articleCache");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reader-cache-schema-"));
  const cache = new ArticleCache(dir);
  await fs.writeFile(cache.filePath, JSON.stringify({ version: 1, articlesByUrl: [] }), "utf8");
  const data = await cache.load();
  const files = await fs.readdir(dir);
  assert.deepEqual(data.articlesByUrl, {});
  assert.equal(files.some((file) => file.includes("article-cache.json.corrupt-")), true);
});

test("ArticleCache concurrent writes preserve valid JSON and entries", async () => {
  const { ArticleCache } = require("../src/main/services/articleCache");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reader-cache-concurrent-"));
  const cache = new ArticleCache(dir);
  const site = { id: "site", title: "Site", url: "https://example.com/", domain: "example.com" };
  await Promise.all(
    Array.from({ length: 20 }, (_, index) => cache.putReady(
      site,
      { title: `Article ${index}`, url: `https://example.com/${index}` },
      {
        title: `Article ${index}`,
        url: `https://example.com/${index}`,
        content: "<p>Readable article content</p>",
        textContent: "Readable article content ".repeat(80),
        diagnostics: { parser: "test" }
      }
    ))
  );
  const raw = await fs.readFile(cache.filePath, "utf8");
  const parsed = JSON.parse(raw);
  assert.equal(Object.keys(parsed.articlesByUrl).length, 20);
  assert.equal(Object.keys(parsed.healthBySite.site.parsers).includes("test"), true);
});

test("writeJsonAtomic writes valid JSON without leaving partial target content", async () => {
  const { writeJsonAtomic } = require("../src/main/services/jsonFile");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reader-json-atomic-"));
  const filePath = path.join(dir, "data.json");
  await writeJsonAtomic(filePath, { ok: true, count: 1 });
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.deepEqual(parsed, { ok: true, count: 1 });
  assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
});

test("TranslationStore migrates plaintext source-text cache keys to hashes", async () => {
  const { TranslationStore } = require("../src/main/services/translationStore");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reader-translation-cache-"));
  const store = new TranslationStore(dir);
  const plaintextKey = "auto:zh-CN:private selected source text";
  await fs.writeFile(store.filePath, JSON.stringify({
    version: 1,
    items: {
      [plaintextKey]: {
        translatedText: "译文",
        provider: "test",
        savedAt: new Date().toISOString()
      }
    }
  }), "utf8");
  const data = await store.load();
  const keys = Object.keys(data.items);
  assert.equal(keys.length, 1);
  assert.match(keys[0], /^[a-f0-9]{64}$/);
  const persisted = await fs.readFile(store.filePath, "utf8");
  assert.doesNotMatch(persisted, /private selected source text/);
  assert.equal((await fs.stat(store.filePath)).mode & 0o777, 0o600);
});

test("article HTML sanitizer removes executable markup and unsafe URLs", () => {
  const { sanitizeArticleHtml } = require("../src/main/services/htmlSanitizer");
  const sanitized = sanitizeArticleHtml(`
    <article onclick="steal()">
      <script>alert(1)</script>
      <p style="background:url(javascript:alert(1))">Keep this text.</p>
      <a href="javascript:alert(2)" onmouseover="steal()">unsafe link</a>
      <a href="/story">safe link</a>
      <img src="https://cdn.example.com/image.jpg" onerror="steal()">
      <img src="data:image/svg+xml,unsafe">
      <form><input value="secret"><p>drop form content</p></form>
    </article>
  `, "https://example.com/base");
  assert.doesNotMatch(sanitized, /script|onclick|onmouseover|onerror|javascript:|style=|<form|<input/i);
  assert.match(sanitized, /Keep this text/);
  assert.match(sanitized, /href="https:\/\/example\.com\/story"/);
  assert.match(sanitized, /rel="noreferrer noopener"/);
  assert.match(sanitized, /referrerpolicy="no-referrer"/);
  assert.doesNotMatch(sanitized, /data:image/);
});

test("IPC input validation accepts web URLs and rejects unsafe schemes or oversized text", () => {
  const {
    normalizeHttpUrl,
    validateBypassSource,
    validateTranslationPayload
  } = require("../src/main/services/inputValidation");
  assert.equal(normalizeHttpUrl("https://example.com/story#section"), "https://example.com/story");
  assert.throws(() => normalizeHttpUrl("file:///etc/passwd"), /HTTP or HTTPS/);
  assert.throws(() => normalizeHttpUrl("javascript:alert(1)"), /HTTP or HTTPS/);
  assert.throws(() => normalizeHttpUrl("https://user:secret@example.com/"), /credentials/);
  assert.throws(() => validateBypassSource({ name: "bad", template: "https://mirror.example/" }), /\{url\}/);
  assert.throws(() => validateTranslationPayload({ text: "x".repeat(5001) }), /too long/);
});

test("KnowledgeDatabase starts empty and completes reading only after cumulative thresholds", async () => {
  const { KnowledgeDatabase } = require("../src/main/services/knowledgeDatabase");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reader-knowledge-"));
  await fs.writeFile(path.join(dir, "reading-history.json"), JSON.stringify({
    openedArticles: [{ articleUrl: "https://old.example/opened" }],
    readArticles: [{ articleUrl: "https://old.example/read" }]
  }), "utf8");
  const database = new KnowledgeDatabase(dir);
  assert.deepEqual(database.getStats(), { total: 0, analyzed: 0, pending: 0 });
  assert.deepEqual(
    database.db.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((row) => row.version),
    [1, 2, 3]
  );
  assert.equal(
    database.db.prepare("SELECT COUNT(*) AS count FROM pragma_index_list('articles') WHERE name = 'articles_site_idx'").get().count,
    1
  );
  assert.equal((await fs.stat(database.filePath)).mode & 0o777, 0o600);

  const cachedItem = {
    site: { id: "site-1", title: "Example", domain: "example.com" },
    article: { title: "A Knowledge Article", url: "https://example.com/story?utm_source=test" },
    readerArticle: {
      title: "A Knowledge Article",
      byline: "Reporter",
      excerpt: "An article about a useful idea.",
      content: "<p>Useful article content.</p>",
      textContent: "Useful article content about a durable idea. ".repeat(100),
      publishedAt: "2026-08-01T00:00:00.000Z"
    }
  };
  const base = {
    articleUrl: cachedItem.article.url,
    articleTitle: cachedItem.article.title,
    siteId: cachedItem.site.id,
    siteTitle: cachedItem.site.title,
    siteDomain: cachedItem.site.domain,
    startedAt: "2026-08-08T00:00:00.000Z",
    maxScrollDepth: 0.95,
    bottomDwellMs: 5000
  };
  const first = database.recordProgress({ ...base, sessionId: "session-1", activeMs: 120_000 }, cachedItem);
  assert.equal(first.completed, false);
  const duplicate = database.recordProgress({ ...base, sessionId: "session-1", activeMs: 120_000 }, cachedItem);
  assert.equal(duplicate.activeMs, 120_000, "replayed session progress must be idempotent");
  const completed = database.recordProgress({
    ...base,
    sessionId: "session-2",
    activeMs: 60_000,
    maxScrollDepth: 0.5,
    bottomDwellMs: 0
  }, cachedItem);
  assert.equal(completed.completed, true);
  assert.equal(completed.newlyCompleted, true);
  assert.equal(database.getStats().total, 1);
  assert.equal(database.listArticles({})[0].originalUrl, cachedItem.article.url);
  assert.equal(database.listArticles({})[0].knowledgeStatus, "pending_analysis");

  const job = database.claimNextJob();
  assert.equal(job.article_id, completed.articleId);
  database.completeAnalysis(job.id, {
    thesis: "这是一篇关于持久知识的文章。",
    keyPoints: ["要点一", "要点二", "要点三"],
    evidence: ["作者提供了一个具体例子。"],
    whyItMatters: "它帮助读者建立长期知识。",
    entities: ["知识库"],
    categorySlug: "technology-ai",
    categoryConfidence: 0.9,
    tags: ["知识管理", "阅读"],
    tagConfidence: 0.8
  }, { model: "test-model", promptVersion: "test-v1", sourceHash: "hash" });
  const analyzed = database.getArticle(completed.articleId);
  assert.equal(analyzed.knowledgeStatus, "analyzed");
  assert.equal(analyzed.categorySlug, "technology-ai");
  assert.deepEqual(analyzed.tags.sort(), ["知识管理", "阅读"].sort());
  assert.equal(database.listArticles({ query: "持久知识" }).length, 1);
  assert.equal(database.listArticles({ query: "要点二" }).length, 1);
  assert.equal(database.listArticles({ category: "technology-ai" }).length, 1);

  const missingUrl = "https://example.com/temporarily-missing";
  const missing = database.recordProgress({
    ...base,
    sessionId: "session-missing",
    articleUrl: missingUrl,
    activeMs: 180_000
  }, null);
  assert.equal(database.getArticle(missing.articleId).knowledgeStatus, "content_missing");
  const restored = database.recordProgress({
    ...base,
    sessionId: "session-missing",
    articleUrl: missingUrl,
    activeMs: 180_000
  }, {
    ...cachedItem,
    article: { ...cachedItem.article, url: missingUrl }
  });
  assert.equal(restored.analysisQueued, true);
  assert.equal(database.getArticle(missing.articleId).knowledgeStatus, "pending_analysis");
  database.close();
});

test("SecureSettingsStore encrypts Groq credentials at rest", async () => {
  const { SecureSettingsStore } = require("../src/main/services/secureSettingsStore");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reader-secure-settings-"));
  const fakeSafeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${value}`, "utf8"),
    decryptString: (buffer) => buffer.toString("utf8").replace(/^encrypted:/, "")
  };
  const store = new SecureSettingsStore(dir, { safeStorage: fakeSafeStorage });
  const key = "test-groq-key-with-enough-length";
  await store.saveGroqApiKey(key);
  await store.saveTranslationConsent(true);
  await store.saveReaderPreferences({ fontSize: 21, width: 780 });
  const raw = await fs.readFile(store.filePath, "utf8");
  assert.equal(raw.includes(key), false);
  assert.equal((await fs.stat(store.filePath)).mode & 0o777, 0o600);
  assert.equal(await store.getGroqApiKey(), key);
  const publicSettings = await store.getPublicSettings();
  assert.equal(publicSettings.configured, true);
  assert.equal(publicSettings.translationConsent, true);
  assert.deepEqual(publicSettings.readerPreferences, { fontSize: 21, width: 780 });
});

test("GroqAnalyzer requests deterministic JSON and normalizes Chinese knowledge output", async () => {
  const { GroqAnalyzer, sampleArticleText } = require("../src/main/services/groqAnalyzer");
  let requestOptions = null;
  const analyzer = new GroqAnalyzer({
    settingsStore: {
      getGroqApiKey: async () => "test-groq-key-with-enough-length",
      getModel: async () => "qwen/qwen3.6-27b"
    },
    request: async (_url, options) => {
      requestOptions = options;
      return {
        ok: true,
        status: 200,
        headers: {},
        text: JSON.stringify({
          choices: [{ message: { content: JSON.stringify({
            thesis: "文章讨论个人知识管理。",
            keyPoints: ["保存原文", "生成摘要", "允许人工修订"],
            evidence: ["系统使用结构化字段。"],
            whyItMatters: "知识可以长期检索。",
            categorySlug: "technology-ai",
            categoryConfidence: 0.9,
            tags: ["知识管理", "AI"],
            tagConfidence: 0.8,
            entities: ["SQLite"]
          }) } }]
        })
      };
    }
  });
  const result = await analyzer.analyze({
    title: "Knowledge",
    site_title: "Example",
    published_at: null,
    content_text: "Article body. ".repeat(500),
    content_hash: "source-hash"
  });
  const body = JSON.parse(requestOptions.body);
  assert.equal(body.response_format.type, "json_object");
  assert.equal(body.reasoning_effort, "none");
  assert.equal(requestOptions.headers.Authorization.startsWith("Bearer "), true);
  assert.equal(result.analysis.categorySlug, "technology-ai");
  assert.deepEqual(result.analysis.tags, ["知识管理", "AI"]);
  assert.equal(sampleArticleText("x".repeat(30_000), 1000).truncated, true);
});

test("extraction quality evaluator distinguishes article-like text from boilerplate", () => {
  const { evaluateExtractionQuality } = require("../src/main/services/extractionQualityEvaluator");
  const good = evaluateExtractionQuality({
    title: "A Long Report About Politics",
    content: `<p>${"A long report about politics and public life. ".repeat(160)}</p>`,
    textContent: "A long report about politics and public life. ".repeat(160)
  });
  const bad = evaluateExtractionQuality({
    title: "Subscribe",
    content: "<p>Subscribe sign in menu privacy advertisement related newsletter.</p>",
    textContent: "Subscribe sign in menu privacy advertisement related newsletter."
  });
  assert.ok(good.qualityScore > bad.qualityScore);
  assert.equal(bad.acceptable, false);
});

test("candidate filter rejects topic hubs, games, and sponsored utility content", () => {
  const { looksLikeArticleUrl, isSponsoredLike } = require("../src/main/services/candidateFilter");
  assert.equal(looksLikeArticleUrl("https://www.bbc.com/news/topics/cp7r8vgl2y7t"), false);
  assert.equal(looksLikeArticleUrl("https://slate.com/life/2026/08/crossword-puzzle.html"), false);
  assert.equal(looksLikeArticleUrl("https://example.com/lecturers/person/profile"), false);
  assert.equal(looksLikeArticleUrl("https://example.com/2026/08/a-real-reported-story"), true);
  assert.equal(isSponsoredLike("Daily Crossword", "https://example.com/story"), true);
});

test("reading progress follows scroll depth and preserves a new session during an in-flight save", async () => {
  const { JSDOM } = require("jsdom");
  const dom = new JSDOM("<!doctype html><article id='reader'></article>", {
    url: "file:///reader-test.html",
    runScripts: "outside-only"
  });
  const reader = dom.window.document.querySelector("#reader");
  let scrollTop = 0;
  Object.defineProperties(reader, {
    clientHeight: { configurable: true, get: () => 200 },
    scrollHeight: { configurable: true, get: () => 1000 },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value) => { scrollTop = Number(value); }
    }
  });
  Object.defineProperty(dom.window.document, "visibilityState", { configurable: true, value: "visible" });
  dom.window.document.hasFocus = () => true;

  let context = {
    articleUrl: "https://example.com/first",
    articleTitle: "First",
    siteId: "site",
    siteTitle: "Example",
    siteDomain: "example.com"
  };
  let resolveFirstSave;
  let saveCalls = 0;
  dom.window.readerApi = {
    saveReadingProgress: async (payload) => {
      saveCalls += 1;
      if (saveCalls === 1) {
        return new Promise((resolve) => {
          resolveFirstSave = () => resolve({
            ...payload,
            completed: false,
            thresholds: { activeMs: 180_000, scrollDepth: 0.9, bottomDwellMs: 5_000 }
          });
        });
      }
      return {
        ...payload,
        completed: false,
        thresholds: { activeMs: 180_000, scrollDepth: 0.9, bottomDwellMs: 5_000 }
      };
    }
  };
  const progressEvents = [];
  const source = await fs.readFile(path.join(__dirname, "..", "src", "renderer", "readingTracker.js"), "utf8");
  dom.window.eval(source);
  const tracker = dom.window.ReaderProgressTracker;
  tracker.configure({
    scrollElement: reader,
    getContext: () => context,
    isReaderVisible: () => true,
    onProgress: (progress) => progressEvents.push(progress),
    onCompleted: () => {},
    onError: (error) => { throw error; }
  });

  tracker.start();
  clearInterval(tracker.interval);
  assert.equal(tracker.getDisplayPercent(progressEvents.at(-1)), 20);
  scrollTop = 700;
  tracker.updateScrollDepth();
  tracker.renderProgress();
  assert.equal(tracker.getDisplayPercent(progressEvents.at(-1)), 90);
  tracker.resetScroll();
  assert.equal(scrollTop, 0);
  assert.equal(tracker.isActivelyReading(Date.now() + 179_000), true);
  assert.equal(tracker.isActivelyReading(Date.now() + 181_000), false);

  const pendingSave = tracker.flush();
  context = { ...context, articleUrl: "https://example.com/second", articleTitle: "Second" };
  scrollTop = 0;
  tracker.start();
  clearInterval(tracker.interval);
  const newSessionId = tracker.session.sessionId;
  resolveFirstSave();
  await pendingSave;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(tracker.session.sessionId, newSessionId);
  assert.equal(progressEvents.at(-1) === null, false, "old stop must not clear the new article progress");
  await tracker.stop();
  dom.window.close();
});

test("reader fixtures keep long-form and archive extraction complete", async () => {
  const { _extractFromHtml } = require("../src/main/services/readerMode");
  const { evaluateExtractionQuality } = require("../src/main/services/extractionQualityEvaluator");
  const fixtures = [
    {
      file: "newyorker-longform.html",
      url: "https://www.newyorker.com/magazine/2026/06/01/the-chaotic-new-era-of-british-politics",
      mustInclude: "old rhythms of political life"
    },
    {
      file: "economist-archive.html",
      url: "https://www.economist.com/middle-east-and-africa/2026/05/25/donald-trump-says-a-deal-with-iran-is-close",
      mustInclude: "discipline of compromise"
    },
    {
      file: "archive-multi-container.html",
      url: "https://archive.example/article",
      mustInclude: "multi-container extraction remains complete"
    }
  ];

  for (const fixture of fixtures) {
    const html = await fs.readFile(path.join(__dirname, "..", "tests", "fixtures", fixture.file), "utf8");
    const article = _extractFromHtml(fixture.url, html, { url: fixture.url, selectorMatches: [], errors: [] });
    const quality = evaluateExtractionQuality(article);
    assert.ok(article.textContent.includes(fixture.mustInclude), `${fixture.file} missing expected final-section text`);
    assert.ok(article.textContent.length >= 850, `${fixture.file} extracted too little text`);
    assert.equal(quality.acceptable, true, `${fixture.file} quality should be acceptable`);
  }
});

test("reader mode allows short verified articles only for scoped domains", () => {
  const { _extractFromHtml } = require("../src/main/services/readerMode");
  const paragraphs = Array.from({ length: 7 }, (_, index) => (
    `This verified short article paragraph number ${index + 1} contains enough editorial substance for a brief culture item.`
  ));
  const html = `<article><h1>Short culture item</h1>${paragraphs.map((text) => `<p>${text}</p>`).join("")}</article>`;
  const article = _extractFromHtml(
    "https://www.anothermanmag.com/life-culture/11207/watch-wild-daughter-new-video-for-song-bed-bugs",
    html,
    { url: "https://www.anothermanmag.com/life-culture/11207/watch-wild-daughter-new-video-for-song-bed-bugs", selectorMatches: [], errors: [] }
  );
  assert.ok(article.textContent.length >= 700);
  assert.throws(() => _extractFromHtml(
    "https://example.com/short",
    html,
    { url: "https://example.com/short", selectorMatches: [], errors: [] }
  ), /article text too short/);
});

test("runtime health report summarizes persisted health signals", () => {
  const { buildRuntimeHealthReport, renderRuntimeHealthReport } = require("../src/main/services/runtimeHealthReport");
  const report = buildRuntimeHealthReport({
    networkErrors: [{ error: "net::ERR_FAILED", url: "https://example.com/feed" }],
    articleHealth: {
      site1: {
        siteTitle: "Example",
        domain: "example.com",
        lastError: "article text too short"
      }
    },
    siteHealth: {
      sites: {
        site1: {
          siteTitle: "Example",
          domain: "example.com",
          botBlockedRate: 0.25,
          avgQualityScore: 0.4,
          lastFailureCategory: "blocked_by_bot"
        }
      }
    },
    browserMetrics: { cleanupFailures: 1 }
  });
  assert.equal(report.ok, false);
  assert.equal(report.summary.requestFailures, 1);
  assert.equal(report.summary.parserFailures, 1);
  assert.equal(report.summary.browserCleanupFailures, 1);
  assert.match(renderRuntimeHealthReport(report), /Runtime Health Report/);
  assert.match(renderRuntimeHealthReport(report), /Needs attention/);
});

test("runtime health report labels uncollected signals instead of reporting false zeroes", () => {
  const { buildRuntimeHealthReport, renderRuntimeHealthReport } = require("../src/main/services/runtimeHealthReport");
  const report = buildRuntimeHealthReport();
  assert.equal(report.complete, false);
  assert.equal(report.ok, false);
  assert.equal(report.summary.requestFailures, null);
  assert.match(renderRuntimeHealthReport(report), /Status: Incomplete/);
  assert.match(renderRuntimeHealthReport(report), /Request failures: not collected/);
});

test("request logging redacts query values and sensitive translation URLs", () => {
  const { formatUrlForLog } = require("../src/main/services/requestGovernor");
  const ordinary = formatUrlForLog("https://example.com/search?q=private+selection&token=secret#result");
  const sensitive = formatUrlForLog("https://translate.example/api?q=private+selection", { sensitiveUrl: true });
  assert.equal(ordinary, "https://example.com/search?[redacted]");
  assert.equal(sensitive, "https://translate.example/api");
  assert.doesNotMatch(`${ordinary} ${sensitive}`, /private|secret/);
});

test("RequestGovernor retries once and returns successful response", async () => {
  const httpClientPath = require.resolve("../src/main/services/httpClient");
  const governorPath = require.resolve("../src/main/services/requestGovernor");
  delete require.cache[governorPath];
  let calls = 0;
  require.cache[httpClientPath] = {
    id: httpClientPath,
    filename: httpClientPath,
    loaded: true,
    exports: {
      requestText: async () => {
        calls += 1;
        if (calls === 1) {
          const error = new Error("temporary network failure");
          error.kind = "network";
          throw error;
        }
        return { ok: true, status: 200, text: "ok", headers: {}, url: "https://example.com/feed" };
      }
    }
  };
  const { RequestGovernor } = require("../src/main/services/requestGovernor");
  const governor = new RequestGovernor({ minIntervalMs: 0, maxRetries: 1 });
  const response = await governor.request("https://example.com/feed", { source: "test", fetchMode: "feed" });
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
  delete require.cache[governorPath];
  delete require.cache[httpClientPath];
});

test("httpClient strips browser-only headers before Electron net requests", () => {
  const { sanitizeElectronNetHeaders } = require("../src/main/services/httpClient");
  const sanitized = sanitizeElectronNetHeaders({
    "Accept": "text/html",
    "Accept-Encoding": "gzip, br",
    "Sec-Fetch-Mode": "navigate",
    "Sec-CH-UA": "\"Chromium\"",
    "User-Agent": "reader-test"
  });
  assert.equal(sanitized.Accept, "text/html");
  assert.equal(sanitized["User-Agent"], "reader-test");
  assert.equal("Accept-Encoding" in sanitized, false);
  assert.equal("Sec-Fetch-Mode" in sanitized, false);
  assert.equal("Sec-CH-UA" in sanitized, false);
});

test("ArticlePipeline records a failed transition for disabled stages", async () => {
  const { ArticlePipeline } = require("../src/main/services/articlePipeline");
  const events = [];
  const siteHealthStore = {
    async getSiteHealth() {
      return null;
    },
    async record(_site, event) {
      events.push(event);
    }
  };
  const pipeline = new ArticlePipeline({ siteHealthStore });
  const articles = await pipeline.getCandidates(
    { id: "s", title: "S", url: "https://example.com/", domain: "example.com" },
    { enabledStages: ["disabled"], timeoutMs: 10, limit: 1 }
  );
  assert.deepEqual(articles, []);
  assert.equal(events.length, 1);
  assert.equal(events[0].ok, false);
});

test("ArticlePrefetcher can disable background warmup with env flag", async () => {
  const { ArticlePrefetcher } = require("../src/main/services/articlePrefetcher");
  const previous = process.env.READER_DISABLE_BACKGROUND_WARMUP;
  process.env.READER_DISABLE_BACKGROUND_WARMUP = "1";
  const prefetcher = new ArticlePrefetcher({
    siteStore: {},
    historyStore: {},
    articleCache: {},
    extractReaderArticle: async () => null,
    siteHealthStore: null
  });
  let warmupCalled = false;
  prefetcher.startBackgroundWarmup = () => {
    warmupCalled = true;
  };
  prefetcher.prepareNext = async () => ({ site: null, article: null, sites: [] });
  await prefetcher.start();
  assert.equal(warmupCalled, false);
  if (previous === undefined) {
    delete process.env.READER_DISABLE_BACKGROUND_WARMUP;
  } else {
    process.env.READER_DISABLE_BACKGROUND_WARMUP = previous;
  }
});

test("ArticlePrefetcher does not auto-import Chrome bookmarks when library is empty", async () => {
  const { ArticlePrefetcher } = require("../src/main/services/articlePrefetcher");
  const previous = process.env.READER_DISABLE_BACKGROUND_WARMUP;
  process.env.READER_DISABLE_BACKGROUND_WARMUP = "1";
  let imported = false;
  const prefetcher = new ArticlePrefetcher({
    siteStore: {
      listActiveSites: async () => [],
      ensureSeededFromChrome: async () => {
        imported = true;
      }
    },
    historyStore: { setActiveSiteIds: () => {} },
    articleCache: {},
    extractReaderArticle: async () => null,
    siteHealthStore: null
  });
  const result = await prefetcher.prepareNext();
  assert.equal(imported, false);
  assert.equal(result.site, null);
  assert.match(result.readerError, /No reading sources/);
  if (previous === undefined) {
    delete process.env.READER_DISABLE_BACKGROUND_WARMUP;
  } else {
    process.env.READER_DISABLE_BACKGROUND_WARMUP = previous;
  }
});

test("FallbackStormProtector suppresses repeated expensive browser fallback", () => {
  const { FallbackStormProtector } = require("../src/main/services/fallbackStormProtector");
  const protector = new FallbackStormProtector({ windowMs: 1000, expensiveBudget: 12 });
  const domain = "example.com";
  assert.equal(protector.canEnter({ domain, stageName: "browser" }).allowed, true);
  protector.record({ domain, stageName: "browser", ok: false });
  protector.record({ domain, stageName: "browser", ok: false });
  const decision = protector.canEnter({ domain, stageName: "browser" });
  assert.equal(decision.allowed, false);
});

test("BrowserExtractionController guarantees cleanup on worker failure", async () => {
  const { BrowserExtractionController } = require("../src/main/services/browserExtractionController");
  let stopped = false;
  let destroyed = false;
  let cleaned = false;
  class FakeBrowserWindow {
    constructor() {
      this.__destroyed = false;
      this.webContents = {
        once: (event, callback) => {
          if (event === "dom-ready") setTimeout(callback, 0);
        },
        stop: () => {
          stopped = true;
        }
      };
    }
    loadURL() {
      return Promise.resolve();
    }
    isDestroyed() {
      return this.__destroyed;
    }
    destroy() {
      destroyed = true;
      this.__destroyed = true;
    }
  }
  const controller = new BrowserExtractionController({
    BrowserWindowImpl: FakeBrowserWindow,
    attachDiagnostics: null,
    createSession: () => ({
      session: {},
      stats: {},
      cleanup: async () => {
        cleaned = true;
      }
    })
  });
  await assert.rejects(
    controller.run({
      url: "https://example.com/",
      label: "test",
      timeoutMs: 50,
      worker: async () => {
        throw new Error("worker failed");
      }
    }),
    /worker failed/
  );
  assert.equal(stopped, true);
  assert.equal(destroyed, true);
  assert.equal(cleaned, true);
});

test("BrowserExtractionController skips webContents stop after destruction", async () => {
  const { BrowserExtractionController } = require("../src/main/services/browserExtractionController");
  let stopCalls = 0;
  let cleaned = false;
  class DestroyedBeforeCleanupWindow {
    constructor() {
      this.__destroyed = false;
      this.webContents = {
        once: (event, callback) => {
          if (event === "dom-ready") setTimeout(callback, 0);
        },
        stop: () => {
          stopCalls += 1;
        },
        isDestroyed: () => true
      };
    }
    loadURL() {
      return Promise.resolve();
    }
    isDestroyed() {
      return this.__destroyed;
    }
    destroy() {
      this.__destroyed = true;
    }
  }
  const controller = new BrowserExtractionController({
    BrowserWindowImpl: DestroyedBeforeCleanupWindow,
    attachDiagnostics: null,
    createSession: () => ({
      session: {},
      stats: {},
      cleanup: async () => {
        cleaned = true;
      }
    })
  });
  await assert.rejects(
    controller.run({
      url: "https://example.com/",
      label: "test",
      timeoutMs: 50,
      worker: async () => {
        throw new Error("worker failed");
      }
    }),
    /worker failed/
  );
  assert.equal(stopCalls, 0);
  assert.equal(cleaned, true);
});

test("CapabilityResult and FailureObject normalize failure shape", () => {
  const { createCapabilityResult } = require("../src/main/services/capabilityContract");
  const result = createCapabilityResult({
    success: false,
    capabilityName: "feed",
    stage: "feed",
    strategySource: "test",
    failure: {
      category: "timeout",
      subcategory: "request_timeout",
      retryable: true,
      severity: "medium",
      transitionReason: "feed_timeout"
    }
  });
  assert.equal(result.success, false);
  assert.equal(result.capabilityName, "feed");
  assert.equal(result.failureCategory, "timeout");
  assert.equal(result.failure.retryable, true);
  assert.equal(result.failure.transitionReason, "feed_timeout");
});

test("CapabilityRegistry resolves capabilities by domain and priority", () => {
  const { CapabilityRegistry } = require("../src/main/services/capabilityRegistry");
  const registry = new CapabilityRegistry();
  const names = registry.list({ domain: "example.com" }).map((item) => item.name);
  assert.deepEqual(names, ["feed-sitemap", "sitemap", "browser", "archive"]);
  assert.equal(registry.get("browser").antiBotRisk, "high");
});

test("CapabilityRunner normalizes malformed capability output", async () => {
  const { CapabilityRunner } = require("../src/main/services/capabilityRunner");
  const runner = new CapabilityRunner();
  const runtime = await runner.run({
    capability: { name: "bad", stage: "feed" },
    context: { traceId: "t", strategySource: "test", domain: "example.com" },
    handler: async () => ({ data: { value: 1 } })
  });
  assert.equal(runtime.result.success, false);
  assert.equal(runtime.result.failure.transitionReason, "malformed_capability_output_normalized");
  assert.equal(runtime.metadata.stage, "feed");
});

test("CapabilityRunner converts timeout into normalized failure result", async () => {
  const { CapabilityRunner } = require("../src/main/services/capabilityRunner");
  const runner = new CapabilityRunner();
  const runtime = await runner.run({
    capability: { name: "slow", stage: "browser" },
    context: { traceId: "t", strategySource: "test", domain: "example.com" },
    timeoutMs: 5,
    handler: async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { success: true };
    }
  });
  assert.equal(runtime.result.success, false);
  assert.equal(runtime.result.failureCategory, "timeout");
  assert.equal(runtime.result.failure.retryable, true);
});

test("Replay report includes capability and decision summaries", () => {
  const { buildReplayReport } = require("../src/main/services/pipelineReplayReport");
  const report = buildReplayReport({
    traceId: "trace-1",
    site: { title: "Example", domain: "example.com" },
    strategy: "generic",
    state: "FAILURE",
    durationMs: 42,
    events: [
      { type: "transition", from: "INIT", to: "RESOLVE_STRATEGY", reason: "resolving_static_strategy_and_site_health" },
      {
        type: "stage",
        stageName: "feed",
        ok: false,
        transitionReason: "feed_timeout",
        failureCategory: "timeout",
        capabilityResult: {
          capabilityName: "feed",
          success: false,
          failureCategory: "timeout"
        },
        metadata: {
          costClass: "low"
        },
        policyDecision: {
          policyName: "storm-policy",
          decision: "allow_stage"
        }
      }
    ]
  });
  assert.equal(report.json.failureSummary.timeout, 1);
  assert.equal(report.json.capabilityResults[0].capabilityName, "feed");
  assert.equal(report.json.policyDecisions[0].policyName, "storm-policy");
  assert.equal(report.json.integrity.ok, false);
  assert.equal(report.json.integrity.issues.some((issue) => issue.code === "missing_capability_failure"), true);
  assert.match(report.text, /Capabilities: feed:timeout/);
  assert.match(report.text, /Replay integrity: failed/);
});

test("Replay integrity accepts ordered terminal traces", () => {
  const { validateReplayIntegrity } = require("../src/main/services/pipelineReplayReport");
  const integrity = validateReplayIntegrity({
    state: "SUCCESS",
    events: [
      { type: "transition", from: null, to: "INIT", reason: "pipeline_created" },
      { type: "transition", from: "INIT", to: "RESOLVE_STRATEGY", reason: "resolve" },
      { type: "transition", from: "RESOLVE_STRATEGY", to: "FEED_DISCOVERY", reason: "enter_stage:feed-sitemap" },
      { type: "transition", from: "FEED_DISCOVERY", to: "SUCCESS", reason: "article_candidates_found" }
    ]
  });
  assert.equal(integrity.ok, true);
  assert.equal(integrity.issueCount, 0);
});

test("Replay integrity flags broken transition chains", () => {
  const { validateReplayIntegrity } = require("../src/main/services/pipelineReplayReport");
  const integrity = validateReplayIntegrity({
    state: "FAILURE",
    events: [
      { type: "transition", from: null, to: "INIT", reason: "pipeline_created" },
      { type: "transition", from: "WRONG_STATE", to: "FAILURE", reason: "all_enabled_stages_failed" }
    ]
  });
  assert.equal(integrity.ok, true);
  assert.equal(integrity.issues.some((issue) => issue.code === "transition_chain_break"), true);
});

test("Replay integrity flags missing terminal state", () => {
  const { validateReplayIntegrity } = require("../src/main/services/pipelineReplayReport");
  const integrity = validateReplayIntegrity({
    state: "FEED_DISCOVERY",
    events: [
      { type: "transition", from: null, to: "INIT", reason: "pipeline_created" },
      { type: "transition", from: "INIT", to: "FEED_DISCOVERY", reason: "enter_stage:feed-sitemap" }
    ]
  });
  assert.equal(integrity.ok, false);
  assert.equal(integrity.issues.some((issue) => issue.code === "missing_terminal_state"), true);
});

test("Replay integrity flags failed capabilities without FailureObject", () => {
  const { validateReplayIntegrity } = require("../src/main/services/pipelineReplayReport");
  const integrity = validateReplayIntegrity({
    state: "FAILURE",
    events: [
      { type: "transition", from: null, to: "INIT", reason: "pipeline_created" },
      { type: "transition", from: "INIT", to: "FAILURE", reason: "all_enabled_stages_failed" },
      {
        type: "stage",
        stageName: "feed",
        ok: false,
        transitionReason: "feed_timeout",
        capabilityResult: {
          capabilityName: "feed",
          success: false,
          failureCategory: "timeout"
        }
      }
    ]
  });
  assert.equal(integrity.ok, false);
  assert.equal(integrity.issues.some((issue) => issue.code === "missing_capability_failure"), true);
});

test("PolicyDecision and TransitionRecord normalize policy replay shape", () => {
  const { createPolicyDecision, createTransitionRecord } = require("../src/main/services/policyContract");
  const decision = createPolicyDecision({
    policyName: "storm-policy",
    decision: "suppress_stage",
    reason: "expensive_fallback_budget_exceeded",
    triggeredBy: "browser",
    resultingTransition: "suppress:browser",
    suppressionApplied: true,
    fallbackAllowed: false
  });
  const transition = createTransitionRecord({
    from: "FEED_DISCOVERY",
    to: "BROWSER_DISCOVERY",
    policyName: decision.policyName,
    reason: decision.reason,
    suppressionStatus: decision.suppressionApplied,
    fallbackStatus: decision.fallbackAllowed
  });
  assert.equal(decision.suppressionApplied, true);
  assert.equal(decision.fallbackAllowed, false);
  assert.equal(transition.policyName, "storm-policy");
  assert.equal(transition.suppressionStatus, true);
});

test("http client rejects response bodies over the configured cap", async () => {
  const http = require("node:http");
  const { requestText } = require("../src/main/services/httpClient");
  const payload = "x".repeat(2048);
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(payload);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await assert.rejects(
      requestText(`http://127.0.0.1:${port}/large`, { maxBodyBytes: 128, timeoutMs: 3000 }),
      (error) => {
        assert.equal(error.code, "ERR_RESPONSE_TOO_LARGE");
        assert.match(error.message, /exceeded 128 bytes/);
        return true;
      }
    );
    const ok = await requestText(`http://127.0.0.1:${port}/ok`, { maxBodyBytes: 4096, timeoutMs: 3000 });
    assert.equal(ok.ok, true);
    assert.equal(ok.text, payload);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("article variant discovery keeps only credential-free http(s) URLs", () => {
  const { discoverArticleVariants } = require("../src/main/services/readerMode");
  const html = `
    <link rel="canonical" href="https://example.com/story">
    <link rel="amphtml" href="https://user:secret@example.com/amp">
    <a href="javascript:alert(1)">read more</a>
    <a href="/continue">continue reading</a>
    <a href="http://example.com/plain">keep reading</a>
    <a href="https://evil.example/nope">unrelated link</a>
  `;
  const urls = discoverArticleVariants(html, "https://example.com/base");
  assert.deepEqual(urls, [
    "https://example.com/base",
    "https://example.com/story",
    "https://example.com/continue",
    "http://example.com/plain"
  ]);
});

test("reading progress validation returns only whitelisted fields", () => {
  const { validateReadingProgress } = require("../src/main/services/inputValidation");
  const result = validateReadingProgress({
    sessionId: "session-1",
    articleUrl: "https://example.com/story#part",
    articleTitle: "Story",
    siteId: "site-1",
    siteTitle: "Example",
    siteDomain: "example.com",
    startedAt: "2026-08-08T00:00:00.000Z",
    activeMs: 1200,
    maxScrollDepth: 0.4,
    bottomDwellMs: 0,
    progressPercent: 42,
    injected: "drop-me",
    anchor: {
      kind: "paragraph",
      paragraphIndex: 2,
      charOffset: 15,
      paragraphCount: 8,
      progressPercent: 42,
      extra: "drop-me"
    }
  });
  assert.equal(result.injected, undefined);
  assert.equal(result.anchor.extra, undefined);
  assert.equal(result.articleUrl, "https://example.com/story");
  assert.equal(result.progressPercent, 42);
  assert.deepEqual(result.anchor, {
    kind: "paragraph",
    paragraphIndex: 2,
    charOffset: 15,
    paragraphCount: 8,
    progressPercent: 42
  });
  assert.deepEqual(Object.keys(result).sort(), [
    "activeMs",
    "anchor",
    "articleTitle",
    "articleUrl",
    "bottomDwellMs",
    "maxScrollDepth",
    "progressPercent",
    "sessionId",
    "siteDomain",
    "siteId",
    "siteTitle",
    "startedAt"
  ]);
});

test("request blocker cancels tracker hosts without blocking article images", () => {
  const { shouldCancelRequest } = require("../src/main/services/requestBlocker");
  assert.equal(shouldCancelRequest({
    url: "https://www.googletagmanager.com/gtm.js",
    resourceType: "script"
  }), true);
  assert.equal(shouldCancelRequest({
    url: "https://securepubads.g.doubleclick.net/ad.gif",
    resourceType: "image"
  }), true);
  assert.equal(shouldCancelRequest({
    url: "https://media.newyorker.com/photos/story.jpg",
    resourceType: "image"
  }), false);
  assert.equal(shouldCancelRequest({
    url: "https://www.theatlantic.com/article",
    resourceType: "mainFrame"
  }), false);
  assert.equal(shouldCancelRequest({
    url: "https://cdn.example.com/font.woff2",
    resourceType: "font"
  }), false);
});

test("bookmark folder selection defaults to detected legacy names and does not import them implicitly", async () => {
  const fsSync = require("node:fs");
  const { listChromeBookmarkFolders, readChromeBookmarks } = require("../src/main/services/bookmarks");
  const {
    defaultSelectedFolderPaths,
    summarizeFolderSelection,
    countUniqueAdditions
  } = require("../src/renderer/onboardingSelection");
  const { SiteStore } = require("../src/main/services/siteStore");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reader-bookmarks-"));
  const bookmarksPath = path.join(dir, "Bookmarks");
  fsSync.writeFileSync(bookmarksPath, JSON.stringify({
    roots: {
      bookmark_bar: {
        type: "folder",
        name: "书签栏",
        children: [
          {
            type: "folder",
            name: "English",
            children: [
              { type: "url", name: "A", url: "https://example.com/a" }
            ]
          },
          {
            type: "folder",
            name: "fashion",
            children: [{ type: "url", name: "B", url: "https://example.com/b" }]
          },
          {
            type: "folder",
            name: "literary award",
            children: [{ type: "url", name: "C", url: "https://example.com/c" }]
          },
          {
            type: "folder",
            name: "Science",
            children: [{ type: "url", name: "D", url: "https://example.com/d" }]
          }
        ]
      }
    }
  }));
  const listed = await listChromeBookmarkFolders({ bookmarksPath });
  const selected = defaultSelectedFolderPaths(listed.folders);
  assert.deepEqual(selected, [
    "书签栏/English",
    "书签栏/fashion",
    "书签栏/literary award"
  ]);
  assert.deepEqual(summarizeFolderSelection(listed.folders, selected), {
    folderCount: 3,
    linkCount: 3
  });
  const implicit = await readChromeBookmarks({ bookmarksPath });
  assert.deepEqual(implicit.sites, []);
  assert.equal(require("../src/main/services/bookmarks").DEFAULT_TARGET_FOLDERS, undefined);
  const store = new SiteStore(dir);
  await store.addSite({ title: "Already", url: "https://example.com/a", folderPath: "Library" });
  const imported = await store.applyOnboardingSelection({
    folderPaths: selected,
    packIds: [],
    bookmarksPath,
    completeOnboarding: true
  });
  assert.equal(imported.added, 2);
  assert.equal(imported.duplicates, 1);
  const tally = countUniqueAdditions(
    ["https://example.com/a"],
    ["https://example.com/a", "https://example.com/b", "https://example.com/b"]
  );
  assert.deepEqual(tally, { added: 1, duplicates: 2, accepted: ["https://example.com/b"] });
});

test("recommended source packs are the two built-in groups and import is deduped", async () => {
  const { loadSourcePacks } = require("../src/main/services/sourcePacks");
  const { SiteStore } = require("../src/main/services/siteStore");
  const packs = loadSourcePacks();
  assert.deepEqual(packs.map((pack) => pack.title), ["英文精读", "知识沉淀"]);
  const titles = packs.flatMap((pack) => pack.sites.map((site) => site.title)).sort();
  assert.deepEqual(titles, [
    "Pulitzer Prizes",
    "The Atlantic",
    "The Economist",
    "The Guardian",
    "The New York Times",
    "The New Yorker"
  ]);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reader-packs-"));
  const store = new SiteStore(dir);
  const first = await store.applyOnboardingSelection({
    folderPaths: [],
    packIds: packs.map((pack) => pack.id)
  });
  const second = await store.applyOnboardingSelection({
    folderPaths: [],
    packIds: packs.map((pack) => pack.id)
  });
  assert.equal(first.added, 6);
  assert.equal(first.duplicates, 0);
  assert.equal(second.added, 0);
  assert.equal(second.duplicates, 6);
  assert.equal((await store.listSites()).length, 6);
});

test("recent reading list keeps the newest 50 and read-later leaves when collected", async () => {
  const { KnowledgeDatabase, RECENT_READ_LIMIT } = require("../src/main/services/knowledgeDatabase");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reader-shelf-"));
  const database = new KnowledgeDatabase(dir);
  for (let index = 0; index < 60; index += 1) {
    database.touchRecent({
      articleUrl: `https://example.com/recent/${index}`,
      articleTitle: `Recent ${index}`,
      siteTitle: "Example",
      siteDomain: "example.com"
    });
  }
  const recent = database.listShelf("recent");
  assert.equal(RECENT_READ_LIMIT, 50);
  assert.equal(recent.length, 50);
  assert.equal(recent[0].articleTitle, "Recent 59");
  assert.equal(recent.some((item) => item.articleTitle === "Recent 0"), false);
  assert.equal(recent.some((item) => item.articleTitle === "Recent 10"), true);

  const articleUrl = "https://example.com/later-story?utm_source=test";
  database.saveForLater({
    articleUrl,
    articleTitle: "Later story",
    siteId: "site-1",
    siteTitle: "Example",
    siteDomain: "example.com",
    progressPercent: 20
  });
  assert.equal(database.listShelf("later").length, 1);
  const cachedItem = {
    site: { id: "site-1", title: "Example", domain: "example.com" },
    article: { title: "Later story", url: articleUrl },
    readerArticle: {
      title: "Later story",
      content: "<p>Collected article.</p>",
      textContent: "Collected article. ".repeat(80)
    }
  };
  const base = {
    articleUrl,
    articleTitle: "Later story",
    siteId: "site-1",
    siteTitle: "Example",
    siteDomain: "example.com",
    startedAt: "2026-08-08T00:00:00.000Z",
    maxScrollDepth: 0.95,
    bottomDwellMs: 5000,
    progressPercent: 95
  };
  const incomplete = database.recordProgress({ ...base, sessionId: "later-1", activeMs: 1000 }, cachedItem);
  assert.equal(incomplete.removedFromLater, null);
  assert.equal(database.listShelf("later").length, 1);
  const completed = database.recordProgress({ ...base, sessionId: "later-2", activeMs: 180_000 }, cachedItem);
  assert.equal(completed.newlyCompleted, true);
  assert.equal(completed.removedFromLater.articleTitle, "Later story");
  assert.equal(database.listShelf("later").length, 0);
  database.restoreReadLater(completed.removedFromLater);
  const again = database.recordProgress({ ...base, sessionId: "later-3", activeMs: 1000 }, cachedItem);
  assert.equal(again.removedFromLater, null);
  assert.equal(database.listShelf("later").length, 1);
  database.close();
});

test("resume prompt is offered only from 5% through 90%, with paragraph anchor fallback", async () => {
  const { KnowledgeDatabase } = require("../src/main/services/knowledgeDatabase");
  const { captureAnchor, isResumePromptRange, resolveRestoreTarget } = require("../src/renderer/readingAnchor");
  assert.equal(isResumePromptRange(4), false);
  assert.equal(isResumePromptRange(5), true);
  assert.equal(isResumePromptRange(90), true);
  assert.equal(isResumePromptRange(91), false);

  const paragraphs = [
    { top: 0, height: 100, textLength: 100 },
    { top: 100, height: 200, textLength: 80 }
  ];
  const anchor = captureAnchor({
    paragraphs,
    scrollTop: 180,
    scrollHeight: 1000,
    clientHeight: 200
  });
  assert.equal(anchor.kind, "paragraph");
  assert.equal(anchor.paragraphIndex, 1);
  assert.equal(anchor.charOffset, 32);
  assert.equal(anchor.progressPercent, 23);
  const restored = resolveRestoreTarget({
    paragraphs,
    scrollHeight: 1000,
    clientHeight: 200
  }, anchor);
  assert.equal(restored.mode, "paragraph");
  assert.equal(restored.paragraphIndex, 1);
  assert.equal(restored.scrollTop, 180);
  const fallback = resolveRestoreTarget({
    paragraphs: [{ top: 0, height: 40, textLength: 10 }],
    scrollHeight: 1000,
    clientHeight: 200
  }, anchor);
  assert.equal(fallback.mode, "percentage");
  assert.equal(fallback.scrollTop, Math.round(800 * (anchor.progressPercent / 100)));
  const noParagraphs = captureAnchor({
    paragraphs: [],
    scrollTop: 400,
    scrollHeight: 1000,
    clientHeight: 200
  });
  assert.equal(noParagraphs.kind, "percentage");

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reader-resume-"));
  const database = new KnowledgeDatabase(dir);
  const base = {
    articleUrl: "https://example.com/resume",
    articleTitle: "Resume story",
    siteId: "site-1",
    siteTitle: "Example",
    siteDomain: "example.com",
    startedAt: "2026-08-08T00:00:00.000Z",
    activeMs: 1000,
    maxScrollDepth: 0.3,
    bottomDwellMs: 0
  };
  database.recordProgress({
    ...base,
    sessionId: "resume-low",
    progressPercent: 42,
    anchor
  });
  assert.equal(database.getResumeOffer().progressPercent, 42);
  assert.equal(database.getResumeOffer().anchor.kind, "paragraph");
  database.recordProgress({
    ...base,
    articleUrl: "https://example.com/other",
    articleTitle: "Too far",
    sessionId: "resume-high",
    progressPercent: 96
  });
  assert.equal(database.getResumeOffer(), null);
  database.close();
});

test("reader shortcuts stay gated to the visible reader, and shelf time and continue tags stay explicit", () => {
  const { formatShelfTime, isReaderShortcutEnabled, shouldShowContinueTag } = require("../src/renderer/readingAnchor");
  const visible = {
    readerVisible: true,
    libraryOpen: false,
    shelfOpen: false,
    onboardingOpen: false,
    knowledgeOpen: false
  };
  assert.equal(isReaderShortcutEnabled(visible), true);
  assert.equal(isReaderShortcutEnabled({ ...visible, readerVisible: false }), false);
  assert.equal(isReaderShortcutEnabled({ ...visible, libraryOpen: true }), false);
  assert.equal(isReaderShortcutEnabled({ ...visible, shelfOpen: true }), false);
  assert.equal(isReaderShortcutEnabled({ ...visible, onboardingOpen: true }), false);
  assert.equal(isReaderShortcutEnabled({ ...visible, knowledgeOpen: true }), false);

  const now = new Date(2026, 10, 11, 18, 0, 0).getTime();
  assert.equal(formatShelfTime(new Date(2026, 10, 11, 13, 40, 0).toISOString(), now), "今天 13:40");
  assert.equal(formatShelfTime(new Date(2026, 10, 10, 9, 0, 0).toISOString(), now), "昨天");
  assert.equal(formatShelfTime(new Date(2026, 10, 8, 9, 0, 0).toISOString(), now), "11月08日");
  assert.equal(formatShelfTime("not-a-date", now), "");

  assert.equal(shouldShowContinueTag({ progressPercent: 42, collected: false }), true);
  assert.equal(shouldShowContinueTag({ progressPercent: 5, collected: false }), true);
  assert.equal(shouldShowContinueTag({ progressPercent: 90, collected: false }), true);
  assert.equal(shouldShowContinueTag({ progressPercent: 4, collected: false }), false);
  assert.equal(shouldShowContinueTag({ progressPercent: 91, collected: false }), false);
  assert.equal(shouldShowContinueTag({ progressPercent: 42, collected: true }), false);
});

test("opening a saved article does not increase the knowledge issue count", async () => {
  const { KnowledgeDatabase } = require("../src/main/services/knowledgeDatabase");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reader-open-saved-"));
  const database = new KnowledgeDatabase(dir);
  const before = database.getStats().total;
  database.saveForLater({
    articleUrl: "https://example.com/saved",
    articleTitle: "Saved",
    siteTitle: "Example",
    siteDomain: "example.com",
    progressPercent: 40
  });
  database.touchRecent({
    articleUrl: "https://example.com/saved",
    articleTitle: "Saved",
    siteTitle: "Example",
    siteDomain: "example.com",
    progressPercent: 40
  });
  assert.equal(database.getStats().total, before);
  assert.equal(database.listShelf("recent").length, 1);
  database.close();
});

test("secure storage availability follows safeStorage.isEncryptionAvailable", () => {
  const { SecureSettingsStore } = require("../src/main/services/secureSettingsStore");
  const calls = [];
  const store = new SecureSettingsStore("/tmp/unused-reader-settings", {
    safeStorage: {
      encryptString: () => Buffer.from("x"),
      decryptString: () => "x",
      isEncryptionAvailable: () => {
        calls.push("checked");
        return false;
      }
    }
  });
  assert.equal(store.canEncrypt(), false);
  assert.deepEqual(calls, ["checked"]);
  const fallback = new SecureSettingsStore("/tmp/unused-reader-settings", {
    safeStorage: {
      encryptString: () => Buffer.from("x"),
      decryptString: () => "x"
    }
  });
  assert.equal(fallback.canEncrypt(), ["darwin", "win32"].includes(process.platform));
});

test("StormPolicy returns explicit suppress policy decision", () => {
  const { StormPolicy } = require("../src/main/services/policies");
  const policy = new StormPolicy();
  const decision = policy.canEnter({
    domain: "example.com",
    stageName: "browser",
    health: { browserSuccessRate: 0.1, botBlockedRate: 0 }
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.policyDecision.policyName, "storm-policy");
  assert.equal(decision.policyDecision.suppressionApplied, true);
});

(async () => {
  for (const item of tests) {
    await item.fn();
    console.log(`ok - ${item.name}`);
  }
  console.log(`${tests.length} tests passed`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
