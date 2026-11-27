#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const { HistoryStore } = require("../src/main/services/historyStore");
const { TranslationStore } = require("../src/main/services/translationStore");
const { KnowledgeDatabase } = require("../src/main/services/knowledgeDatabase");
const { ArticleCache } = require("../src/main/services/articleCache");
const { SiteHealthStore } = require("../src/main/services/siteHealthStore");

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--from") out.from = value;
    if (key === "--to") out.to = value;
    if (key === "--from" || key === "--to") i += 1;
  }
  return out;
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function fileMeta(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false };
  const stat = fs.statSync(filePath);
  return { exists: true, bytes: stat.size, sha256: sha256File(filePath) };
}

function uniqueKey(item, fields) {
  return fields.map((field) => String(item?.[field] || "")).join("\0");
}

function mergeArticleLists(existing, incoming, identityFields, keepField) {
  const merged = [...existing];
  const seen = new Set(existing.map((item) => uniqueKey(item, identityFields)));
  let added = 0;
  for (const item of incoming) {
    const key = uniqueKey(item, identityFields);
    if (!key.trim() || seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
    added += 1;
  }
  if (keepField) {
    merged.sort((a, b) => String(a?.[keepField] || "").localeCompare(String(b?.[keepField] || "")));
  }
  return { merged, added, total: merged.length };
}

function mergeSiteRound(existing = {}, incoming = {}) {
  const out = { ...existing };
  let addedKeys = 0;
  let addedItems = 0;
  for (const [key, value] of Object.entries(incoming)) {
    if (!Object.prototype.hasOwnProperty.call(out, key)) {
      out[key] = Array.isArray(value) ? [...value] : value;
      addedKeys += 1;
      addedItems += Array.isArray(value) ? value.length : 1;
      continue;
    }
    if (Array.isArray(out[key]) && Array.isArray(value)) {
      const seen = new Set(out[key].map((item) => JSON.stringify(item)));
      for (const item of value) {
        const encoded = JSON.stringify(item);
        if (seen.has(encoded)) continue;
        seen.add(encoded);
        out[key].push(item);
        addedItems += 1;
      }
    }
  }
  return { merged: out, addedKeys, addedItems, totalKeys: Object.keys(out).length };
}

function mergeMaps(existing = {}, incoming = {}) {
  const out = { ...existing };
  let added = 0;
  for (const [key, value] of Object.entries(incoming)) {
    if (Object.prototype.hasOwnProperty.call(out, key)) continue;
    out[key] = value;
    added += 1;
  }
  return { merged: out, added, total: Object.keys(out).length };
}

async function copySettingsIfNeeded(fromDir, toDir, report) {
  const source = path.join(fromDir, "secure-settings.json");
  const target = path.join(toDir, "secure-settings.json");
  report.secureSettings = { source: fileMeta(source), targetBefore: fileMeta(target) };
  if (!fs.existsSync(source)) {
    report.secureSettings.action = "skipped-missing-source";
    return;
  }
  const sourceRaw = JSON.parse(fs.readFileSync(source, "utf8"));
  report.secureSettings.sourceFields = {
    version: sourceRaw.version ?? null,
    hasTranslationConsent: sourceRaw.translationConsent === true,
    hasEncryptedKey: typeof sourceRaw.groqEncryptedKey === "string" && sourceRaw.groqEncryptedKey.length > 0,
    encryptedKeyLength: typeof sourceRaw.groqEncryptedKey === "string" ? sourceRaw.groqEncryptedKey.length : 0,
    hasGroqModel: typeof sourceRaw.groqModel === "string" && sourceRaw.groqModel.length > 0,
    readerFontSize: sourceRaw.readerFontSize ?? null,
    readerWidth: sourceRaw.readerWidth ?? null
  };
  if (fs.existsSync(target)) {
    const targetRaw = JSON.parse(fs.readFileSync(target, "utf8"));
    const targetHasKey = typeof targetRaw.groqEncryptedKey === "string" && targetRaw.groqEncryptedKey.length > 0;
    if (targetHasKey && targetRaw.groqEncryptedKey !== sourceRaw.groqEncryptedKey) {
      report.secureSettings.action = "skipped-conflicting-target-key";
      return;
    }
  }
  await fsp.copyFile(source, target);
  await fsp.chmod(target, 0o600);
  report.secureSettings.targetAfter = fileMeta(target);
  report.secureSettings.action = "copied";
  report.secureSettings.hashMatch = report.secureSettings.source.sha256 === report.secureSettings.targetAfter.sha256;
}

async function migrateHistory(fromDir, toDir, report) {
  const targetStore = new HistoryStore(toDir);
  const source = await readJson(path.join(fromDir, "reading-history.json")) || { openedArticles: [], readArticles: [], siteRound: {} };
  const target = await targetStore.load();
  const opened = mergeArticleLists(
    target.openedArticles || [],
    source.openedArticles || [],
    ["articleUrl"],
    "openedAt"
  );
  const read = mergeArticleLists(
    target.readArticles || [],
    source.readArticles || [],
    ["articleUrl"],
    "readAt"
  );
  const rounds = mergeSiteRound(target.siteRound || {}, source.siteRound || {});
  await targetStore.save({
    openedArticles: opened.merged,
    readArticles: read.merged,
    siteRound: rounds.merged
  });
  report.history = {
    openedAdded: opened.added,
    openedTotal: opened.total,
    readAdded: read.added,
    readTotal: read.total,
    siteRoundKeysAdded: rounds.addedKeys,
    siteRoundItemsAdded: rounds.addedItems,
    siteRoundKeysTotal: rounds.totalKeys
  };
}

async function migrateTranslationCache(fromDir, toDir, report) {
  const targetStore = new TranslationStore(toDir);
  const sourceRaw = await readJson(path.join(fromDir, "translation-cache.json")) || { items: {}, version: 1 };
  const source = { version: sourceRaw.version || 1, items: sourceRaw.items && typeof sourceRaw.items === "object" ? sourceRaw.items : {} };
  const target = await targetStore.load();
  const sourceItems = source.items && typeof source.items === "object" ? source.items : {};
  const targetItems = target.items && typeof target.items === "object" ? target.items : {};
  const merged = mergeMaps(targetItems, sourceItems);
  await targetStore.save({ version: target.version || source.version || 1, items: merged.merged });
  report.translationCache = {
    sourceItems: Object.keys(sourceItems).length,
    added: merged.added,
    total: merged.total
  };
}

function migrateSessions(fromDir, toDir, report) {
  const { DatabaseSync } = require("node:sqlite");
  const sourcePath = path.join(fromDir, "reading-knowledge.db");
  const sourceDb = new DatabaseSync(sourcePath, { readOnly: true });
  const targetDb = new KnowledgeDatabase(toDir);
  const rows = sourceDb.prepare(`
    SELECT session_id, article_url, article_title, started_at, last_seen_at,
           active_ms, max_scroll_depth, bottom_dwell_ms, completed_at
    FROM reading_sessions
  `).all();
  let imported = 0;
  let skipped = 0;
  const existing = new Set(
    targetDb.db.prepare("SELECT session_id FROM reading_sessions").all().map((row) => row.session_id)
  );
  for (const row of rows) {
    if (existing.has(row.session_id)) {
      skipped += 1;
      continue;
    }
    targetDb.recordProgress({
      sessionId: row.session_id,
      articleUrl: row.article_url,
      articleTitle: row.article_title,
      startedAt: row.started_at,
      activeMs: row.active_ms,
      maxScrollDepth: row.max_scroll_depth,
      bottomDwellMs: row.bottom_dwell_ms,
      progressPercent: Math.round(Number(row.max_scroll_depth || 0) * 100)
    });
    if (row.completed_at) {
      targetDb.db.prepare(
        "UPDATE reading_sessions SET completed_at = ?, last_seen_at = COALESCE(?, last_seen_at) WHERE session_id = ?"
      ).run(row.completed_at, row.last_seen_at, row.session_id);
    } else if (row.last_seen_at) {
      targetDb.db.prepare(
        "UPDATE reading_sessions SET last_seen_at = ? WHERE session_id = ?"
      ).run(row.last_seen_at, row.session_id);
    }
    imported += 1;
    existing.add(row.session_id);
  }
  const targetCount = targetDb.db.prepare("SELECT COUNT(*) AS n FROM reading_sessions").get().n;
  const sourceCount = rows.length;
  report.sessions = {
    source: sourceCount,
    imported,
    skippedExisting: skipped,
    targetTotal: targetCount
  };
  try { sourceDb.close(); } catch { /* ignore */ }
  try { targetDb.db.close(); } catch { /* ignore */ }
}

async function migrateArticleCache(fromDir, toDir, report) {
  const targetStore = new ArticleCache(toDir);
  const source = await readJson(path.join(fromDir, "article-cache.json"));
  const target = await targetStore.load();
  if (!source || !target) {
    report.articleCache = { action: "skipped-unreadable" };
    return;
  }
  const articles = mergeMaps(target.articlesByUrl || {}, source.articlesByUrl || {});
  const candidates = mergeMaps(target.candidatesBySite || {}, source.candidatesBySite || {});
  const health = mergeMaps(target.healthBySite || {}, source.healthBySite || {});
  const merged = {
    ...target,
    version: target.version || source.version,
    updatedAt: new Date().toISOString(),
    articlesByUrl: articles.merged,
    candidatesBySite: candidates.merged,
    healthBySite: health.merged
  };
  if (typeof targetStore.save === "function") {
    await targetStore.save(merged);
  } else {
    await fsp.writeFile(path.join(toDir, "article-cache.json"), `${JSON.stringify(merged)}\n`);
  }
  report.articleCache = {
    articlesAdded: articles.added,
    articlesTotal: articles.total,
    candidatesAdded: candidates.added,
    candidatesTotal: candidates.total,
    healthAdded: health.added,
    healthTotal: health.total
  };
}

async function migrateSiteHealth(fromDir, toDir, report) {
  const sourcePath = path.join(fromDir, "site-health.json");
  const targetPath = path.join(toDir, "site-health.json");
  if (!fs.existsSync(sourcePath)) {
    report.siteHealth = { action: "skipped-missing-source" };
    return;
  }
  const targetStore = new SiteHealthStore(toDir);
  const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  const target = await targetStore.load();
  const sourceMap = source.items || source.sites || source;
  const targetMap = target.items || target.sites || target;
  if (!sourceMap || typeof sourceMap !== "object" || Array.isArray(sourceMap)) {
    report.siteHealth = { action: "skipped-unknown-shape", sourceKeys: source && typeof source === "object" ? Object.keys(source) : [] };
    return;
  }
  const base = targetMap && typeof targetMap === "object" && !Array.isArray(targetMap) ? targetMap : {};
  const merged = mergeMaps(base, sourceMap);
  if (typeof targetStore.save === "function") {
    const payload = target.items ? { ...target, items: merged.merged } : (target.sites ? { ...target, sites: merged.merged } : merged.merged);
    await targetStore.save(payload);
  } else {
    const payload = target.items ? { ...target, items: merged.merged } : (target.sites ? { ...target, sites: merged.merged } : { ...target, ...merged.merged });
    await fsp.writeFile(targetPath, `${JSON.stringify(payload)}\n`);
    await fsp.chmod(targetPath, 0o600);
  }
  report.siteHealth = { added: merged.added, total: merged.total };
}

async function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(await fsp.readFile(filePath, "utf8"));
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.from || !args.to) {
    throw new Error("Usage: node scripts/migrate-legacy-userdata.js --from <oldUserData> --to <verifyUserData>");
  }
  const fromDir = path.resolve(args.from);
  const toDir = path.resolve(args.to);
  if (!fs.existsSync(fromDir) || !fs.existsSync(toDir)) {
    throw new Error("Source or target userData directory is missing");
  }
  const report = { fromExists: true, toExists: true, startedAt: new Date().toISOString() };
  await copySettingsIfNeeded(fromDir, toDir, report);
  await migrateHistory(fromDir, toDir, report);
  await migrateTranslationCache(fromDir, toDir, report);
  migrateSessions(fromDir, toDir, report);
  try {
    await migrateArticleCache(fromDir, toDir, report);
  } catch (error) {
    report.articleCache = { action: "failed", error: error.message };
  }
  try {
    await migrateSiteHealth(fromDir, toDir, report);
  } catch (error) {
    report.siteHealth = { action: "failed", error: error.message };
  }
  report.finishedAt = new Date().toISOString();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
