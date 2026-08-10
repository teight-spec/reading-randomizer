const os = require("node:os");
const path = require("node:path");
const { ArticleCache } = require("../src/main/services/articleCache");
const { SiteHealthStore } = require("../src/main/services/siteHealthStore");
const { RuntimeDiagnosticsStore } = require("../src/main/services/runtimeDiagnosticsStore");
const { buildRuntimeHealthReport, renderRuntimeHealthReport } = require("../src/main/services/runtimeHealthReport");

async function main() {
  const userDataPath = getUserDataPath();
  const articleCache = new ArticleCache(userDataPath);
  const siteHealthStore = new SiteHealthStore(userDataPath);
  const runtimeDiagnosticsStore = new RuntimeDiagnosticsStore(userDataPath);
  const runtimeEvents = await runtimeDiagnosticsStore.list();
  const monitoringEnabled = runtimeEvents.some((entry) => entry.event === "runtime_monitoring_started");
  const report = buildRuntimeHealthReport({
    networkErrors: monitoringEnabled ? runtimeEvents.map(toHealthEvent).filter(Boolean) : null,
    articleHealth: await articleCache.getHealth(),
    siteHealth: await siteHealthStore.load(),
    browserMetrics: monitoringEnabled ? buildBrowserMetrics(runtimeEvents) : null
  });
  console.log(renderRuntimeHealthReport(report));
}

function buildBrowserMetrics(events) {
  return {
    cleanupFailures: events.filter((entry) => [
      "browser_extraction_stop_failed",
      "browser_extraction_destroy_failed",
      "browser_extraction_cleanup_failed"
    ].includes(entry.event)).length
  };
}

function toHealthEvent(entry) {
  if (entry.event === "ipc_failed") {
    return { ...entry.payload, probableModule: "ipc" };
  }
  if (String(entry.event || "").startsWith("network_")) {
    return entry.payload || {};
  }
  return null;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

function getUserDataPath() {
  if (process.env.READER_USER_DATA_PATH) return process.env.READER_USER_DATA_PATH;
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "reading-randomizer");
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "reading-randomizer");
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "reading-randomizer");
}
