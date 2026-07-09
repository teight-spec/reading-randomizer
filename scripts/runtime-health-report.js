const os = require("node:os");
const path = require("node:path");
const { ArticleCache } = require("../src/main/services/articleCache");
const { SiteHealthStore } = require("../src/main/services/siteHealthStore");
const { buildRuntimeHealthReport, renderRuntimeHealthReport } = require("../src/main/services/runtimeHealthReport");

async function main() {
  const userDataPath = getUserDataPath();
  const articleCache = new ArticleCache(userDataPath);
  const siteHealthStore = new SiteHealthStore(userDataPath);
  const report = buildRuntimeHealthReport({
    articleHealth: await articleCache.getHealth(),
    siteHealth: await siteHealthStore.load()
  });
  console.log(renderRuntimeHealthReport(report));
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
