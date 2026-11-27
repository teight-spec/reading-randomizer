module.exports = function registerReadingLoopTests({ test, fs, path, assert, os }) {
  const {
    SKIP_COOLDOWN_DAYS,
    acceptInvite,
    assignCurrent,
    buildInviteReason,
    calendarDayDiff,
    createState,
    dayKey,
    excludedUrls,
    hasReliableEnd,
    isUnfinished,
    markCrossed,
    recordSkip,
    setPendingInvite,
    shouldCrossFromAction,
    shouldCrossFromScroll,
    shouldRevealCloseout,
    startOpen
  } = require("../src/main/services/readingLoopState");
  const { ReadingLoopStore } = require("../src/main/services/readingLoopStore");
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

  test("opening with an unfinished article resumes the body and skips the invite", () => {
    const now = Date.parse("2026-11-27T06:00:00+08:00");
    let state = assignCurrent(createState(), articleA, { via: "invite", now, enteredBody: true });
    const opened = startOpen(state, now);
    assert.equal(opened.decision, "resume");
    assert.equal(isUnfinished(opened.state), true);
    assert.equal(opened.state.current.articleUrl, articleA.articleUrl);
    assert.equal(opened.state.session.skipCount, 0);
    assert.equal(opened.state.session.ended, false);
  });

  test("opening without an unfinished article asks for an invite, not a resume", () => {
    const now = Date.parse("2026-11-27T06:00:00+08:00");
    const opened = startOpen(createState(), now);
    assert.equal(opened.decision, "invite");
    assert.equal(isUnfinished(opened.state), false);
  });

  test("the same open allows one skip replacement, and a second skip ends the open", () => {
    const now = Date.parse("2026-11-27T06:00:00+08:00");
    let state = startOpen(createState(), now).state;
    state = assignCurrent(state, articleA, { via: "invite", now, enteredBody: true });
    const first = recordSkip(state, now);
    assert.equal(first.decision, "replace");
    assert.equal(first.state.session.skipCount, 1);
    assert.equal(first.state.session.ended, false);
    assert.equal(isUnfinished(first.state), false);
    state = assignCurrent(first.state, articleB, { via: "replace", now, enteredBody: true });
    const second = recordSkip(state, now + 1000);
    assert.equal(second.decision, "end");
    assert.equal(second.state.session.skipCount, 2);
    assert.equal(second.state.session.ended, true);
    assert.equal(isUnfinished(second.state), false);
    assert.deepEqual(
      excludedUrls(second.state, now).sort(),
      [articleA.articleUrl, articleB.articleUrl].sort()
    );
  });

  test("a later open the same day can invite another article, excluding today's skips", () => {
    const morning = Date.parse("2026-11-27T06:00:00+08:00");
    const evening = Date.parse("2026-11-27T21:00:00+08:00");
    let state = startOpen(createState(), morning).state;
    state = assignCurrent(state, articleA, { via: "invite", now: morning, enteredBody: true });
    const first = recordSkip(state, morning);
    state = assignCurrent(first.state, articleB, { via: "replace", now: morning, enteredBody: true });
    const ended = recordSkip(state, morning + 1000);
    const reopened = startOpen(ended.state, evening);
    assert.equal(reopened.decision, "invite");
    assert.equal(reopened.state.session.skipCount, 0);
    assert.equal(reopened.state.session.ended, false);
    const excluded = excludedUrls(reopened.state, evening);
    assert.equal(excluded.includes(articleA.articleUrl), true);
    assert.equal(excluded.includes(articleB.articleUrl), true);
  });

  test("skipped URLs can return after the cooldown, and skip is not a permanent deletion", () => {
    const skippedAt = Date.parse("2026-11-27T06:00:00+08:00");
    let state = assignCurrent(startOpen(createState(), skippedAt).state, articleA, {
      via: "invite",
      now: skippedAt,
      enteredBody: true
    });
    state = recordSkip(state, skippedAt).state;
    const sameDay = Date.parse("2026-11-27T23:00:00+08:00");
    const nextDay = Date.parse("2026-11-28T09:00:00+08:00");
    const afterCooldown = Date.parse("2026-11-30T09:00:00+08:00");
    assert.equal(SKIP_COOLDOWN_DAYS, 3);
    assert.equal(excludedUrls(state, sameDay).includes(articleA.articleUrl), true);
    assert.equal(excludedUrls(state, nextDay).includes(articleA.articleUrl), true);
    assert.equal(dayKey(afterCooldown), "2026-11-30");
    assert.equal(calendarDayDiff("2026-11-27", "2026-11-30"), 3);
    assert.equal(excludedUrls(state, afterCooldown).includes(articleA.articleUrl), false);
  });

  test("crossing the closeout then inviting the next article is not recorded as a skip", () => {
    const now = Date.parse("2026-11-27T06:00:00+08:00");
    let state = assignCurrent(startOpen(createState(), now).state, articleA, {
      via: "invite",
      now,
      enteredBody: true
    });
    state = markCrossed(state, now);
    assert.equal(isUnfinished(state), false);
    assert.equal(state.current.crossedAt.length > 0, true);
    state = setPendingInvite(state, articleB);
    const accepted = acceptInvite(state, now);
    assert.equal(accepted.current.articleUrl, articleB.articleUrl);
    assert.equal(accepted.session.skipCount, 0);
    assert.equal((accepted.skipped || []).length, 0);
    assert.equal(isUnfinished(accepted), true);
  });

  test("closeout appears near the end only after some reading, and appearing is not crossing", () => {
    const longArticle = {
      hasReliableEnd: true,
      contentHeight: 4000,
      clientHeight: 800,
      scrollTop: 40,
      maxScrollDepth: 0.05,
      activeMs: 1000
    };
    assert.equal(shouldRevealCloseout(longArticle), false);
    assert.equal(shouldRevealCloseout({ ...longArticle, scrollTop: 200, maxScrollDepth: 0.25 }), false);
    const nearEnd = {
      hasReliableEnd: true,
      contentHeight: 4000,
      clientHeight: 800,
      scrollTop: 3050,
      maxScrollDepth: 0.9,
      activeMs: 20_000
    };
    assert.equal(shouldRevealCloseout(nearEnd), true);
    assert.equal(shouldCrossFromScroll({
      closeoutVisible: true,
      closeoutTop: 4000,
      closeoutHeight: 200,
      scrollTop: 3050,
      clientHeight: 800
    }), false);
    assert.equal(shouldCrossFromScroll({
      closeoutVisible: true,
      closeoutTop: 4000,
      closeoutHeight: 200,
      scrollTop: 3320,
      clientHeight: 800
    }), true);
    assert.equal(shouldCrossFromAction({ closeoutVisible: true, action: "advance" }), true);
    assert.equal(shouldCrossFromAction({ closeoutVisible: false, action: "advance" }), false);
  });

  test("unreliable ends still need engagement, then use a light closeout reveal", () => {
    assert.equal(hasReliableEnd({ paywalled: true }), false);
    assert.equal(hasReliableEnd({ infiniteOrUnknownEnd: true }), false);
    assert.equal(hasReliableEnd({ paywalled: false, infiniteOrUnknownEnd: false }), true);
    const paywall = {
      hasReliableEnd: false,
      contentHeight: 1200,
      clientHeight: 800,
      scrollTop: 10,
      maxScrollDepth: 0.05,
      activeMs: 500
    };
    assert.equal(shouldRevealCloseout(paywall), false);
    assert.equal(shouldRevealCloseout({
      ...paywall,
      scrollTop: 390,
      maxScrollDepth: 0.8,
      activeMs: 15_000
    }), true);
  });

  test("invite copy names the source, length, and a recent relation", () => {
    const reason = buildInviteReason({
      siteTitle: "The Atlantic",
      readingMinutes: 14,
      recentTitle: "A long essay about cities",
      sameSource: true
    });
    assert.match(reason, /The Atlantic/);
    assert.match(reason, /约 14 分钟/);
    assert.match(reason, /同一源/);
  });

  test("reading loop store round-trips unfinished state", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reading-loop-store-"));
    const store = new ReadingLoopStore(dir);
    const saved = assignCurrent(createState(), articleA, { via: "replace", enteredBody: true });
    await store.save(saved);
    const loaded = await store.load();
    assert.equal(loaded.current.articleUrl, articleA.articleUrl);
    assert.equal(isUnfinished(loaded), true);
  });

  test("reading loop service: resume, one replace, second skip ends, later open invites excluding skips", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reading-loop-service-"));
    const queue = [payloadFor(articleA), payloadFor(articleB), payloadFor(articleC)];
    const opened = [];
    const historyStore = {
      async unmarkOpened(url) {
        opened.push(`unmark:${url}`);
      }
    };
    const service = new ReadingLoopService({
      userDataPath: dir,
      historyStore,
      articlePrefetcher: {
        async consume({ excludeUrls = [] } = {}) {
          const next = queue.find((item) => !excludeUrls.includes(item.article.url));
          if (next) {
            queue.splice(queue.indexOf(next), 1);
            opened.push(`served:${next.article.url}`);
          }
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
      knowledgeDatabase: {
        getReadingPosition() {
          return { progressPercent: 37, anchor: { kind: "percentage", progressPercent: 37 } };
        },
        listShelf() {
          return [];
        }
      },
      logPath: path.join(dir, "loop.log")
    });

    const firstOpen = await service.open();
    assert.equal(firstOpen.mode, "invite");
    assert.equal(firstOpen.article.url, articleA.articleUrl);
    assert.match(firstOpen.inviteReason, /The Atlantic/);
    const accepted = await service.accept();
    assert.equal(accepted.mode, "reading");
    assert.equal(accepted.article.url, articleA.articleUrl);

    const closedAndReopened = await service.open();
    assert.equal(closedAndReopened.mode, "resume");
    assert.equal(closedAndReopened.article.url, articleA.articleUrl);
    assert.equal(closedAndReopened.resume.progressPercent, 37);

    const replaced = await service.skip();
    assert.equal(replaced.mode, "replace");
    assert.equal(replaced.article.url, articleB.articleUrl);
    assert.equal(opened.includes(`unmark:${articleA.articleUrl}`), true);

    const ended = await service.skip();
    assert.equal(ended.mode, "end");
    assert.equal(ended.loop.session.ended, true);

    const later = await service.open();
    assert.equal(later.mode, "invite");
    assert.equal(later.article.url, articleC.articleUrl);
    const excludeAfter = (await service.getState()).skipped.map((item) => item.articleUrl);
    assert.equal(excludeAfter.includes(articleA.articleUrl), true);
    assert.equal(excludeAfter.includes(articleB.articleUrl), true);
    assert.equal(excludeAfter.includes(articleC.articleUrl), false);
  });

  test("reading loop service: advancing on closeout invites the next article without counting a skip", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reading-loop-cross-"));
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
          return payloadFor((url === articleB.articleUrl ? articleB : articleA));
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
    assert.equal(afterCross.article.url, articleB.articleUrl);
    assert.equal(afterCross.loop.current.crossedAt.length > 0, true);
    assert.equal((afterCross.loop.skipped || []).length, 0);
    const reading = await service.accept();
    assert.equal(reading.article.url, articleB.articleUrl);
    assert.equal(isUnfinished(reading.loop), true);
  });
};
