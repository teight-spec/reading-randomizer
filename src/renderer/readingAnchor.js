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

  function topWithin(scrollElement, element) {
    const scrollRect = scrollElement.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    return rect.top - scrollRect.top + scrollElement.scrollTop;
  }

  return {
    captureAnchor,
    captureFromDom,
    isResumePromptRange,
    progressPercentFromScroll,
    resolveRestoreTarget
  };
});
