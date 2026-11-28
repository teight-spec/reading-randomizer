module.exports = function registerReliabilityBatch2Tests({ test, fs, path, assert, os }) {
  const {
    assignCurrent,
    createState,
    excludedUrls,
    isOnSkipCooldown,
    isUnfinished,
    recordSkip,
    startOpen
  } = require("../src/main/services/readingLoopState");
  const { ReadingLoopService } = require("../src/main/services/readingLoopService");
  const { KnowledgeDatabase } = require("../src/main/services/knowledgeDatabase");
  const { HistoryStore, urlsWithinOpenedCooldown } = require("../src/main/services/historyStore");
  const { ArticlePrefetcher } = require("../src/main/services/articlePrefetcher");

  const articleA = {
    articleUrl: "https://example.com/a",
    articleTitle: "Article A",
    siteId: "atlantic",
    siteTitle: "The Atlantic",
    siteDomain: "theatlantic.com"
  };
  const articleB = {
    articleUrl: "https://example.com/b",
    articleTitle: "Article B",
    siteId: "economist",
    siteTitle: "The Economist",
    siteDomain: "economist.com"
  };
  const articleC = {
    articleUrl: "https://example.com/c",
    articleTitle: "Article C",
    siteId: "nyt",
    siteTitle: "The New York Times",
    siteDomain: "nytimes.com"
  };

  function payloadFor(meta, extras = {}) {
    return {
      site: {
        id: meta.siteId,
        title: meta.siteTitle,
        domain: meta.siteDomain
      },
      article: { title: meta.articleTitle, url: meta.articleUrl, source: meta.siteTitle },
      readerArticle: {
        title: meta.articleTitle,
        url: meta.articleUrl,
        content: extras.content || `<p>${meta.articleTitle} body</p>`,
        textContent: extras.textContent || `${meta.articleTitle} body `.repeat(80)
      },
      readerError: null,
      skippedSites: []
    };
  }

  function makeService({ dir, queue, knowledgeDatabase, consumeCalls }) {
    return new ReadingLoopService({
      userDataPath: dir,
      historyStore: {
        async unmarkOpened() {
          return undefined;
        }
      },
      articlePrefetcher: {
        async consume({ excludeUrls = [] } = {}) {
          consumeCalls.push([...excludeUrls]);
          const next = queue.find((item) => !excludeUrls.includes(item.article.url));
          if (next) queue.splice(queue.indexOf(next), 1);
          return next || {
            site: null,
            article: null,
            readerArticle: null,
            readerError: "empty",
            skippedSites: []
          };
        }
      },
      articleCache: {
        async getArticle(url) {
          return payloadFor(
            [articleA, articleB, articleC].find((item) => item.articleUrl === url) || articleA
          );
        }
      },
      knowledgeDatabase,
      logPath: path.join(dir, "loop.log")
    });
  }

  test("opening resumes the unfinished article and its saved position, and does not draw a next article", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rr-batch2-resume-"));
    const queue = [payloadFor(articleA), payloadFor(articleB)];
    const consumeCalls = [];
    const knowledgeDatabase = {
      getReadingPosition(url) {
        assert.equal(url, articleA.articleUrl);
        return { progressPercent: 42, anchor: { kind: "percentage", progressPercent: 42 } };
      },
      listShelf() {
        return [];
      }
    };
    const service = makeService({ dir, queue, knowledgeDatabase, consumeCalls });
    await service.open();
    await service.accept();
    const consumeAfterAccept = consumeCalls.length;
    const resumed = await service.open();
    assert.equal(resumed.mode, "resume");
    assert.equal(resumed.article.url, articleA.articleUrl);
    assert.equal(resumed.resume.progressPercent, 42);
    assert.equal(resumed.loop.current.articleUrl, articleA.articleUrl);
    assert.equal(isUnfinished(resumed.loop), true);
    assert.equal(consumeCalls.length, consumeAfterAccept, "drawing the next article is not the open path");
  });

  test("a skipped article is not resumed on a later open, even if it is the latest knowledge seat", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rr-batch2-skip-"));
    const database = new KnowledgeDatabase(dir);
    database.recordProgress({
      articleUrl: articleA.articleUrl,
      articleTitle: articleA.articleTitle,
      siteId: articleA.siteId,
      siteTitle: articleA.siteTitle,
      siteDomain: articleA.siteDomain,
      sessionId: "seat-a",
      startedAt: "2026-11-28T02:00:00.000Z",
      activeMs: 20_000,
      maxScrollDepth: 0.4,
      bottomDwellMs: 0,
      progressPercent: 41
    });
    const queue = [payloadFor(articleA), payloadFor(articleB), payloadFor(articleC)];
    const consumeCalls = [];
    const service = makeService({
      dir,
      queue,
      knowledgeDatabase: {
        getReadingPosition(url) {
          return database.getReadingPosition(url);
        },
        getLatestReadingSeat() {
          return database.getLatestReadingSeat();
        },
        listShelf() {
          return [];
        }
      },
      consumeCalls
    });

    await service.open();
    await service.accept();
    const replaced = await service.skip();
    assert.equal(replaced.mode, "replace");
    assert.equal(replaced.article.url, articleB.articleUrl);

    const ended = await service.skip();
    assert.equal(ended.mode, "end");
    const seat = database.getLatestReadingSeat();
    assert.equal(seat.articleUrl, articleA.articleUrl);
    assert.equal(seat.completedAt, null);

    const later = await service.open();
    assert.equal(later.mode, "invite");
    assert.equal(later.article.url, articleC.articleUrl);
    assert.notEqual(later.article.url, articleA.articleUrl);
    assert.equal(isOnSkipCooldown(later.loop, articleA.articleUrl), true);
    assert.equal(isOnSkipCooldown(later.loop, articleB.articleUrl), true);
    database.close();
  });

  test("opening or scrolling a little is seen, not finished, and unopened candidates stay unfinished", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rr-batch2-seen-"));
    const database = new KnowledgeDatabase(dir);
    const cachedItem = {
      site: { id: "site-1", title: "Example", domain: "example.com" },
      article: { title: "Seen story", url: "https://example.com/seen" },
      readerArticle: {
        title: "Seen story",
        content: "<p>Only a little of this article was opened.</p>",
        textContent: "Only a little of this article was opened. ".repeat(40)
      }
    };
    const opened = database.recordProgress({
      articleUrl: cachedItem.article.url,
      articleTitle: cachedItem.article.title,
      siteId: "site-1",
      siteTitle: "Example",
      siteDomain: "example.com",
      sessionId: "seen-1",
      startedAt: "2026-11-28T02:00:00.000Z",
      activeMs: 8_000,
      maxScrollDepth: 0.12,
      bottomDwellMs: 0,
      progressPercent: 12
    }, cachedItem);
    assert.equal(opened.completed, false);
    assert.equal(opened.newlyCompleted, false);
    assert.equal(database.listArticles({}).length, 0);
    assert.equal(database.getLatestReadingSeat().completedAt, null);

    const candidateUrl = "https://example.com/unopened-candidate";
    assert.equal(database.getReadingPosition(candidateUrl), null);
    assert.equal(database.listArticles({}).some((item) => item.originalUrl === candidateUrl), false);
    database.close();
  });

  test("prefetch dedup expires seen and read URLs after the skip cooldown instead of excluding them forever", async () => {
    const now = Date.parse("2026-11-28T14:00:00+08:00");
    const recent = urlsWithinOpenedCooldown([
      { articleUrl: "https://recent.example/opened", openedAt: "2026-11-27T02:00:00.000Z" },
      { articleUrl: "https://stale.example/opened", openedAt: "2026-11-20T02:00:00.000Z" },
      { articleUrl: "https://undated.example/opened" }
    ], now);
    assert.deepEqual(recent, ["https://recent.example/opened"]);

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rr-batch2-prefetch-"));
    const store = new HistoryStore(dir);
    await store.save({
      openedArticles: [
        { articleUrl: "https://stale.example/opened", openedAt: "2026-11-20T02:00:00.000Z" },
        { articleUrl: "https://recent.example/opened", openedAt: "2026-11-27T02:00:00.000Z" }
      ],
      readArticles: [
        { articleUrl: "https://stale.example/read", readAt: "2026-11-01T02:00:00.000Z" }
      ],
      siteRound: { usedSiteIds: [] }
    });
    const prefetcher = new ArticlePrefetcher({
      historyStore: store,
      siteStore: { async listActiveSites() { return []; } },
      articleCache: { async getAnyReady() { return null; } },
      extractReaderArticle: async () => null
    });
    prefetcher.extraExcludeUrls = ["https://skipped.example/today"];
    const excluded = await prefetcher.getReadUrlSet({ now });
    assert.equal(excluded.has("https://recent.example/opened"), true);
    assert.equal(excluded.has("https://stale.example/opened"), false);
    assert.equal(excluded.has("https://stale.example/read"), false);
    assert.equal(excluded.has("https://skipped.example/today"), true);
  });

  test("crossing saves a cleaned body snapshot, and a missing snapshot is not offline readable", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rr-batch2-snapshot-"));
    const database = new KnowledgeDatabase(dir);
    const dirty = {
      site: { id: "site-1", title: "Example", domain: "example.com" },
      article: { title: "Finished story", url: "https://example.com/finished" },
      readerArticle: {
        title: "Finished story",
        content: `<p>Keep this text.</p><script>alert("x")</script><p onclick="evil()">More</p>`,
        textContent: "Keep this text. More"
      }
    };
    database.recordProgress({
      articleUrl: dirty.article.url,
      articleTitle: dirty.article.title,
      siteId: "site-1",
      siteTitle: "Example",
      siteDomain: "example.com",
      sessionId: "cross-1",
      startedAt: "2026-11-28T02:00:00.000Z",
      activeMs: 40_000,
      maxScrollDepth: 0.8,
      bottomDwellMs: 0,
      progressPercent: 80
    }, dirty);

    const saved = database.archiveCrossedReading({ cachedItem: dirty, progress: { articleUrl: dirty.article.url } });
    assert.equal(saved.snapshotSaved, true);
    assert.equal(saved.offlineReadable, true);
    assert.equal(saved.knowledgeStatus, "pending_analysis");
    const article = database.getArticle(saved.articleId);
    assert.equal(article.offlineReadable, true);
    assert.match(article.contentHtml, /Keep this text/);
    assert.doesNotMatch(article.contentHtml, /script|onclick/i);
    assert.equal(article.thesis, null);
    assert.equal(article.originalUrl, dirty.article.url);

    const missing = database.archiveCrossedReading({
      progress: {
        articleUrl: "https://example.com/no-body",
        articleTitle: "No body",
        siteTitle: "Example",
        siteDomain: "example.com",
        progressPercent: 88
      }
    });
    assert.equal(missing.snapshotSaved, false);
    assert.equal(missing.offlineReadable, false);
    assert.equal(missing.contentLabel, "正文未保存");
    const unsaved = database.getArticle(missing.articleId);
    assert.equal(unsaved.offlineReadable, false);
    assert.equal(unsaved.knowledgeStatus, "content_missing");
    assert.equal(unsaved.contentLabel, "正文未保存");
    assert.equal(unsaved.originalUrl, "https://example.com/no-body");
    assert.equal(unsaved.maxScrollDepth >= 0, true);
    database.close();
  });

  test("reading loop service persists a snapshot on cross and keeps the current article until then", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rr-batch2-cross-"));
    const database = new KnowledgeDatabase(dir);
    const queue = [payloadFor(articleA), payloadFor(articleB)];
    const consumeCalls = [];
    const service = makeService({
      dir,
      queue,
      knowledgeDatabase: {
        getReadingPosition(url) {
          return database.getReadingPosition(url) || { progressPercent: 91 };
        },
        getLatestReadingSeat() {
          return database.getLatestReadingSeat();
        },
        archiveCrossedReading(payload) {
          return database.archiveCrossedReading(payload);
        },
        listShelf() {
          return [];
        }
      },
      consumeCalls
    });
    await service.open();
    await service.accept();
    const consumeBeforeCross = consumeCalls.length;
    const afterCross = await service.cross();
    assert.equal(afterCross.mode, "invite");
    assert.equal(afterCross.inviteKind, "nextAfterCross");
    assert.equal(afterCross.article.url, articleB.articleUrl);
    assert.equal(afterCross.snapshot.snapshotSaved, true);
    assert.equal(afterCross.snapshot.offlineReadable, true);
    assert.equal(database.getArticle(afterCross.snapshot.articleId).offlineReadable, true);
    assert.ok(consumeCalls.length > consumeBeforeCross);
    database.close();
  });

  test("isOnSkipCooldown and excludedUrls keep a skipped URL out of resume and the short-term pool", () => {
    const now = Date.parse("2026-11-28T14:00:00+08:00");
    const afterSkip = recordSkip(assignCurrent(createState(), articleA, { via: "invite", now, enteredBody: true }), now);
    assert.equal(isUnfinished(afterSkip.state), false);
    assert.equal(isOnSkipCooldown(afterSkip.state, articleA.articleUrl, now), true);
    assert.equal(excludedUrls(afterSkip.state, now).includes(articleA.articleUrl), true);
    const laterDay = Date.parse("2026-12-02T09:00:00+08:00");
    assert.equal(isOnSkipCooldown(afterSkip.state, articleA.articleUrl, laterDay), false);
    const reopened = startOpen(afterSkip.state, now + 1000);
    assert.equal(reopened.decision, "invite");
  });
};
