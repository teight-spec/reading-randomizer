(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.NextReadingSession = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const MESSAGES = {
    no_sources: "还没有阅读来源，请添加网站或导入书签。",
    unavailable: "暂时抽不到可阅读的文章，请稍后再试。",
    extract_failed: "找到了候选文章，但无法提取正文。可以重试，或打开原文。",
    timeout: "文章加载超时，请稍后再试。"
  };

  function createSession() {
    let generation = 0;
    return {
      begin() {
        generation += 1;
        return generation;
      },
      isCurrent(id) {
        return id === generation;
      },
      current() {
        return generation;
      }
    };
  }

  function isReadablePickup(result) {
    return Boolean(result?.article?.url && result?.site && result?.readerArticle);
  }

  function hasConfiguredSources(result) {
    if (Array.isArray(result?.sites) && result.sites.length > 0) return true;
    if (result?.site) return true;
    return false;
  }

  function textFrom(result, error) {
    return `${result?.readerError || ""} ${error?.message || error || ""}`.toLowerCase();
  }

  function firstExtractFailure(result) {
    if (result?.article?.url && !result?.readerArticle) {
      return result.article;
    }
    const skipped = Array.isArray(result?.skippedSites) ? result.skippedSites : [];
    return skipped.find((item) => item && (item.articleUrl || item.url)) || null;
  }

  function classifyNextReadingOutcome({ result = null, error = null } = {}) {
    const text = textFrom(result, error);
    if (error) {
      if (text.includes("timeout")) {
        return { kind: "timeout", message: MESSAGES.timeout, article: null, site: null, readerArticle: null, originalUrl: null };
      }
      return {
        kind: "unavailable",
        message: error.message || MESSAGES.unavailable,
        article: null,
        site: null,
        readerArticle: null,
        originalUrl: null
      };
    }

    if (text.includes("no reading sources") || (!hasConfiguredSources(result) && !result?.article && !firstExtractFailure(result))) {
      return { kind: "no_sources", message: MESSAGES.no_sources, article: null, site: null, readerArticle: null, originalUrl: null };
    }

    if (isReadablePickup(result)) {
      return {
        kind: "ready",
        message: null,
        article: result.article,
        site: result.site,
        readerArticle: result.readerArticle,
        originalUrl: null
      };
    }

    const failed = firstExtractFailure(result);
    if (failed) {
      const url = failed.url || failed.articleUrl || null;
      return {
        kind: "extract_failed",
        message: MESSAGES.extract_failed,
        article: result?.article || failed,
        site: result?.site || null,
        readerArticle: null,
        originalUrl: url
      };
    }

    if (text.includes("timeout")) {
      return { kind: "timeout", message: MESSAGES.timeout, article: null, site: null, readerArticle: null, originalUrl: null };
    }

    return {
      kind: "unavailable",
      message: MESSAGES.unavailable,
      article: null,
      site: null,
      readerArticle: null,
      originalUrl: null
    };
  }

  function decideNextReadingView(outcome, { hasCurrentArticle } = {}) {
    if (outcome.kind === "ready") {
      return {
        applyLoopResult: false,
        replaceCurrent: true,
        keepCurrent: false,
        showImportGuide: false,
        showSessionEnd: false,
        notice: null,
        nextReading: {
          site: outcome.site,
          article: outcome.article,
          readerArticle: outcome.readerArticle
        }
      };
    }
    return {
      applyLoopResult: false,
      replaceCurrent: false,
      keepCurrent: Boolean(hasCurrentArticle),
      showImportGuide: outcome.kind === "no_sources" && !hasCurrentArticle,
      showSessionEnd: false,
      notice: {
        kind: outcome.kind,
        message: outcome.message,
        canRetry: outcome.kind !== "no_sources",
        openOriginalUrl: outcome.kind === "extract_failed" ? outcome.originalUrl : null
      },
      nextReading: null
    };
  }

  function decideLoopPickupView(result, { hasCurrentArticle = false, action = "next" } = {}) {
    const mode = result?.mode;

    if (mode === "invite" || mode === "resume" || mode === "reading" || mode === "bookmark" || mode === "replace") {
      if (mode === "replace" && !isReadablePickup(result) && hasCurrentArticle) {
        return decideNextReadingView(classifyNextReadingOutcome({ result }), { hasCurrentArticle: true });
      }
      return { applyLoopResult: true, replaceCurrent: true, keepCurrent: false, showImportGuide: false, showSessionEnd: false, notice: null, nextReading: null };
    }

    if (mode === "end") {
      return { applyLoopResult: true, replaceCurrent: false, keepCurrent: false, showImportGuide: false, showSessionEnd: true, notice: null, nextReading: null };
    }

    if (mode === "noop") {
      return {
        applyLoopResult: false,
        replaceCurrent: false,
        keepCurrent: Boolean(hasCurrentArticle),
        showImportGuide: false,
        showSessionEnd: false,
        notice: hasCurrentArticle ? { kind: "unavailable", message: MESSAGES.unavailable, canRetry: true, openOriginalUrl: null } : null,
        nextReading: null
      };
    }

    const outcome = classifyNextReadingOutcome({ result });
    const view = decideNextReadingView(outcome, { hasCurrentArticle });

    if (mode === "skipFailed" || action === "skip") {
      view.keepCurrent = Boolean(hasCurrentArticle);
      view.replaceCurrent = false;
      view.showImportGuide = false;
      if (hasCurrentArticle && !view.notice) {
        view.notice = {
          kind: outcome.kind || "unavailable",
          message: outcome.message || MESSAGES.unavailable,
          canRetry: true,
          openOriginalUrl: outcome.originalUrl || null
        };
      }
    }

    if (mode === "emptyAfterCross") {
      view.showImportGuide = false;
    }

    return view;
  }

  function settleRequest(session, generation, payload, current) {
    if (!session.isCurrent(generation)) {
      return { accepted: false, stale: true, outcome: null, view: null };
    }
    const result = payload?.result;
    if (result?.mode) {
      const view = decideLoopPickupView(result, {
        hasCurrentArticle: Boolean(current?.article),
        action: payload?.action || "next"
      });
      return { accepted: true, stale: false, outcome: classifyNextReadingOutcome(payload), view };
    }
    const outcome = classifyNextReadingOutcome(payload);
    const view = decideNextReadingView(outcome, {
      hasCurrentArticle: Boolean(current?.article)
    });
    return { accepted: true, stale: false, outcome, view };
  }

  return {
    createSession,
    isReadablePickup,
    classifyNextReadingOutcome,
    decideNextReadingView,
    decideLoopPickupView,
    settleRequest,
    MESSAGES
  };
});
