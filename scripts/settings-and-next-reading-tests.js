module.exports = function registerSettingsAndNextReadingTests({ test, fs, path, assert, os }) {
  const { SecureSettingsStore } = require("../src/main/services/secureSettingsStore");
  const { ReadingLoopService } = require("../src/main/services/readingLoopService");
  const {
    createSession,
    classifyNextReadingOutcome,
    decideNextReadingView,
    decideLoopPickupView,
    settleRequest,
    MESSAGES
  } = require("../src/renderer/nextReadingSession");

  function fakeSafeStorage() {
    return {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`encrypted:${value}`, "utf8"),
      decryptString: (buffer) => buffer.toString("utf8").replace(/^encrypted:/, "")
    };
  }

  function delayWrite(writeJson, ms) {
    return async (filePath, data) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return writeJson(filePath, data);
    };
  }

  async function withStore(writeJson) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reader-secure-settings-"));
    const { writeJsonAtomic } = require("../src/main/services/jsonFile");
    return new SecureSettingsStore(dir, {
      safeStorage: fakeSafeStorage(),
      writeJson: writeJson || writeJsonAtomic
    });
  }

  test("concurrent privacy and reader preference saves keep both fields in either order", async () => {
    const { writeJsonAtomic } = require("../src/main/services/jsonFile");
    for (const order of ["consent-first", "prefs-first"]) {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const store = await withStore(delayWrite(writeJsonAtomic, 5));
        const tasks = order === "consent-first"
          ? [store.saveTranslationConsent(true), store.saveReaderPreferences({ fontSize: 24 })]
          : [store.saveReaderPreferences({ fontSize: 24 }), store.saveTranslationConsent(true)];
        await Promise.all(tasks);
        const publicSettings = await store.getPublicSettings();
        assert.equal(publicSettings.translationConsent, true, `${order} attempt ${attempt} lost consent`);
        assert.equal(publicSettings.readerPreferences.fontSize, 24, `${order} attempt ${attempt} lost font size`);
      }
    }
  });

  test("mocked secure storage keeps API key through concurrent preference saves and clear", async () => {
    const { writeJsonAtomic } = require("../src/main/services/jsonFile");
    const store = await withStore(delayWrite(writeJsonAtomic, 5));
    const key = "test-groq-key-with-enough-length";
    await Promise.all([
      store.saveGroqApiKey(key),
      store.saveReaderPreferences({ fontSize: 22, width: 800 })
    ]);
    assert.equal(await store.getGroqApiKey(), key);
    let publicSettings = await store.getPublicSettings();
    assert.equal(publicSettings.configured, true);
    assert.equal(publicSettings.readerPreferences.fontSize, 22);
    assert.equal(publicSettings.readerPreferences.width, 800);

    await Promise.all([
      store.saveGroqApiKey(""),
      store.saveReaderPreferences({ fontSize: 18 })
    ]);
    assert.equal(await store.getGroqApiKey(), "");
    publicSettings = await store.getPublicSettings();
    assert.equal(publicSettings.configured, false);
    assert.equal(publicSettings.readerPreferences.fontSize, 18);
    assert.equal(publicSettings.readerPreferences.width, 800);
  });

  test("translation consent stays off after a new store instance reloads the file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reader-secure-settings-"));
    const first = new SecureSettingsStore(dir, { safeStorage: fakeSafeStorage() });
    await first.saveTranslationConsent(true);
    await first.saveTranslationConsent(false);
    const restarted = new SecureSettingsStore(dir, { safeStorage: fakeSafeStorage() });
    const publicSettings = await restarted.getPublicSettings();
    assert.equal(publicSettings.translationConsent, false);
  });

  test("a failed settings write does not block later valid updates", async () => {
    const { writeJsonAtomic } = require("../src/main/services/jsonFile");
    let shouldFail = true;
    const store = await withStore(async (filePath, data) => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error("injected write failure");
      }
      return writeJsonAtomic(filePath, data);
    });
    await assert.rejects(() => store.saveTranslationConsent(true), /injected write failure/);
    const saved = await store.saveReaderPreferences({ fontSize: 24 });
    assert.equal(saved.translationConsent, false);
    assert.equal(saved.readerPreferences.fontSize, 24);
  });

  test("next reading classification separates no sources, empty draw, extract failure and timeout", () => {
    assert.equal(classifyNextReadingOutcome({
      result: { site: null, article: null, readerArticle: null, readerError: "No reading sources yet.", sites: [] }
    }).kind, "no_sources");
    assert.equal(classifyNextReadingOutcome({
      result: { site: null, article: null, readerArticle: null, readerError: "No valid article passed extraction filters", sites: [{ id: "s1" }] }
    }).kind, "unavailable");
    assert.equal(classifyNextReadingOutcome({
      result: {
        site: null,
        article: null,
        readerArticle: null,
        readerError: "No valid article passed extraction filters",
        sites: [{ id: "s1" }],
        skippedSites: [{ articleUrl: "https://example.com/candidate", reason: "extract failed" }]
      }
    }).kind, "extract_failed");
    assert.equal(classifyNextReadingOutcome({
      error: new Error("request timeout after 12000ms")
    }).kind, "timeout");
  });

  test("failed next-reading results keep article A until a valid B arrives", () => {
    const current = {
      article: { url: "https://example.com/a", title: "A" },
      scrollTop: 480,
      progress: 37
    };
    for (const payload of [
      { error: new Error("request timeout after 12000ms") },
      { result: { site: null, article: null, readerArticle: null, sites: [{ id: "s1" }], readerError: "No valid article" } },
      { result: { site: null, article: null, readerArticle: null, sites: [{ id: "s1" }], skippedSites: [{ articleUrl: "https://example.com/c" }] } }
    ]) {
      const view = decideNextReadingView(classifyNextReadingOutcome(payload), { hasCurrentArticle: true });
      assert.equal(view.replaceCurrent, false);
      assert.equal(view.keepCurrent, true);
      assert.equal(view.showImportGuide, false);
      assert.equal(view.nextReading, null);
      assert.equal(current.article.url, "https://example.com/a");
      assert.equal(current.scrollTop, 480);
      assert.equal(current.progress, 37);
    }

    const ready = decideNextReadingView(classifyNextReadingOutcome({
      result: {
        site: { id: "s2" },
        article: { url: "https://example.com/b", title: "B" },
        readerArticle: { url: "https://example.com/b", content: "<p>B</p>" },
        sites: [{ id: "s2" }]
      }
    }), { hasCurrentArticle: true });
    assert.equal(ready.replaceCurrent, true);
    assert.equal(ready.nextReading.article.url, "https://example.com/b");
  });

  test("stale next-reading results cannot overwrite a newer source choice", () => {
    const session = createSession();
    const currentA = { article: { url: "https://example.com/a", title: "A" } };
    const first = session.begin();
    const second = session.begin();
    const lateFirst = settleRequest(session, first, {
      result: {
        site: { id: "s-old" },
        article: { url: "https://example.com/late", title: "Late" },
        readerArticle: { url: "https://example.com/late", content: "<p>Late</p>" },
        sites: [{ id: "s-old" }]
      }
    }, currentA);
    assert.equal(lateFirst.accepted, false);
    assert.equal(lateFirst.stale, true);

    const selected = settleRequest(session, second, {
      result: {
        site: { id: "s-new" },
        article: { url: "https://example.com/chosen", title: "Chosen" },
        readerArticle: { url: "https://example.com/chosen", content: "<p>Chosen</p>" },
        sites: [{ id: "s-new" }]
      },
      action: "site"
    }, currentA);
    assert.equal(selected.accepted, true);
    assert.equal(selected.view.replaceCurrent, true);
    assert.equal(selected.view.nextReading.article.url, "https://example.com/chosen");
  });

  test("import guide is only shown when no sources are configured and nothing is being read", () => {
    const noSources = classifyNextReadingOutcome({
      result: { site: null, article: null, readerArticle: null, readerError: "No reading sources yet.", sites: [] }
    });
    const emptyWithCurrent = decideNextReadingView(noSources, { hasCurrentArticle: true });
    assert.equal(emptyWithCurrent.showImportGuide, false);
    assert.equal(emptyWithCurrent.keepCurrent, true);
    const emptyWithoutCurrent = decideNextReadingView(noSources, { hasCurrentArticle: false });
    assert.equal(emptyWithoutCurrent.showImportGuide, true);
    const unavailable = decideNextReadingView(classifyNextReadingOutcome({
      result: { site: null, article: null, readerArticle: null, sites: [{ id: "s1" }], readerError: "No valid article" }
    }), { hasCurrentArticle: false });
    assert.equal(unavailable.showImportGuide, false);
    assert.equal(unavailable.notice.kind, "unavailable");
  });

  test("a failed loop skip stays on the current article and does not show the import guide", () => {
    const current = { article: { url: "https://example.com/a", title: "A" }, scrollTop: 240, progress: 41 };
    for (const result of [
      { mode: "skipFailed", keptCurrent: true, site: null, article: null, readerArticle: null, readerError: "No valid article passed extraction filters", sites: [{ id: "s1" }] },
      { mode: "skipFailed", keptCurrent: true, site: null, article: null, readerArticle: null, readerError: "request timeout", sites: [{ id: "s1" }] },
      {
        mode: "skipFailed",
        keptCurrent: true,
        site: null,
        article: null,
        readerArticle: null,
        readerError: "No valid article passed extraction filters",
        sites: [{ id: "s1" }],
        skippedSites: [{ articleUrl: "https://example.com/candidate" }]
      }
    ]) {
      const view = decideLoopPickupView(result, { hasCurrentArticle: true, action: "skip" });
      assert.equal(view.replaceCurrent, false);
      assert.equal(view.keepCurrent, true);
      assert.equal(view.showImportGuide, false);
      assert.equal(view.showSessionEnd, false);
      assert.equal(view.applyLoopResult, false);
      assert.equal(current.article.url, "https://example.com/a");
      assert.equal(current.scrollTop, 240);
      assert.equal(current.progress, 41);
    }
  });

  test("loop empty and emptyAfterCross states do not redirect to bookmark import when sources exist", () => {
    const emptyAfterDraw = decideLoopPickupView({
      mode: "empty",
      site: null,
      article: null,
      readerArticle: null,
      readerError: "No valid article passed extraction filters",
      sites: [{ id: "s1" }]
    }, { hasCurrentArticle: false, action: "open" });
    assert.equal(emptyAfterDraw.showImportGuide, false);
    assert.equal(emptyAfterDraw.notice.kind, "unavailable");

    const afterCross = decideLoopPickupView({
      mode: "emptyAfterCross",
      site: null,
      article: null,
      readerArticle: null,
      readerError: "No reading sources yet.",
      sites: []
    }, { hasCurrentArticle: true, action: "cross" });
    assert.equal(afterCross.showImportGuide, false);
    assert.equal(afterCross.keepCurrent, true);

    const noSourcesOpen = decideLoopPickupView({
      mode: "empty",
      site: null,
      article: null,
      readerArticle: null,
      readerError: "No reading sources yet.",
      sites: []
    }, { hasCurrentArticle: false, action: "open" });
    assert.equal(noSourcesOpen.showImportGuide, true);

    const invite = decideLoopPickupView({
      mode: "invite",
      site: { id: "s1" },
      article: { url: "https://example.com/b", title: "B" },
      readerArticle: { content: "<p>B</p>" }
    }, { hasCurrentArticle: false, action: "open" });
    assert.equal(invite.applyLoopResult, true);
    assert.equal(invite.showImportGuide, false);
  });

  test("a late skip result cannot replace a newer source selection", () => {
    const session = createSession();
    const currentA = { article: { url: "https://example.com/a", title: "A" } };
    const skipGen = session.begin();
    const siteGen = session.begin();
    const lateSkip = settleRequest(session, skipGen, {
      action: "skip",
      result: {
        mode: "replace",
        site: { id: "s-skip" },
        article: { url: "https://example.com/skipped-next", title: "Skipped next" },
        readerArticle: { url: "https://example.com/skipped-next", content: "<p>Skip</p>" }
      }
    }, currentA);
    assert.equal(lateSkip.accepted, false);
    assert.equal(lateSkip.stale, true);

    const siteChoice = settleRequest(session, siteGen, {
      action: "site",
      result: {
        site: { id: "s-chosen" },
        article: { url: "https://example.com/chosen", title: "Chosen" },
        readerArticle: { url: "https://example.com/chosen", content: "<p>Chosen</p>" },
        sites: [{ id: "s-chosen" }]
      }
    }, currentA);
    assert.equal(siteChoice.accepted, true);
    assert.equal(siteChoice.view.replaceCurrent, true);
    assert.equal(siteChoice.view.nextReading.article.url, "https://example.com/chosen");
  });

  test("reading loop service keeps the current article when a skip cannot pick a readable next one", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reading-loop-skip-fail-"));
    const articleA = {
      site: { id: "atlantic", title: "The Atlantic", domain: "theatlantic.com" },
      article: { title: "Article A", url: "https://example.com/a", source: "The Atlantic" },
      readerArticle: { title: "Article A", url: "https://example.com/a", content: "<p>A body</p>", textContent: "A body ".repeat(80) },
      readerError: null,
      skippedSites: []
    };
    let consumeCalls = 0;
    const unmarks = [];
    const service = new ReadingLoopService({
      userDataPath: dir,
      historyStore: {
        async unmarkOpened(url) {
          unmarks.push(url);
        }
      },
      articlePrefetcher: {
        async consume() {
          consumeCalls += 1;
          if (consumeCalls === 1) return articleA;
          return {
            site: null,
            article: null,
            readerArticle: null,
            readerError: "No valid article passed extraction filters",
            skippedSites: [{ articleUrl: "https://example.com/candidate", reason: "extract failed" }],
            sites: [{ id: "atlantic" }]
          };
        }
      },
      articleCache: {
        async getArticle() {
          return articleA;
        }
      },
      knowledgeDatabase: {
        getReadingPosition() {
          return { progressPercent: 41, anchor: { kind: "percentage", progressPercent: 41 } };
        },
        listShelf() {
          return [];
        }
      },
      logPath: path.join(dir, "loop.log")
    });

    const opened = await service.open();
    assert.equal(opened.mode, "invite");
    await service.accept();
    const before = await service.getState();
    assert.equal(before.current.articleUrl, "https://example.com/a");
    assert.equal(Number(before.session?.skipCount || 0), 0);

    const failed = await service.skip();
    assert.equal(failed.mode, "skipFailed");
    assert.equal(failed.keptCurrent, true);
    assert.equal(failed.loop.current.articleUrl, "https://example.com/a");
    assert.equal(Boolean(failed.loop.session?.ended), false);
    assert.equal(Number(failed.loop.session?.skipCount || 0), 0);
    assert.equal(unmarks.length, 0);

    const after = await service.getState();
    assert.equal(after.current.articleUrl, "https://example.com/a");
    const view = decideLoopPickupView(failed, { hasCurrentArticle: true, action: "skip" });
    assert.equal(view.keepCurrent, true);
    assert.equal(view.showImportGuide, false);
  });
};
