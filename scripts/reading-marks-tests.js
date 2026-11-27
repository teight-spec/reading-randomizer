module.exports = function registerReadingMarksTests({ test, fs, path, assert, os }) {
  const {
    assignCurrent,
    createState,
    isUnfinished,
    markCrossed,
    startOpen
  } = require("../src/main/services/readingLoopState");
  const {
    addMarkToState,
    applyMarksToHtml,
    bookmarkBlocksInvite,
    createMark,
    hasPendingBookmark,
    marksFor,
    occasionalScore,
    pickBookmarkMark,
    resolvePendingBookmark,
    setPendingBookmark,
    shouldOfferBookmark
  } = require("../src/main/services/readingMarks");
  const { ReadingLoopService } = require("../src/main/services/readingLoopService");

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

  function payloadFor(meta) {
    return {
      site: { id: meta.siteId, title: meta.siteTitle, domain: meta.siteDomain },
      article: { title: meta.articleTitle, url: meta.articleUrl, source: meta.siteTitle },
      readerArticle: {
        title: meta.articleTitle,
        url: meta.articleUrl,
        content: `<p>The original sentence lives here.</p><p>${meta.articleTitle} body</p>`,
        textContent: `The original sentence lives here. ${meta.articleTitle} body`
      },
      readerError: null,
      skippedSites: []
    };
  }

  function urlWithOccasional(shouldOffer) {
    for (let index = 0; index < 400; index += 1) {
      const url = `https://example.com/occ-${index}`;
      const offers = occasionalScore(url) < (1 / 3);
      if (offers === shouldOffer) return url;
    }
    throw new Error("could not find a stable occasional URL");
  }

  test("a highlight stays in the article html, with or without a note", () => {
    const bare = createMark({ quote: "The original sentence lives here." });
    const noted = createMark({
      quote: "The original sentence lives here.",
      note: "  这是我当时的理解  "
    });
    assert.equal(bare.note, null);
    assert.equal(noted.note, "这是我当时的理解");
    const html = "<p>Lead. The original sentence lives here. After.</p>";
    const painted = applyMarksToHtml(html, [bare]);
    assert.match(painted, /reading-inline-mark/);
    assert.match(painted, /The original sentence lives here\./);
    assert.equal(painted.includes("lead-chat"), false);
  });

  test("bookmark is not a crossing switch, and resume never pops a bookmark", () => {
    const now = Date.parse("2026-11-27T08:00:00+08:00");
    let state = assignCurrent(createState(), articleA, { via: "invite", now, enteredBody: true });
    const added = addMarkToState(state, articleA.articleUrl, {
      quote: "A kept sentence",
      note: "my note"
    }, now);
    state = added.state;
    assert.equal(isUnfinished(state), true);
    assert.equal(shouldOfferBookmark({
      isResume: true,
      hasCrossed: false,
      marks: marksFor(state, articleA.articleUrl),
      articleUrl: articleA.articleUrl
    }), false);
    const beforeCross = shouldOfferBookmark({
      isResume: false,
      hasCrossed: false,
      marks: marksFor(state, articleA.articleUrl),
      articleUrl: articleA.articleUrl
    });
    assert.equal(beforeCross, false);
    const crossed = markCrossed(state, now);
    assert.equal(Boolean(crossed.current.crossedAt), true);
    assert.equal(shouldOfferBookmark({
      isResume: false,
      hasCrossed: true,
      marks: marksFor(crossed, articleA.articleUrl),
      articleUrl: articleA.articleUrl
    }), true);
  });

  test("a bare highlight is only offered occasionally after crossing", () => {
    const yesUrl = urlWithOccasional(true);
    const noUrl = urlWithOccasional(false);
    const marks = [createMark({ quote: "Only a line in the margin." })];
    assert.equal(shouldOfferBookmark({
      isResume: false,
      hasCrossed: true,
      marks,
      articleUrl: yesUrl
    }), true);
    assert.equal(shouldOfferBookmark({
      isResume: false,
      hasCrossed: true,
      marks,
      articleUrl: noUrl
    }), false);
    assert.equal(shouldOfferBookmark({
      isResume: false,
      hasCrossed: true,
      marks: [],
      articleUrl: yesUrl
    }), false);
  });

  test("bookmark and invite must not share the same screen, and invite waits until the bookmark is resolved", () => {
    assert.equal(bookmarkBlocksInvite(true, true), true);
    assert.equal(bookmarkBlocksInvite(true, false), false);
    let state = assignCurrent(createState(), articleA, { via: "invite", enteredBody: true });
    state = markCrossed(state, Date.now());
    const mark = createMark({ quote: "A kept sentence", note: "why it stayed" });
    state = setPendingBookmark(state, mark, articleA.articleUrl);
    state.pendingInvite = { articleUrl: articleB.articleUrl, articleTitle: articleB.articleTitle };
    const opened = startOpen(state, Date.now());
    assert.equal(opened.decision, "pendingBookmark");
    assert.equal(hasPendingBookmark(opened.state), true);
    const resolved = resolvePendingBookmark(opened.state);
    assert.equal(hasPendingBookmark(resolved), false);
    const after = startOpen(resolved, Date.now() + 1000);
    assert.equal(after.decision, "pendingInvite");
    assert.equal(pickBookmarkMark([mark]).note, "why it stayed");
  });

  test("reading loop service: save a mark, resume paints it, cross may bookmark, dismiss then invite", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reading-marks-service-"));
    const queue = [payloadFor(articleA), payloadFor(articleB)];
    const service = new ReadingLoopService({
      userDataPath: dir,
      articlePrefetcher: {
        async consume({ excludeUrls = [] } = {}) {
          const next = queue.find((item) => !excludeUrls.includes(item.article.url));
          if (next) queue.splice(queue.indexOf(next), 1);
          return next || { site: null, article: null, readerArticle: null, readerError: "empty" };
        }
      },
      articleCache: {
        async getArticle(url) {
          return payloadFor(url === articleB.articleUrl ? articleB : articleA);
        }
      },
      knowledgeDatabase: { listShelf() { return []; }, getReadingPosition() { return { progressPercent: 40, anchor: { kind: "percentage", progressPercent: 40 } }; } },
      logPath: path.join(dir, "loop.log")
    });

    await service.open();
    await service.accept();
    const saved = await service.saveMark({
      articleUrl: articleA.articleUrl,
      quote: "The original sentence lives here.",
      note: "remember this"
    });
    assert.equal(saved.mark.quote, "The original sentence lives here.");
    assert.equal(saved.mark.note, "remember this");

    const resumed = await service.open();
    assert.equal(resumed.mode, "resume");
    assert.equal(resumed.bookmark, undefined);
    assert.equal((resumed.marks || []).length, 1);
    const painted = applyMarksToHtml(resumed.readerArticle.content, resumed.marks);
    assert.match(painted, /reading-inline-mark/);

    const afterCross = await service.cross();
    assert.equal(afterCross.mode, "bookmark");
    assert.equal(afterCross.bookmark.quote, "The original sentence lives here.");
    assert.equal(afterCross.bookmark.note, "remember this");
    assert.equal(afterCross.loop.current.crossedAt.length > 0, true);
    assert.equal(Boolean(afterCross.loop.pendingInvite?.articleUrl), true);
    assert.equal(afterCross.mode === "invite", false);

    const afterView = await service.resolveBookmark({ action: "view" });
    assert.equal(afterView.mode, "invite");
    assert.equal(afterView.inviteKind, "nextAfterCross");
    assert.equal(afterView.article.url, articleB.articleUrl);
    assert.equal(hasPendingBookmark(afterView.loop), false);
  });

  test("reading loop service: crossing with no marks still invites, and a note is not required to finish", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reading-marks-none-"));
    const queue = [payloadFor(articleA), payloadFor(articleB)];
    const service = new ReadingLoopService({
      userDataPath: dir,
      articlePrefetcher: {
        async consume({ excludeUrls = [] } = {}) {
          const next = queue.find((item) => !excludeUrls.includes(item.article.url));
          if (next) queue.splice(queue.indexOf(next), 1);
          return next || { site: null, article: null, readerArticle: null, readerError: "empty" };
        }
      },
      articleCache: {
        async getArticle(url) {
          return payloadFor(url === articleB.articleUrl ? articleB : articleA);
        }
      },
      knowledgeDatabase: { listShelf() { return []; }, getReadingPosition() { return null; } },
      logPath: path.join(dir, "loop.log")
    });
    await service.open();
    await service.accept();
    const afterCross = await service.cross();
    assert.equal(afterCross.mode, "invite");
    assert.equal(afterCross.inviteKind, "nextAfterCross");
    assert.equal(afterCross.loop.current.crossedAt.length > 0, true);
    assert.equal(hasPendingBookmark(afterCross.loop), false);
  });
};
