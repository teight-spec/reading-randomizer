(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) root.ReadingLoopView = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const stateApi = (typeof require === "function" ? tryRequire() : null)
    || (typeof globalThis !== "undefined" ? globalThis.ReadingLoopState : null)
    || {};
  const {
    hasReliableEnd,
    shouldCrossFromAction,
    shouldCrossFromScroll,
    shouldRevealCloseout
  } = stateApi;

  const view = {
    options: null,
    closeoutRevealed: false,
    crossed: false,
    reliableEnd: true,
    bound: false,
    dwellStartedAt: 0,
    dwellTimer: null
  };

  function tryRequire() {
    try {
      return require("../main/services/readingLoopState");
    } catch {
      return null;
    }
  }

  function configure(options) {
    view.options = options || {};
    view.elements = options.elements || {};
    bind();
  }

  function bind() {
    if (view.bound) return;
    view.bound = true;
    const scrollElement = view.elements.scrollElement;
    scrollElement?.addEventListener("scroll", () => evaluateCloseout(), { passive: true });
    view.elements.inviteAccept?.addEventListener("click", () => {
      view.options.onAcceptInvite?.();
    });
    view.elements.closeoutNext?.addEventListener("click", () => {
      maybeCross("advance");
    });
    view.elements.bookmarkOpen?.addEventListener("click", () => {
      const bookmark = view.activeBookmark;
      if (bookmark && view.elements.article) {
        globalThis.ReadingMarks?.scrollToMark?.(
          view.elements.article,
          view.elements.scrollElement,
          bookmark
        );
      }
      view.options.onResolveBookmark?.({ action: "view" });
    });
    bindBookmarkSwipe();
  }

  function resetArticle({ paywalled = false, infiniteOrUnknownEnd = false } = {}) {
    view.closeoutRevealed = false;
    view.crossed = false;
    view.reliableEnd = hasReliableEnd
      ? hasReliableEnd({ paywalled, infiniteOrUnknownEnd })
      : !paywalled && !infiniteOrUnknownEnd;
    view.dwellStartedAt = Date.now();
    hideCloseout();
    hideInvite();
    hideBookmark();
    hideSessionEnd();
    clearTimeout(view.dwellTimer);
    view.dwellTimer = setTimeout(() => evaluateCloseout(), 8_200);
    evaluateCloseout();
  }

  function setReliableEnd(flags) {
    view.reliableEnd = hasReliableEnd
      ? hasReliableEnd(flags)
      : !flags.paywalled && !flags.infiniteOrUnknownEnd;
    evaluateCloseout();
  }

  function showInvite({ title, reason, kind } = {}) {
    hideSessionEnd();
    hideCloseout();
    hideBookmark();
    const invite = view.elements.invite;
    if (!invite) return;
    if (view.elements.inviteTitle) view.elements.inviteTitle.textContent = title || "下一篇";
    if (view.elements.inviteReason) view.elements.inviteReason.textContent = reason || "";
    if (view.elements.inviteKicker) {
      view.elements.inviteKicker.textContent = kind === "nextAfterCross" ? "读完了，下一篇" : "为什么是这篇";
    }
    invite.classList.remove("hidden");
    view.elements.article?.classList.add("hidden");
    view.elements.controls?.classList.add("hidden");
    setNextActionsVisible(false);
  }

  function hideInvite() {
    view.elements.invite?.classList.add("hidden");
    view.elements.article?.classList.remove("hidden");
    view.elements.controls?.classList.remove("hidden");
    setNextActionsVisible(true);
  }

  function showSessionEnd() {
    hideInvite();
    hideCloseout();
    hideBookmark();
    view.elements.sessionEnd?.classList.remove("hidden");
    view.elements.article?.classList.add("hidden");
    view.elements.controls?.classList.add("hidden");
    setNextActionsVisible(false);
  }

  function hideSessionEnd() {
    view.elements.sessionEnd?.classList.add("hidden");
  }

  function hideAllOverlays() {
    hideInvite();
    hideSessionEnd();
    hideCloseout();
    hideBookmark();
    view.elements.article?.classList.remove("hidden");
    view.elements.controls?.classList.remove("hidden");
    setNextActionsVisible(true);
  }

  function showBookmark(bookmark) {
    hideInvite();
    hideSessionEnd();
    hideCloseout();
    view.activeBookmark = bookmark || null;
    const card = view.elements.bookmark;
    if (!card || !bookmark) return;
    if (view.elements.bookmarkQuote) view.elements.bookmarkQuote.textContent = bookmark.quote || "";
    if (view.elements.bookmarkNote) {
      const note = String(bookmark.note || "").trim();
      view.elements.bookmarkNote.textContent = note;
      view.elements.bookmarkNote.classList.toggle("hidden", !note);
    }
    card.classList.remove("hidden");
    view.elements.article?.classList.remove("hidden");
    view.elements.controls?.classList.add("hidden");
    setNextActionsVisible(false);
  }

  function hideBookmark() {
    view.elements.bookmark?.classList.add("hidden");
    view.activeBookmark = null;
  }

  function bindBookmarkSwipe() {
    const card = view.elements.bookmark;
    if (!card || card.dataset.swipeBound) return;
    card.dataset.swipeBound = "1";
    let startX = 0;
    let startY = 0;
    let dragging = false;
    card.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button")) return;
      dragging = true;
      startX = event.clientX;
      startY = event.clientY;
    });
    card.addEventListener("pointerup", (event) => {
      if (!dragging) return;
      dragging = false;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (Math.abs(dx) >= 80 || dy <= -80) {
        view.options.onResolveBookmark?.({ action: "dismiss" });
      }
    });
    card.addEventListener("pointerleave", () => {
      dragging = false;
    });
  }

  function setSkipLabel(canSkip) {
    const button = view.elements.nextButton;
    if (!button) return;
    button.textContent = canSkip ? "换一篇" : "下一篇";
    button.hidden = !canSkip;
    if (view.elements.saveAndNextButton) view.elements.saveAndNextButton.hidden = !canSkip;
  }

  function setNextActionsVisible(visible) {
    const actions = view.elements.nextActions;
    if (actions) actions.classList.toggle("hidden", !visible);
  }

  function hideCloseout() {
    const closeout = view.elements.closeout;
    if (!closeout) return;
    closeout.classList.add("hidden");
    closeout.setAttribute("aria-hidden", "true");
    view.closeoutRevealed = false;
  }

  function revealCloseout() {
    const closeout = view.elements.closeout;
    if (!closeout || view.crossed) return;
    closeout.classList.remove("hidden");
    closeout.setAttribute("aria-hidden", "false");
    view.closeoutRevealed = true;
    view.options.onCloseoutRevealed?.();
  }

  function evaluateCloseout() {
    if (view.crossed) return;
    const scrollElement = view.elements.scrollElement;
    const closeout = view.elements.closeout;
    if (!scrollElement || !closeout) return;
    const inviteOpen = view.elements.invite && !view.elements.invite.classList.contains("hidden");
    const ended = view.elements.sessionEnd && !view.elements.sessionEnd.classList.contains("hidden");
    if (inviteOpen || ended) return;

    const metrics = {
      hasReliableEnd: view.reliableEnd,
      contentHeight: closeoutHeightExcluded(scrollElement, closeout),
      clientHeight: scrollElement.clientHeight,
      scrollTop: scrollElement.scrollTop,
      maxScrollDepth: currentDepth(scrollElement),
      activeMs: Date.now() - (view.dwellStartedAt || Date.now())
    };
    const reveal = shouldRevealCloseout
      ? shouldRevealCloseout(metrics)
      : fallbackReveal(metrics);
    if (reveal) revealCloseout();
    if (view.closeoutRevealed) maybeCross("scroll");
  }

  function closeoutHeightExcluded(scrollElement, closeout) {
    if (closeout.classList.contains("hidden")) return scrollElement.scrollHeight;
    return Math.max(0, scrollElement.scrollHeight - closeout.getBoundingClientRect().height);
  }

  function currentDepth(scrollElement) {
    const height = Math.max(scrollElement.scrollHeight, 1);
    return Math.max(0, Math.min(1, (scrollElement.scrollTop + scrollElement.clientHeight) / height));
  }

  function maybeCross(via) {
    if (view.crossed || !view.closeoutRevealed) return false;
    const scrollElement = view.elements.scrollElement;
    const closeout = view.elements.closeout;
    let shouldCross = false;
    if (via === "advance") {
      shouldCross = shouldCrossFromAction
        ? shouldCrossFromAction({ closeoutVisible: true, action: "advance" })
        : true;
    } else if (scrollElement && closeout) {
      const top = closeout.offsetTop;
      const payload = {
        closeoutVisible: true,
        closeoutTop: top,
        closeoutHeight: closeout.getBoundingClientRect().height,
        scrollTop: scrollElement.scrollTop,
        clientHeight: scrollElement.clientHeight
      };
      shouldCross = shouldCrossFromScroll ? shouldCrossFromScroll(payload) : fallbackCross(payload);
    }
    if (!shouldCross) return false;
    view.crossed = true;
    view.options.onCross?.({ via });
    return true;
  }

  function fallbackReveal(metrics) {
    const maxScroll = Math.max(0, metrics.contentHeight - metrics.clientHeight);
    if (metrics.scrollTop < 80 && metrics.maxScrollDepth < 0.2 && !(maxScroll <= 0 && metrics.activeMs >= 8000)) {
      return false;
    }
    if (maxScroll <= 0) return true;
    const remaining = maxScroll - metrics.scrollTop;
    return metrics.hasReliableEnd ? remaining / maxScroll <= 0.12 || remaining <= 220 : remaining <= 24;
  }

  function fallbackCross(payload) {
    return payload.scrollTop + payload.clientHeight >= payload.closeoutTop + Math.min(payload.closeoutHeight * 0.45, 72);
  }

  function markAlreadyCrossed() {
    view.crossed = true;
    hideCloseout();
  }

  return {
    configure,
    evaluateCloseout,
    hideAllOverlays,
    hideBookmark,
    hideInvite,
    hideSessionEnd,
    markAlreadyCrossed,
    resetArticle,
    setReliableEnd,
    setSkipLabel,
    showBookmark,
    showInvite,
    showSessionEnd
  };
});
