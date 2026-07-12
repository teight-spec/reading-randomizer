const fs = require("node:fs");
const path = require("node:path");

const required = [
  "scripts/health-report.js",
  "scripts/runtime-health-report.js",
  "scripts/probe-browser-page.js",
  "scripts/probe-reader.js",
  "scripts/probe-translation.js",
  "scripts/create-mac-launcher.js",
  "src/main/main.js",
  "src/main/services/bookmarks.js",
  "src/main/services/historyStore.js",
  "src/main/services/httpClient.js",
  "src/main/services/jsonFile.js",
  "src/main/services/articlePicker.js",
  "src/main/services/archive.js",
  "src/main/services/adaptiveStrategyEngine.js",
  "src/main/services/antiBotIntelligence.js",
  "src/main/services/articleCache.js",
  "src/main/services/articleDiscoveryPipeline.js",
  "src/main/services/articlePipeline.js",
  "src/main/services/articlePrefetcher.js",
  "src/main/services/bypassRegistry.js",
  "src/main/services/browserArticleDiscovery.js",
  "src/main/services/browserExtractionController.js",
  "src/main/services/capabilityContract.js",
  "src/main/services/capabilityExecutionContext.js",
  "src/main/services/capabilityRegistry.js",
  "src/main/services/capabilityRunner.js",
  "src/main/services/candidateFilter.js",
  "src/main/services/candidateNormalizer.js",
  "src/main/services/candidateRanker.js",
  "src/main/services/extractionQualityEvaluator.js",
  "src/main/services/feedDiscovery.js",
  "src/main/services/feedReader.js",
  "src/main/services/fallbackStormProtector.js",
  "src/main/services/pipelineTrace.js",
  "src/main/services/pipelineReplayReport.js",
  "src/main/services/requestCostModel.js",
  "src/main/services/policies.js",
  "src/main/services/policyContract.js",
  "src/main/services/requestClassification.js",
  "src/main/services/requestGovernance.js",
  "src/main/services/requestGovernor.js",
  "src/main/services/runtimeHealthReport.js",
  "src/main/services/maintenance.js",
  "src/main/services/readerMode.js",
  "src/main/services/networkDiagnostics.js",
  "src/main/services/extractionSession.js",
  "src/main/services/requestBlocker.js",
  "src/main/services/siteStore.js",
  "src/main/services/siteHealthStore.js",
  "src/main/services/siteStrategies.js",
  "src/main/services/sitemapReader.js",
  "src/main/services/translationStore.js",
  "src/main/services/translator.js",
  "src/main/sites/atlantic.js",
  "src/main/sites/economist.js",
  "src/main/sites/guardian.js",
  "src/main/sites/newyorker.js",
  "src/main/sites/nyt.js",
  "src/main/sites/pulitzer.js",
  "src/preload/preload.js",
  "src/renderer/index.html",
  "src/renderer/app.js",
  "src/renderer/runtimeReporter.js",
  "src/renderer/styles.css"
];

let ok = true;
for (const file of required) {
  const fullPath = path.join(__dirname, "..", file);
  if (!fs.existsSync(fullPath)) {
    console.error(`missing: ${file}`);
    ok = false;
  }
}

if (!ok) {
  process.exit(1);
}

console.log("smoke check passed");
