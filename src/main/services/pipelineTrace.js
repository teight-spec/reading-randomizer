class PipelineTrace {
  constructor({ traceId, site, strategy }) {
    this.traceId = traceId;
    this.site = {
      id: site.id || null,
      title: site.title || "",
      domain: site.domain || safeHost(site.url),
      url: site.url
    };
    this.strategy = strategy?.id || "generic";
    this.startedAt = Date.now();
    this.events = [];
  }

  transition(from, to, payload = {}) {
    this.events.push({
      type: "transition",
      from,
      to,
      at: Date.now(),
      elapsedMs: Date.now() - this.startedAt,
      ...payload
    });
    this.log("transition", this.events[this.events.length - 1]);
  }

  stage(stageName, payload = {}) {
    this.events.push({
      type: "stage",
      stageName,
      at: Date.now(),
      elapsedMs: Date.now() - this.startedAt,
      ...payload
    });
    this.log("stage", this.events[this.events.length - 1]);
  }

  summary(payload = {}) {
    return {
      traceId: this.traceId,
      site: this.site,
      strategy: this.strategy,
      durationMs: Date.now() - this.startedAt,
      events: this.events,
      ...payload
    };
  }

  log(event, payload) {
    console.info("[pipeline-trace]", JSON.stringify({
      event,
      timestamp: Date.now(),
      traceId: this.traceId,
      payload
    }));
  }
}

function safeHost(url = "") {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

module.exports = {
  PipelineTrace
};
