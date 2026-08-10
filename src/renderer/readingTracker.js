(() => {
  const ACTIVE_TARGET_MS = 180_000;
  const SCROLL_TARGET = 0.9;
  const BOTTOM_DWELL_TARGET_MS = 5_000;
  const IDLE_TIMEOUT_MS = 90_000;
  const SAVE_INTERVAL_MS = 15_000;
  const TICK_INTERVAL_MS = 1_000;

  class ReadingProgressTracker {
    configure(options) {
      this.options = options;
      this.scrollElement = options.scrollElement;
      this.lastInteractionAt = Date.now();
      this.lastTickAt = Date.now();
      this.lastSavedAt = 0;
      this.session = null;
      this.flushPromise = null;
      this.flushQueued = false;
      this.bound = false;
      this.bind();
    }

    bind() {
      if (this.bound || !this.scrollElement) return;
      this.bound = true;
      this.scrollElement.addEventListener("scroll", () => {
        this.recordInteraction();
        this.updateScrollDepth();
      }, { passive: true });
      document.addEventListener("pointerdown", () => this.recordInteraction(), { passive: true });
      document.addEventListener("keydown", () => this.recordInteraction(), { passive: true });
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible") this.flush();
      });
      window.addEventListener("blur", () => this.flush());
      window.addEventListener("focus", () => this.recordInteraction());
      window.addEventListener("beforeunload", () => this.flush());
    }

    start() {
      const context = this.options?.getContext?.();
      if (!context?.articleUrl) return;
      if (this.session?.articleUrl === context.articleUrl) {
        this.updateScrollDepth();
        return;
      }
      if (this.session) this.stop();
      const timestamp = new Date().toISOString();
      this.session = {
        ...context,
        sessionId: createSessionId(),
        startedAt: timestamp,
        activeMs: 0,
        maxScrollDepth: 0,
        bottomDwellMs: 0,
        reportedActiveMs: 0,
        reportedScrollDepth: 0,
        completed: false
      };
      this.lastInteractionAt = Date.now();
      this.lastTickAt = Date.now();
      this.lastSavedAt = 0;
      this.updateScrollDepth();
      this.renderProgress();
      clearInterval(this.interval);
      this.interval = setInterval(() => this.tick(), TICK_INTERVAL_MS);
    }

    async stop() {
      const session = this.session;
      clearInterval(this.interval);
      this.interval = null;
      this.session = null;
      if (session) await this.flushSession(session);
      this.options?.onProgress?.(null);
    }

    tick() {
      if (!this.session) return;
      const now = Date.now();
      const elapsed = Math.max(0, Math.min(now - this.lastTickAt, 2_000));
      this.lastTickAt = now;
      this.updateScrollDepth();
      if (this.isActivelyReading(now)) {
        this.session.activeMs += elapsed;
        if (this.currentScrollDepth() >= SCROLL_TARGET) {
          this.session.bottomDwellMs += elapsed;
        }
      }
      this.renderProgress();
      const completionCandidate =
        this.session.activeMs >= ACTIVE_TARGET_MS &&
        this.session.maxScrollDepth >= SCROLL_TARGET &&
        this.session.bottomDwellMs >= BOTTOM_DWELL_TARGET_MS;
      if (completionCandidate || now - this.lastSavedAt >= SAVE_INTERVAL_MS) this.flush();
    }

    recordInteraction() {
      this.lastInteractionAt = Date.now();
    }

    isActivelyReading(now) {
      return Boolean(
        this.session &&
        document.visibilityState === "visible" &&
        document.hasFocus() &&
        this.options?.isReaderVisible?.() &&
        now - this.lastInteractionAt <= IDLE_TIMEOUT_MS
      );
    }

    currentScrollDepth() {
      if (!this.scrollElement) return 0;
      const scrollHeight = Math.max(this.scrollElement.scrollHeight, 1);
      return Math.max(0, Math.min(1, (this.scrollElement.scrollTop + this.scrollElement.clientHeight) / scrollHeight));
    }

    updateScrollDepth() {
      if (!this.session) return;
      this.session.maxScrollDepth = Math.max(this.session.maxScrollDepth, this.currentScrollDepth());
    }

    async flush() {
      if (!this.session) return null;
      if (this.flushPromise) {
        this.flushQueued = true;
        return this.flushPromise;
      }
      const snapshot = { ...this.session };
      this.flushPromise = this.flushSession(snapshot).finally(() => {
        this.flushPromise = null;
        if (this.flushQueued) {
          this.flushQueued = false;
          this.flush();
        }
      });
      return this.flushPromise;
    }

    async flushSession(session) {
      if (!session?.articleUrl || !window.readerApi?.saveReadingProgress) return null;
      try {
        const result = await window.readerApi.saveReadingProgress({
          sessionId: session.sessionId,
          articleUrl: session.articleUrl,
          articleTitle: session.articleTitle,
          siteId: session.siteId,
          siteTitle: session.siteTitle,
          siteDomain: session.siteDomain,
          startedAt: session.startedAt,
          activeMs: Math.round(session.activeMs),
          maxScrollDepth: session.maxScrollDepth,
          bottomDwellMs: Math.round(session.bottomDwellMs)
        });
        this.lastSavedAt = Date.now();
        if (this.session?.sessionId === session.sessionId && result?.completed) {
          const firstNotification = !this.session.completed;
          this.session.completed = true;
          if (firstNotification && result.newlyCompleted) this.options?.onCompleted?.(result);
        }
        if (this.session?.sessionId === session.sessionId && result) {
          this.session.reportedActiveMs = Math.max(this.session.reportedActiveMs || 0, Number(result.activeMs || 0));
          this.session.reportedScrollDepth = Math.max(this.session.reportedScrollDepth || 0, Number(result.maxScrollDepth || 0));
          this.renderProgress();
        }
        return result;
      } catch (error) {
        this.options?.onError?.(error);
        return null;
      }
    }

    renderProgress() {
      if (!this.session) return;
      this.options?.onProgress?.({
        activeMs: Math.max(this.session.activeMs, this.session.reportedActiveMs || 0),
        maxScrollDepth: Math.max(this.session.maxScrollDepth, this.session.reportedScrollDepth || 0),
        completed: this.session.completed,
        targets: {
          activeMs: ACTIVE_TARGET_MS,
          scrollDepth: SCROLL_TARGET
        }
      });
    }
  }

  function createSessionId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `reading-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  window.ReaderProgressTracker = new ReadingProgressTracker();
})();
