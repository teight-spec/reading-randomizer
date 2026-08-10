class KnowledgeAnalysisQueue {
  constructor({ database, analyzer, settingsStore, pollIntervalMs = 30_000 } = {}) {
    this.database = database;
    this.analyzer = analyzer;
    this.settingsStore = settingsStore;
    this.pollIntervalMs = pollIntervalMs;
    this.interval = null;
    this.processingPromise = null;
    this.nextTimer = null;
  }

  start() {
    if (!this.interval) {
      this.interval = setInterval(() => this.wake(), this.pollIntervalMs);
    }
    this.wake();
  }

  wake(delayMs = 0) {
    clearTimeout(this.nextTimer);
    this.nextTimer = setTimeout(() => {
      this.processOne().catch((error) => {
        logQueue("queue_error", { error: error.message });
      });
    }, Math.max(0, delayMs));
  }

  async processOne() {
    if (this.processingPromise) return this.processingPromise;
    this.processingPromise = this._processOne().finally(() => {
      this.processingPromise = null;
    });
    return this.processingPromise;
  }

  async _processOne() {
    const apiKey = await this.settingsStore?.getGroqApiKey();
    if (!apiKey) return { processed: false, reason: "not_configured" };
    const job = this.database.claimNextJob();
    if (!job) return { processed: false, reason: "empty" };
    logQueue("analysis_started", { jobId: job.id, articleId: job.article_id });
    try {
      const result = await this.analyzer.analyze(job);
      this.database.completeAnalysis(job.id, result.analysis, result.metadata);
      logQueue("analysis_succeeded", {
        jobId: job.id,
        articleId: job.article_id,
        model: result.metadata.model,
        sampled: result.metadata.sampled
      });
      this.wake(2500);
      return { processed: true, articleId: job.article_id };
    } catch (error) {
      this.database.failJob(job.id, error, error.retryAfterMs || 30_000);
      logQueue("analysis_failed", {
        jobId: job.id,
        articleId: job.article_id,
        status: error.status || null,
        error: error.message
      });
      return { processed: true, failed: true, articleId: job.article_id };
    }
  }

  stop() {
    clearInterval(this.interval);
    clearTimeout(this.nextTimer);
    this.interval = null;
    this.nextTimer = null;
  }
}

function logQueue(event, payload) {
  console.info("[knowledge-analysis]", JSON.stringify({
    event,
    timestamp: Date.now(),
    payload
  }));
}

module.exports = {
  KnowledgeAnalysisQueue
};
