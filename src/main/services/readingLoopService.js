const fs = require("node:fs/promises");
const path = require("node:path");
const { ReadingLoopStore } = require("./readingLoopStore");
const {
  acceptInvite,
  assignCurrent,
  buildInviteReason,
  estimateReadingMinutes,
  excludedUrls,
  isUnfinished,
  markCrossed,
  recordSkip,
  setPendingInvite,
  startOpen
} = require("./readingLoopState");
const {
  addMarkToState,
  hasPendingBookmark,
  marksFor,
  pickBookmarkMark,
  resolvePendingBookmark,
  setPendingBookmark,
  shouldOfferBookmark
} = require("./readingMarks");

class ReadingLoopService {
  constructor({
    userDataPath,
    articlePrefetcher,
    articleCache,
    historyStore,
    knowledgeDatabase,
    extractReaderArticle,
    logPath
  }) {
    this.store = new ReadingLoopStore(userDataPath);
    this.articlePrefetcher = articlePrefetcher;
    this.articleCache = articleCache;
    this.historyStore = historyStore;
    this.knowledgeDatabase = knowledgeDatabase;
    this.extractReaderArticle = extractReaderArticle;
    this.logPath = logPath || process.env.SUIYUE_LOOP_LOG_FILE || "/tmp/rr-pr1-isolated-loop.log";
  }

  async getState() {
    return this.store.load();
  }

  async open() {
    const opened = startOpen(await this.store.load(), Date.now());
    let state = opened.state;

    if (opened.decision === "resume") {
      await this.store.save(state);
      const payload = await this.loadArticle(state.current.articleUrl, { resume: true });
      await this.log("open_resume", {
        articleUrl: state.current.articleUrl,
        openId: state.session?.openId
      });
      return this.wrap("resume", payload, state);
    }

    if (opened.decision === "pendingBookmark") {
      await this.store.save(state);
      const url = state.pendingBookmark.articleUrl || state.current?.articleUrl;
      const payload = await this.loadArticle(url, { resume: true });
      await this.log("open_bookmark", { articleUrl: url });
      return this.wrap("bookmark", payload, state, { bookmark: state.pendingBookmark });
    }

    if (opened.decision === "pendingInvite") {
      await this.store.save(state);
      const payload = await this.loadArticle(state.pendingInvite.articleUrl, { resume: false });
      const inviteReason = state.pendingInvite.inviteReason || this.reasonFor(payload);
      await this.log("open_pending_invite", {
        articleUrl: state.pendingInvite.articleUrl,
        openId: state.session?.openId
      });
      return this.wrap("invite", payload, state, { inviteKind: "nextAfterCross", inviteReason });
    }

    await this.maybeAdoptLegacySeat(state);
    state = await this.store.load();
    if (isUnfinished(state)) {
      const payload = await this.loadArticle(state.current.articleUrl, { resume: true });
      await this.log("open_resume_legacy", {
        articleUrl: state.current.articleUrl,
        openId: state.session?.openId
      });
      return this.wrap("resume", payload, state);
    }

    return this.pickAndInvite(state, { inviteKind: "opening" });
  }

  async skip() {
    const current = await this.store.load();
    const preview = recordSkip(current, Date.now());
    if (preview.decision === "noop") {
      await this.log("skip_noop", { ended: Boolean(current.session?.ended) });
      return { mode: current.session?.ended ? "end" : "noop", loop: current };
    }

    if (preview.decision === "end") {
      if (preview.skippedUrl) {
        await this.historyStore?.unmarkOpened?.(preview.skippedUrl);
      }
      await this.store.save(preview.state);
      await this.log("skip", {
        skippedUrl: preview.skippedUrl,
        decision: preview.decision,
        skipCount: preview.state.session?.skipCount
      });
      return { mode: "end", loop: preview.state };
    }

    const exclude = excludedUrls(current, Date.now());
    if (current.current?.articleUrl) exclude.push(current.current.articleUrl);
    const picked = await this.pickNext(exclude);
    if (!isReadablePickup(picked)) {
      await this.log("skip_replace_failed", {
        skippedUrl: current.current?.articleUrl,
        readerError: picked?.readerError || null
      });
      return this.wrap("skipFailed", picked, current, { keptCurrent: true });
    }

    if (preview.skippedUrl) {
      await this.historyStore?.unmarkOpened?.(preview.skippedUrl);
    }
    const assigned = assignCurrent(preview.state, this.metaFromPayload(picked), {
      via: "replace",
      enteredBody: true
    });
    await this.store.save(assigned);
    await this.log("skip_replace", { articleUrl: picked.article.url });
    return this.wrap("replace", picked, assigned);
  }

  async cross() {
    const current = await this.store.load();
    if (!isUnfinished(current)) {
      if (current.pendingInvite?.articleUrl) {
        const payload = await this.loadArticle(current.pendingInvite.articleUrl, { resume: false });
        const inviteReason = current.pendingInvite.inviteReason || this.reasonFor(payload);
        return this.wrap("invite", payload, current, { inviteKind: "nextAfterCross", inviteReason });
      }
      await this.log("cross_noop", {});
      return { mode: "noop", loop: current };
    }

    const crossed = markCrossed(current, Date.now());
    await this.store.save(crossed);
    await this.log("cross", { articleUrl: crossed.current?.articleUrl });
    const invited = await this.pickAndInvite(crossed, { inviteKind: "nextAfterCross", excludeCurrent: true });
    const articleUrl = crossed.current?.articleUrl;
    const marks = marksFor(invited.loop || crossed, articleUrl);
    if (!shouldOfferBookmark({
      isResume: false,
      hasCrossed: true,
      alreadyResolved: hasPendingBookmark(crossed) && false,
      marks,
      articleUrl
    })) {
      return invited;
    }
    const withBookmark = setPendingBookmark(invited.loop, pickBookmarkMark(marks), articleUrl);
    await this.store.save(withBookmark);
    await this.log("cross_bookmark", { hasNote: Boolean(withBookmark.pendingBookmark?.note) });
    return this.wrap("bookmark", {}, withBookmark, { bookmark: withBookmark.pendingBookmark });
  }

  async saveMark(payload = {}) {
    const current = await this.store.load();
    const articleUrl = payload.articleUrl || current.current?.articleUrl;
    const result = addMarkToState(current, articleUrl, payload, Date.now());
    await this.store.save(result.state);
    await this.log("save_mark", { articleUrl, hasNote: Boolean(result.mark?.note) });
    return {
      mark: result.mark,
      marks: marksFor(result.state, articleUrl),
      loop: result.state
    };
  }

  async resolveBookmark(payload = {}) {
    const next = resolvePendingBookmark(await this.store.load());
    await this.store.save(next);
    await this.log("bookmark_resolved", { action: payload.action || "dismiss" });
    if (next.pendingInvite?.articleUrl) {
      const article = await this.loadArticle(next.pendingInvite.articleUrl, { resume: false });
      const inviteReason = next.pendingInvite.inviteReason || this.reasonFor(article);
      return this.wrap("invite", article, next, { inviteKind: "nextAfterCross", inviteReason });
    }
    return { mode: "emptyAfterCross", loop: next };
  }

  async accept() {
    const accepted = acceptInvite(await this.store.load(), Date.now());
    await this.store.save(accepted);
    const url = accepted.current?.articleUrl;
    const payload = url ? await this.loadArticle(url, { resume: accepted.current?.via === "resume" }) : {
      site: null,
      article: null,
      readerArticle: null
    };
    await this.log("accept_invite", { articleUrl: url, via: accepted.current?.via });
    return this.wrap("reading", payload, accepted);
  }

  async maybeAdoptLegacySeat(state) {
    if (isUnfinished(state) || state.pendingInvite?.articleUrl) return state;
    const seat = this.knowledgeDatabase?.getLatestReadingSeat?.();
    if (!seat?.articleUrl || seat.completedAt) return state;
    const adopted = assignCurrent(state, {
      articleUrl: seat.articleUrl,
      articleTitle: seat.articleTitle,
      siteId: seat.siteId,
      siteTitle: seat.siteTitle,
      siteDomain: seat.siteDomain
    }, { via: "resume", enteredBody: true });
    await this.store.save(adopted);
    await this.log("adopt_legacy_seat", { articleUrl: seat.articleUrl });
    return adopted;
  }

  async pickAndInvite(state, { inviteKind, excludeCurrent = false } = {}) {
    const exclude = excludedUrls(state, Date.now());
    if (excludeCurrent && state.current?.articleUrl) exclude.push(state.current.articleUrl);
    const picked = await this.pickNext(exclude);
    if (!picked.article) {
      await this.store.save(state);
      await this.log("invite_empty", { inviteKind });
      return this.wrap(inviteKind === "nextAfterCross" ? "emptyAfterCross" : "empty", picked, state);
    }
    const inviteReason = this.reasonFor(picked);
    const meta = { ...this.metaFromPayload(picked), inviteReason };
    let nextState;
    if (inviteKind === "nextAfterCross") {
      nextState = setPendingInvite(state, meta);
    } else {
      nextState = assignCurrent(state, meta, { via: "invite", enteredBody: false });
    }
    await this.store.save(nextState);
    await this.log("invite", { inviteKind, articleUrl: picked.article.url });
    return this.wrap("invite", picked, nextState, { inviteKind, inviteReason });
  }

  async pickNext(exclude) {
    if (!this.articlePrefetcher?.consume) {
      return {
        site: null,
        article: null,
        readerArticle: null,
        readerError: "Article picker is not ready",
        skippedSites: []
      };
    }
    return this.articlePrefetcher.consume({ excludeUrls: exclude });
  }

  async loadArticle(articleUrl, { resume = false } = {}) {
    const cached = await this.articleCache?.getArticle?.(articleUrl);
    const position = this.knowledgeDatabase?.getReadingPosition?.(articleUrl) || null;
    let readerArticle = cached?.readerArticle || null;
    let readerError = null;
    if (!readerArticle && this.extractReaderArticle) {
      try {
        readerArticle = await this.extractReaderArticle(articleUrl);
      } catch (error) {
        readerError = error.message;
      }
    }
    const site = cached?.site || {
      id: position?.siteId || "",
      title: position?.siteTitle || position?.siteDomain || "已保存的文章",
      domain: position?.siteDomain || "",
      url: articleUrl
    };
    const article = {
      ...(cached?.article || {}),
      title: readerArticle?.title || position?.articleTitle || cached?.article?.title || articleUrl,
      url: articleUrl,
      source: cached?.article?.source || "saved"
    };
    return {
      site,
      article,
      readerArticle,
      readerError,
      resume: resume ? position : null,
      unavailable: !readerArticle
    };
  }

  metaFromPayload(payload) {
    return {
      articleUrl: payload.article?.url || "",
      articleTitle: payload.readerArticle?.title || payload.article?.title || "",
      siteId: payload.site?.id || "",
      siteTitle: payload.site?.title || "",
      siteDomain: payload.site?.domain || "",
      source: payload.article?.source || ""
    };
  }

  reasonFor(payload) {
    const recent = this.recentShelfArticle();
    return buildInviteReason({
      siteTitle: payload.site?.title,
      siteDomain: payload.site?.domain,
      readingMinutes: estimateReadingMinutes(payload.readerArticle?.textContent || ""),
      recentTitle: recent?.articleTitle || "",
      sameSource: Boolean(
        recent &&
        payload.site &&
        (recent.siteId && recent.siteId === payload.site.id ||
          recent.siteDomain && recent.siteDomain === payload.site.domain)
      )
    });
  }

  recentShelfArticle() {
    const recent = this.knowledgeDatabase?.listShelf?.("recent", 5) || [];
    return recent[0] || null;
  }

  wrap(mode, payload, loop, extras = {}) {
    return {
      mode,
      site: payload?.site || null,
      article: payload?.article || null,
      readerArticle: payload?.readerArticle || null,
      readerError: payload?.readerError || null,
      resume: payload?.resume || null,
      skippedSites: payload?.skippedSites || [],
      unavailable: payload?.unavailable || false,
      marks: marksFor(loop, payload?.article?.url || loop?.current?.articleUrl || extras.bookmark?.articleUrl),
      loop,
      ...extras
    };
  }

  async log(event, payload = {}) {
    const line = `${new Date().toISOString()} ${event} ${JSON.stringify(redactLogPayload(payload))}\n`;
    try {
      await fs.appendFile(this.logPath, line, "utf8");
    } catch {
      // Logging must never break the reading loop.
    }
    return line;
  }
}


function isReadablePickup(picked) {
  return Boolean(picked?.article?.url && picked?.site && picked?.readerArticle);
}

function redactUrl(value) {

  try {
    const url = new URL(String(value || ""));
    return `${url.protocol}//${url.host}/…`;
  } catch {
    return "(url)";
  }
}

function redactLogPayload(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const next = { ...payload };
  for (const key of Object.keys(next)) {
    if (/url/i.test(key) && typeof next[key] === "string") next[key] = redactUrl(next[key]);
  }
  return next;
}

function defaultLogPath() {

  return process.env.SUIYUE_LOOP_LOG_FILE || "/tmp/rr-pr1-isolated-loop.log";
}

module.exports = {
  ReadingLoopService,
  defaultLogPath,
  loopLogPath: path
};
