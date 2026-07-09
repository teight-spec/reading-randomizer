(function () {
  function installRuntimeReporter(getContext = () => ({})) {
    window.addEventListener("error", (event) => {
      reportRuntimeError("renderer_uncaught_error", event.error || event.message, {
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno
      }, getContext);
    });
    window.addEventListener("unhandledrejection", (event) => {
      reportRuntimeError("renderer_unhandled_rejection", event.reason, {}, getContext);
    });
  }

  function reportRuntimeError(event, error, metadata = {}, getContext = () => ({})) {
    const context = getContext() || {};
    const payload = {
      event,
      timestamp: Date.now(),
      message: error?.message || String(error),
      name: error?.name || "Error",
      stack: error?.stack || null,
      articleUrl: context.articleUrl || null,
      siteId: context.siteId || null,
      metadata
    };
    console.error("[renderer-runtime]", JSON.stringify(payload));
    try {
      window.readerApi?.reportRendererError?.(payload).catch(() => {});
    } catch {
      // Reporting should never create a second failure path.
    }
  }

  window.readerRuntimeReporter = {
    install: installRuntimeReporter,
    report: reportRuntimeError
  };
})();
