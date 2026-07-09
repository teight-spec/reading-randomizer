const { app } = require("electron");
const { SiteStore } = require("../src/main/services/siteStore");
const { ArticleCache } = require("../src/main/services/articleCache");
const { pickRecentArticles } = require("../src/main/services/articlePicker");
const { discoverArticlesWithBrowser } = require("../src/main/services/browserArticleDiscovery");
const { extractReaderArticle } = require("../src/main/services/readerMode");

const CONCURRENCY = Number(process.env.AUDIT_CONCURRENCY || 4);
const ARTICLE_LIMIT = Number(process.env.AUDIT_ARTICLE_LIMIT || 5);
const SITE_TIMEOUT_MS = Number(process.env.AUDIT_SITE_TIMEOUT_MS || 25000);

app.on("window-all-closed", () => {
  // Keep audit alive while hidden discovery windows are opened and destroyed.
});

async function main() {
  app.setName("reading-randomizer");
  await app.whenReady();
  const siteStore = new SiteStore(app.getPath("userData"));
  const articleCache = new ArticleCache(app.getPath("userData"));
  const activeSites = await siteStore.listActiveSites();
  const domainFilter = (process.env.AUDIT_DOMAIN || "").toLowerCase();
  const limit = Number(process.env.AUDIT_LIMIT || 0);
  const sites = activeSites
    .filter((site) => !domainFilter || site.domain.toLowerCase().includes(domainFilter) || site.title.toLowerCase().includes(domainFilter))
    .slice(0, limit || activeSites.length);
  const results = [];

  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, sites.length) }, async () => {
      while (index < sites.length) {
        const site = sites[index++];
        results.push(await withTimeout(auditSite(site, articleCache), SITE_TIMEOUT_MS, fail(site, `Timed out after ${SITE_TIMEOUT_MS}ms`)));
      }
    })
  );

  const passed = results.filter((result) => result.ok).length;
  const failed = results.length - passed;

  console.log(`Audited ${results.length} active sources. Success: ${passed}. Needs attention: ${failed}.`);
  for (const result of results) {
    const marker = result.ok ? "OK" : "FAIL";
    console.log(`${marker}\t${result.siteTitle}\t${result.domain}\t${result.reason}`);
    if (result.articleUrl) console.log(`  ${result.articleUrl}`);
  }

  app.quit();
  if (failed) process.exitCode = 2;
}

function withTimeout(promise, timeoutMs, timeoutValue) {
  return Promise.race([
    promise,
    new Promise((resolve) => {
      setTimeout(() => resolve(timeoutValue), timeoutMs);
    })
  ]);
}

async function auditSite(site, articleCache) {
  try {
    let articles = await pickRecentArticles(site, ARTICLE_LIMIT);
    if (!articles.length && shouldUseBrowserDiscovery(site)) {
      articles = await discoverArticlesWithBrowser(site, ARTICLE_LIMIT);
    }
    await articleCache.putCandidates(site, articles);
    if (!articles.length) {
      return fail(site, "No article-level URL discovered");
    }

    const errors = [];
    for (const article of articles) {
      try {
        const readerArticle = await extractReaderArticle(article.url);
        await articleCache.putReady(site, article, readerArticle);
        return {
          ok: true,
          siteTitle: site.title,
          domain: site.domain,
          articleUrl: article.url,
          reason: `${readerArticle.textContent.length} chars extracted via ${readerArticle.diagnostics?.parser || "unknown"}`
        };
      } catch (error) {
        await articleCache.putFailed(site, article, error);
        errors.push(`${article.url}: ${error.message}${formatDiagnostics(error.diagnostics)}`);
      }
    }

    return fail(site, errors.slice(0, 2).join(" | "));
  } catch (error) {
    return fail(site, error.message);
  }
}

function shouldUseBrowserDiscovery(site) {
  return ["economist.com", "newyorker.com"].includes(site.domain);
}

function formatDiagnostics(diagnostics) {
  if (!diagnostics) return "";
  return ` stage=${diagnostics.stage || "unknown"} status=${diagnostics.status || "n/a"} html=${diagnostics.htmlBytes || 0} selectors=${diagnostics.selectorMatches?.length || 0}`;
}

function fail(site, reason) {
  return {
    ok: false,
    siteTitle: site.title,
    domain: site.domain,
    articleUrl: "",
    reason
  };
}

main().catch((error) => {
  console.error(error);
  app.quit();
  process.exit(1);
});
