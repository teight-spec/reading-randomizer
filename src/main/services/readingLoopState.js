(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) root.ReadingLoopState = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
const SKIP_COOLDOWN_DAYS = 3;
const TIME_ZONE = "Asia/Shanghai";
const CLOSEOUT_REMAINING_RATIO = 0.12;
const CLOSEOUT_REMAINING_PX = 220;
const MIN_ENGAGEMENT_PX = 80;
const MIN_ENGAGEMENT_RATIO = 0.2;
const SHORT_ARTICLE_DWELL_MS = 8_000;
const UNRELIABLE_END_REMAINING_PX = 24;

function createState() {
  return {
    version: 1,
    current: null,
    pendingInvite: null,
    pendingBookmark: null,
    marksByUrl: {},
    skipped: [],
    session: null
  };
}

function cloneState(state) {
  return structuredClone(state && typeof state === "object" ? state : createState());
}

function dayKey(now = Date.now(), timeZone = TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(now));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return `${year}-${month}-${day}`;
}

function calendarDayDiff(fromKey, toKey) {
  const from = parseDayKey(fromKey);
  const to = parseDayKey(toKey);
  if (!from || !to) return Number.POSITIVE_INFINITY;
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
}

function parseDayKey(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function isUnfinished(state) {
  return Boolean(state?.current?.articleUrl && !state.current.crossedAt);
}

function startOpen(state, now = Date.now()) {
  const next = cloneState(state);
  next.version = 1;
  next.skipped = Array.isArray(next.skipped) ? next.skipped.slice(-200) : [];
  next.marksByUrl = next.marksByUrl && typeof next.marksByUrl === "object" ? next.marksByUrl : {};
  next.pendingBookmark = next.pendingBookmark || null;
  next.session = {
    openId: `open-${now}`,
    openedAt: new Date(now).toISOString(),
    skipCount: 0,
    ended: false
  };
  let decision = "invite";
  if (isUnfinished(next)) decision = "resume";
  else if (next.pendingBookmark?.quote) decision = "pendingBookmark";
  else if (next.pendingInvite?.articleUrl) decision = "pendingInvite";
  return { state: next, decision };
}

function excludedUrls(state, now = Date.now(), cooldownDays = SKIP_COOLDOWN_DAYS) {
  const today = dayKey(now);
  const urls = new Set();
  for (const item of state?.skipped || []) {
    const key = item.dayKey || dayKey(Date.parse(item.skippedAt || "") || now);
    if (calendarDayDiff(key, today) < cooldownDays && item.articleUrl) {
      urls.add(item.articleUrl);
    }
  }
  if (isUnfinished(state) && state.current.articleUrl) urls.add(state.current.articleUrl);
  if (state?.pendingInvite?.articleUrl) urls.add(state.pendingInvite.articleUrl);
  return [...urls];
}

function articleRecord(article = {}, extras = {}) {
  return {
    articleUrl: article.articleUrl || article.url || "",
    articleTitle: article.articleTitle || article.title || "",
    siteId: article.siteId || "",
    siteTitle: article.siteTitle || "",
    siteDomain: article.siteDomain || "",
    source: article.source || "",
    inviteReason: article.inviteReason || null,
    assignedAt: extras.assignedAt || new Date(extras.now || Date.now()).toISOString(),
    via: extras.via || "invite",
    crossedAt: null,
    enteredBody: extras.enteredBody === true
  };
}

function assignCurrent(state, article, { via = "invite", now = Date.now(), enteredBody } = {}) {
  const next = cloneState(state);
  const bodyEntered = enteredBody ?? via !== "invite";
  next.current = articleRecord(article, { via, now, enteredBody: bodyEntered });
  if (via !== "invite") next.pendingInvite = null;
  return next;
}

function acceptInvite(state, now = Date.now()) {
  const next = cloneState(state);
  if (next.pendingInvite?.articleUrl) {
    const incoming = next.pendingInvite;
    next.pendingInvite = null;
    return assignCurrent(next, incoming, { via: "afterCross", now, enteredBody: true });
  }
  if (next.current) next.current.enteredBody = true;
  return next;
}

function recordSkip(state, now = Date.now()) {
  const next = cloneState(state);
  if (!isUnfinished(next) || next.session?.ended) {
    return { state: next, decision: "noop", skippedUrl: null };
  }
  const skippedUrl = next.current.articleUrl;
  next.skipped = [
    ...(next.skipped || []),
    {
      articleUrl: skippedUrl,
      articleTitle: next.current.articleTitle || "",
      skippedAt: new Date(now).toISOString(),
      dayKey: dayKey(now)
    }
  ];
  next.current = null;
  next.session = {
    ...(next.session || {}),
    skipCount: Number(next.session?.skipCount || 0) + 1,
    ended: false
  };
  if (next.session.skipCount >= 2) {
    next.session.ended = true;
    return { state: next, decision: "end", skippedUrl };
  }
  return { state: next, decision: "replace", skippedUrl };
}

function markCrossed(state, now = Date.now()) {
  const next = cloneState(state);
  if (next.current?.articleUrl && !next.current.crossedAt) {
    next.current.crossedAt = new Date(now).toISOString();
  }
  return next;
}

function setPendingInvite(state, article) {
  const next = cloneState(state);
  next.pendingInvite = articleRecord(article, { via: "invite", enteredBody: false });
  return next;
}

function estimateReadingMinutes(text) {
  const normalized = String(text || "").trim();
  if (!normalized) return 1;
  const cjkCharacters = (normalized.match(/[\u3400-\u9fff]/g) || []).length;
  const latinWords = normalized.replace(/[\u3400-\u9fff]/g, " ").split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(cjkCharacters / 420 + latinWords / 220));
}

function trimTitle(title, max = 24) {
  const text = String(title || "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max).trim()}…`;
}

function buildInviteReason({
  siteTitle,
  siteDomain,
  readingMinutes,
  recentTitle,
  sameSource
} = {}) {
  const source = siteTitle || siteDomain || "你认可的源";
  const lengthPart = readingMinutes ? `约 ${readingMinutes} 分钟` : "篇幅适中";
  let relation = "来自你认可的源，适合现在读";
  if (recentTitle && sameSource) {
    relation = `和你最近读过的《${trimTitle(recentTitle)}》来自同一源`;
  } else if (recentTitle) {
    relation = `接着你最近读过的《${trimTitle(recentTitle)}》`;
  }
  return `来自${source}，${lengthPart}。${relation}。`;
}

function hasMinEngagement({
  scrollTop = 0,
  clientHeight = 0,
  maxScrollDepth = 0,
  activeMs = 0,
  contentFitsViewport = false
} = {}) {
  const px = Math.min(MIN_ENGAGEMENT_PX, Math.max(24, Number(clientHeight) * MIN_ENGAGEMENT_RATIO));
  if (Number(scrollTop) >= px || Number(maxScrollDepth) >= MIN_ENGAGEMENT_RATIO) return true;
  if (contentFitsViewport && Number(activeMs) >= SHORT_ARTICLE_DWELL_MS) return true;
  return false;
}

function hasReliableEnd({ paywalled = false, infiniteOrUnknownEnd = false } = {}) {
  return !paywalled && !infiniteOrUnknownEnd;
}

function shouldRevealCloseout({
  hasReliableEnd: reliable,
  contentHeight = 0,
  clientHeight = 0,
  scrollTop = 0,
  maxScrollDepth = 0,
  activeMs = 0
} = {}) {
  const maxScroll = Math.max(0, Number(contentHeight) - Number(clientHeight));
  const contentFitsViewport = maxScroll <= 0;
  if (!hasMinEngagement({
    scrollTop,
    clientHeight,
    maxScrollDepth,
    activeMs,
    contentFitsViewport
  })) {
    return false;
  }
  if (contentFitsViewport) return true;
  const remaining = maxScroll - Number(scrollTop);
  const remainingRatio = remaining / maxScroll;
  if (reliable) {
    return remainingRatio <= CLOSEOUT_REMAINING_RATIO || remaining <= CLOSEOUT_REMAINING_PX;
  }
  return remaining <= UNRELIABLE_END_REMAINING_PX;
}

function shouldCrossFromScroll({
  closeoutVisible = false,
  closeoutTop = 0,
  closeoutHeight = 0,
  scrollTop = 0,
  clientHeight = 0
} = {}) {
  if (!closeoutVisible) return false;
  const viewportBottom = Number(scrollTop) + Number(clientHeight);
  const seen = viewportBottom >= Number(closeoutTop) + 8;
  const advanced = viewportBottom >= Number(closeoutTop) + Math.min(Number(closeoutHeight) * 0.45, 72);
  return seen && advanced;
}

function shouldCrossFromAction({ closeoutVisible = false, action } = {}) {
  return Boolean(closeoutVisible && action === "advance");
}

return {
  SKIP_COOLDOWN_DAYS,
  TIME_ZONE,
  SHORT_ARTICLE_DWELL_MS,
  acceptInvite,
  articleRecord,
  assignCurrent,
  buildInviteReason,
  calendarDayDiff,
  createState,
  dayKey,
  estimateReadingMinutes,
  excludedUrls,
  hasMinEngagement,
  hasReliableEnd,
  isUnfinished,
  markCrossed,
  recordSkip,
  setPendingInvite,
  shouldCrossFromAction,
  shouldCrossFromScroll,
  shouldRevealCloseout,
  startOpen
};
});
