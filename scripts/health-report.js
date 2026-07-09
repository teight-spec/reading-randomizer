const { app } = require("electron");
const { ArticleCache } = require("../src/main/services/articleCache");

async function main() {
  app.setName("reading-randomizer");
  await app.whenReady();
  const articleCache = new ArticleCache(app.getPath("userData"));
  const health = Object.values(await articleCache.getHealth())
    .sort((a, b) => {
      const aScore = Number(a.extractionSuccessRate ?? -1) + Number(a.candidateSuccessRate ?? -1);
      const bScore = Number(b.extractionSuccessRate ?? -1) + Number(b.candidateSuccessRate ?? -1);
      return aScore - bScore;
    });

  console.log(`Source health entries: ${health.length}`);
  for (const item of health) {
    console.log(
      [
        item.siteTitle,
        item.domain,
        `candidate=${formatRate(item.candidateSuccessRate)}`,
        `extract=${formatRate(item.extractionSuccessRate)}`,
        `parsers=${Object.keys(item.parsers || {}).join(",") || "none"}`,
        `last=${item.lastError || "ok"}`
      ].join("\t")
    );
  }

  app.quit();
}

function formatRate(value) {
  return value === null || value === undefined ? "n/a" : `${Math.round(value * 100)}%`;
}

main().catch((error) => {
  console.error(error);
  app.quit();
  process.exit(1);
});
