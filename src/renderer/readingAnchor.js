(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) root.ReadingAnchor = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function isResumePromptRange(percent) {
    const value = Number(percent);
    return Number.isFinite(value) && value >= 5 && value <= 90;
  }

  function progressPercentFromScroll({ scrollTop = 0, scrollHeight = 0, clientHeight = 0 } = {}) {
    const maxScroll = Math.max(0, Number(scrollHeight) - Number(clientHeight));
    if (maxScroll <= 0) return 0;
    const ratio = Math.max(0, Math.min(1, Number(scrollTop) / maxScroll));
    return Math.round(ratio * 100);
  }

  function captureAnchor(layout = {}) {
    const paragraphs = Array.isArray(layout.paragraphs) ? layout.paragraphs : [];
    const scrollTop = Number(layout.scrollTop) || 0;
    const progressPercent = progressPercentFromScroll(layout);
    const percentage = {
      kind: "percentage",
      progressPercent
    };
    const visible = paragraphs.find((paragraph) => {
      const top = Number(paragraph?.top);
      const height = Number(paragraph?.height);
      return Number.isFinite(top) && Number.isFinite(height) && height > 0 && top + height > scrollTop + 1;
    });
    if (!visible || !Number(visible.textLength)) return percentage;
    const index = paragraphs.indexOf(visible);
    const offsetRatio = Math.max(0, Math.min(1, (scrollTop - Number(visible.top)) / Number(visible.height)));
    return {
      kind: "paragraph",
      paragraphIndex: index,
      charOffset: Math.round(offsetRatio * Number(visible.textLength)),
      paragraphCount: paragraphs.length,
      progressPercent
    };
  }

  function resolveRestoreTarget(layout = {}, anchor = null) {
    const paragraphs = Array.isArray(layout.paragraphs) ? layout.paragraphs : [];
    const scrollHeight = Number(layout.scrollHeight) || 0;
    const clientHeight = Number(layout.clientHeight) || 0;
    const maxScroll = Math.max(0, scrollHeight - clientHeight);
    const percent = Math.max(0, Math.min(100, Number(anchor?.progressPercent) || 0));
    const percentage = {
      mode: "percentage",
      scrollTop: Math.round(maxScroll * (percent / 100)),
      paragraphIndex: null
    };
    if (!anchor || anchor.kind !== "paragraph") return percentage;
    if (
      Number.isInteger(anchor.paragraphCount) &&
      anchor.paragraphCount !== paragraphs.length
    ) {
      return percentage;
    }
    const paragraph = paragraphs[anchor.paragraphIndex];
    if (!paragraph || !Number(paragraph.height) || !Number(paragraph.textLength)) return percentage;
    const ratio = Math.max(0, Math.min(1, Number(anchor.charOffset || 0) / Number(paragraph.textLength)));
    const scrollTop = Math.round(Number(paragraph.top) + Number(paragraph.height) * ratio);
    return {
      mode: "paragraph",
      scrollTop: Math.max(0, Math.min(maxScroll || scrollTop, scrollTop)),
      paragraphIndex: anchor.paragraphIndex
    };
  }

  function captureFromDom(scrollElement, articleElement) {
    if (!scrollElement || !articleElement) {
      return { kind: "percentage", progressPercent: 0 };
    }
    const paragraphs = [...articleElement.querySelectorAll("p")].map((element) => ({
      top: topWithin(scrollElement, element),
      height: element.getBoundingClientRect().height,
      textLength: (element.textContent || "").length
    }));
    return captureAnchor({
      paragraphs,
      scrollTop: scrollElement.scrollTop,
      scrollHeight: scrollElement.scrollHeight,
      clientHeight: scrollElement.clientHeight
    });
  }

  function isReaderShortcutEnabled(flags = {}) {
    return Boolean(
      flags.readerVisible &&
      !flags.libraryOpen &&
      !flags.shelfOpen &&
      !flags.onboardingOpen &&
      !flags.knowledgeOpen
    );
  }

  function shouldShowContinueTag(item = {}) {
    return !item.collected && isResumePromptRange(item.progressPercent);
  }

  function formatShelfTime(value, now = Date.now()) {
    const timestamp = Date.parse(value || "");
    if (!Number.isFinite(timestamp)) return "";
    const date = new Date(timestamp);
    const current = new Date(now);
    const startOfToday = new Date(current.getFullYear(), current.getMonth(), current.getDate()).getTime();
    const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const dayDiff = Math.round((startOfToday - startOfDate) / 86_400_000);
    if (dayDiff === 0) {
      const hours = String(date.getHours()).padStart(2, "0");
      const minutes = String(date.getMinutes()).padStart(2, "0");
      return `今天 ${hours}:${minutes}`;
    }
    if (dayDiff === 1) return "昨天";
    return `${date.getMonth() + 1}月${String(date.getDate()).padStart(2, "0")}日`;
  }

  function topWithin(scrollElement, element) {
    const scrollRect = scrollElement.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    return rect.top - scrollRect.top + scrollElement.scrollTop;
  }

  return {
    captureAnchor,
    captureFromDom,
    formatShelfTime,
    isReaderShortcutEnabled,
    isResumePromptRange,
    progressPercentFromScroll,
    resolveRestoreTarget,
    shouldShowContinueTag
  };
});
