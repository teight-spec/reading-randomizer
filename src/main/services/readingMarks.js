(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) root.ReadingMarks = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const MAX_QUOTE = 280;
  const MAX_NOTE = 120;
  const MAX_MARKS_PER_ARTICLE = 50;
  const OCCASIONAL_THRESHOLD = 1 / 3;

  function normalizeQuote(text) {
    return String(text || "").replace(/\s+/g, " ").trim().slice(0, MAX_QUOTE);
  }

  function normalizeNote(text) {
    const note = String(text || "").replace(/\s+/g, " ").trim().slice(0, MAX_NOTE);
    return note || null;
  }

  function createMark(input = {}, now = Date.now()) {
    const quote = normalizeQuote(input.quote || input.text);
    if (!quote) return null;
    return {
      id: String(input.id || `mark-${now}-${Math.random().toString(36).slice(2, 8)}`),
      quote,
      note: normalizeNote(input.note),
      paragraphIndex: Number.isInteger(input.paragraphIndex) ? input.paragraphIndex : null,
      charOffset: Number.isInteger(input.charOffset) ? input.charOffset : null,
      createdAt: input.createdAt || new Date(now).toISOString()
    };
  }

  function marksFor(state, articleUrl) {
    if (!articleUrl) return [];
    const bucket = state?.marksByUrl && state.marksByUrl[articleUrl];
    return Array.isArray(bucket) ? bucket : [];
  }

  function addMarkToState(state, articleUrl, input, now = Date.now()) {
    const mark = createMark(input, now);
    const next = structuredClone(state && typeof state === "object" ? state : { marksByUrl: {} });
    next.marksByUrl = next.marksByUrl && typeof next.marksByUrl === "object" ? next.marksByUrl : {};
    if (!mark || !articleUrl) return { state: next, mark: null };
    const list = [...(next.marksByUrl[articleUrl] || [])];
    const existing = list.findIndex((item) => item.quote === mark.quote);
    if (existing >= 0) {
      const merged = {
        ...list[existing],
        note: mark.note || list[existing].note,
        paragraphIndex: mark.paragraphIndex ?? list[existing].paragraphIndex,
        charOffset: mark.charOffset ?? list[existing].charOffset
      };
      list[existing] = merged;
      next.marksByUrl[articleUrl] = list;
      return { state: next, mark: merged };
    }
    list.push(mark);
    next.marksByUrl[articleUrl] = list.slice(-MAX_MARKS_PER_ARTICLE);
    return { state: next, mark };
  }

  function occasionalScore(articleUrl) {
    const text = `bookmark:${String(articleUrl || "")}`;
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) / 4294967295;
  }

  function shouldOfferBookmark({
    isResume = false,
    hasCrossed = false,
    alreadyResolved = false,
    marks = [],
    articleUrl = ""
  } = {}) {
    if (isResume || !hasCrossed || alreadyResolved) return false;
    const usable = (marks || []).filter((item) => normalizeQuote(item.quote));
    if (!usable.length) return false;
    if (usable.some((item) => normalizeNote(item.note))) return true;
    return occasionalScore(articleUrl) < OCCASIONAL_THRESHOLD;
  }

  function pickBookmarkMark(marks = []) {
    const usable = marks.filter((item) => normalizeQuote(item.quote));
    const withNote = usable.filter((item) => normalizeNote(item.note));
    const pool = withNote.length ? withNote : usable;
    return pool[pool.length - 1] || null;
  }

  function setPendingBookmark(state, mark, articleUrl) {
    const next = structuredClone(state && typeof state === "object" ? state : {});
    if (!mark) {
      next.pendingBookmark = null;
      return next;
    }
    next.pendingBookmark = {
      ...createMark(mark),
      articleUrl: articleUrl || mark.articleUrl || state?.current?.articleUrl || ""
    };
    return next;
  }

  function resolvePendingBookmark(state) {
    const next = structuredClone(state && typeof state === "object" ? state : {});
    next.pendingBookmark = null;
    next.bookmarkResolvedAt = new Date().toISOString();
    return next;
  }

  function hasPendingBookmark(state) {
    return Boolean(state?.pendingBookmark?.quote);
  }

  function bookmarkBlocksInvite(bookmarkVisible, inviteVisible) {
    return Boolean(bookmarkVisible && inviteVisible);
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function escapeAttr(value) {
    return String(value || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  function applyMarksToHtml(html, marks) {
    let result = String(html || "");
    for (const mark of marks || []) {
      const quote = normalizeQuote(mark.quote);
      if (!quote || result.includes(`data-mark-id="${escapeAttr(mark.id)}"`)) continue;
      const at = result.indexOf(quote);
      if (at < 0) continue;
      const wrapped = `<mark class="reading-inline-mark" data-mark-id="${escapeAttr(mark.id)}">${quote}</mark>`;
      result = `${result.slice(0, at)}${wrapped}${result.slice(at + quote.length)}`;
    }
    return result;
  }

  function paintMarks(articleElement, marks) {
    if (!articleElement || !Array.isArray(marks) || !marks.length) return 0;
    let painted = 0;
    for (const mark of marks) {
      const quote = normalizeQuote(mark.quote);
      if (!quote) continue;
      if (articleElement.querySelector(`mark[data-mark-id="${cssEscape(mark.id)}"]`)) {
        painted += 1;
        continue;
      }
      const scope = scopeForMark(articleElement, mark) || articleElement;
      if (wrapFirstTextOccurrence(scope, quote, mark.id)) painted += 1;
    }
    return painted;
  }

  function cssEscape(value) {
    if (globalThis.CSS?.escape) return globalThis.CSS.escape(String(value || ""));
    return String(value || "").replace(/"/g, "\\\"");
  }

  function scopeForMark(articleElement, mark) {
    if (!Number.isInteger(mark.paragraphIndex)) return null;
    const paragraphs = articleElement.querySelectorAll("p");
    return paragraphs[mark.paragraphIndex] || null;
  }

  function wrapFirstTextOccurrence(root, quote, markId) {
    const document = root.ownerDocument;
    if (!document) return false;
    const walker = document.createTreeWalker(root, document.defaultView.NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const text = node.nodeValue || "";
      const at = text.indexOf(quote);
      if (at >= 0) {
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + quote.length);
        const mark = document.createElement("mark");
        mark.className = "reading-inline-mark";
        mark.dataset.markId = markId;
        range.surroundContents(mark);
        return true;
      }
      node = walker.nextNode();
    }
    return false;
  }

  function scrollToMark(articleElement, scrollElement, mark) {
    if (!articleElement || !mark) return false;
    const node = articleElement.querySelector(`mark[data-mark-id="${cssEscape(mark.id)}"]`);
    if (!node) return false;
    const scroller = scrollElement || articleElement;
    const top = node.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 48;
    scroller.scrollTop = Math.max(0, top);
    node.classList.add("is-focused");
    return true;
  }

  return {
    OCCASIONAL_THRESHOLD,
    addMarkToState,
    applyMarksToHtml,
    bookmarkBlocksInvite,
    createMark,
    hasPendingBookmark,
    marksFor,
    normalizeNote,
    normalizeQuote,
    occasionalScore,
    paintMarks,
    pickBookmarkMark,
    resolvePendingBookmark,
    scrollToMark,
    setPendingBookmark,
    shouldOfferBookmark
  };
});
