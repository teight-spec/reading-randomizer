const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_CATEGORIES = [
  { slug: "world-politics", name: "国际与政治" },
  { slug: "business-economy", name: "商业与经济" },
  { slug: "technology-ai", name: "科技与 AI" },
  { slug: "society-public", name: "社会与公共议题" },
  { slug: "culture-literature", name: "文化与文学" },
  { slug: "fashion-design", name: "时尚与设计" },
  { slug: "science-environment", name: "科学与环境" },
  { slug: "people-ideas", name: "人物与思想" }
];

const READ_THRESHOLDS = {
  activeMs: 180_000,
  scrollDepth: 0.9,
  bottomDwellMs: 5_000
};

class KnowledgeDatabase {
  constructor(userDataPath, { DatabaseSyncImpl } = {}) {
    const DatabaseSync = DatabaseSyncImpl || require("node:sqlite").DatabaseSync;
    fs.mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
    this.filePath = path.join(userDataPath, "reading-knowledge.db");
    this.db = new DatabaseSync(this.filePath, { timeout: 5000 });
    this.initialize();
    this.tightenPermissions();
  }

  initialize() {
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA secure_delete = ON");
    this.db.exec("PRAGMA wal_autocheckpoint = 500");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS reading_sessions (
        session_id TEXT PRIMARY KEY,
        article_url TEXT NOT NULL,
        article_title TEXT,
        started_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        active_ms INTEGER NOT NULL DEFAULT 0,
        max_scroll_depth REAL NOT NULL DEFAULT 0,
        bottom_dwell_ms INTEGER NOT NULL DEFAULT 0,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS reading_sessions_url_idx
        ON reading_sessions(article_url);

      CREATE TABLE IF NOT EXISTS articles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        canonical_url TEXT NOT NULL UNIQUE,
        original_url TEXT NOT NULL,
        site_id TEXT,
        site_title TEXT,
        site_domain TEXT,
        title TEXT NOT NULL,
        author TEXT,
        published_at TEXT,
        language TEXT,
        excerpt TEXT,
        content_html TEXT,
        content_text TEXT,
        content_hash TEXT,
        active_reading_ms INTEGER NOT NULL DEFAULT 0,
        max_scroll_depth REAL NOT NULL DEFAULT 0,
        knowledge_status TEXT NOT NULL DEFAULT 'pending_analysis',
        completed_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS articles_completed_idx
        ON articles(completed_at DESC);
      CREATE INDEX IF NOT EXISTS articles_status_idx
        ON articles(knowledge_status);

      CREATE TABLE IF NOT EXISTS summaries (
        article_id INTEGER PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
        thesis TEXT NOT NULL,
        key_points_json TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        why_it_matters TEXT NOT NULL,
        entities_json TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        source_hash TEXT,
        generated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL UNIQUE,
        sort_order INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS article_categories (
        article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
        category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
        is_primary INTEGER NOT NULL DEFAULT 1,
        source TEXT NOT NULL DEFAULT 'ai',
        confidence REAL,
        PRIMARY KEY(article_id, category_id)
      );

      CREATE TABLE IF NOT EXISTS tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE
      );

      CREATE TABLE IF NOT EXISTS article_tags (
        article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
        tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        source TEXT NOT NULL DEFAULT 'ai',
        confidence REAL,
        PRIMARY KEY(article_id, tag_id)
      );

      CREATE TABLE IF NOT EXISTS analysis_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        article_id INTEGER NOT NULL UNIQUE REFERENCES articles(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS analysis_jobs_status_idx
        ON analysis_jobs(status, next_attempt_at);
    `);

    const insertCategory = this.db.prepare(`
      INSERT OR IGNORE INTO categories(slug, name, sort_order)
      VALUES (?, ?, ?)
    `);
    DEFAULT_CATEGORIES.forEach((category, index) => {
      insertCategory.run(category.slug, category.name, index);
    });
    this.db.prepare(`
      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
      VALUES (1, ?)
    `).run(nowIso());
    this.db.prepare(`
      UPDATE analysis_jobs
      SET status = 'pending', updated_at = ?
      WHERE status = 'running'
    `).run(nowIso());
    this.applyMigrations();
  }

  applyMigrations() {
    const migrations = [
      {
        version: 2,
        up: () => this.db.exec(`
          CREATE INDEX IF NOT EXISTS articles_site_idx
            ON articles(site_domain, completed_at DESC);
          CREATE INDEX IF NOT EXISTS reading_sessions_completed_idx
            ON reading_sessions(completed_at, last_seen_at DESC);
        `)
      }
    ];
    const row = this.db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get();
    const currentVersion = Number(row?.version || 0);
    const pending = migrations.filter((migration) => migration.version > currentVersion);
    if (!pending.length) return;
    this.backupBeforeMigration(currentVersion);
    for (const migration of pending) {
      this.transaction(() => {
        migration.up();
        this.db.prepare(`
          INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)
        `).run(migration.version, nowIso());
      });
    }
  }

  backupBeforeMigration(currentVersion) {
    const articleCount = Number(this.db.prepare("SELECT COUNT(*) AS total FROM articles").get()?.total || 0);
    if (!articleCount || !fs.existsSync(this.filePath)) return null;
    const backupPath = `${this.filePath}.backup-v${currentVersion}`;
    if (fs.existsSync(backupPath)) return backupPath;
    this.db.exec("PRAGMA wal_checkpoint(FULL)");
    fs.copyFileSync(this.filePath, backupPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(backupPath, 0o600);
    return backupPath;
  }

  tightenPermissions() {
    for (const filePath of [this.filePath, `${this.filePath}-wal`, `${this.filePath}-shm`]) {
      try {
        if (fs.existsSync(filePath)) fs.chmodSync(filePath, 0o600);
      } catch {
        // The database remains usable if the platform refuses a permission change.
      }
    }
  }

  recordProgress(payload = {}, cachedItem = null) {
    const progress = normalizeProgress(payload);
    const canonicalUrl = normalizeUrl(cachedItem?.article?.url || progress.articleUrl);
    if (!canonicalUrl) throw new Error("A valid article URL is required");

    return this.transaction(() => {
      this.db.prepare(`
        INSERT INTO reading_sessions(
          session_id, article_url, article_title, started_at, last_seen_at,
          active_ms, max_scroll_depth, bottom_dwell_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          article_url = excluded.article_url,
          article_title = excluded.article_title,
          last_seen_at = excluded.last_seen_at,
          active_ms = MAX(reading_sessions.active_ms, excluded.active_ms),
          max_scroll_depth = MAX(reading_sessions.max_scroll_depth, excluded.max_scroll_depth),
          bottom_dwell_ms = MAX(reading_sessions.bottom_dwell_ms, excluded.bottom_dwell_ms)
      `).run(
        progress.sessionId,
        canonicalUrl,
        progress.articleTitle,
        progress.startedAt,
        nowIso(),
        progress.activeMs,
        progress.maxScrollDepth,
        progress.bottomDwellMs
      );

      const totals = this.db.prepare(`
        SELECT
          COALESCE(SUM(active_ms), 0) AS active_ms,
          COALESCE(MAX(max_scroll_depth), 0) AS max_scroll_depth,
          COALESCE(SUM(bottom_dwell_ms), 0) AS bottom_dwell_ms,
          MAX(completed_at) AS completed_at
        FROM reading_sessions
        WHERE article_url = ?
      `).get(canonicalUrl);
      const qualifies =
        Number(totals.active_ms) >= READ_THRESHOLDS.activeMs &&
        Number(totals.max_scroll_depth) >= READ_THRESHOLDS.scrollDepth &&
        Number(totals.bottom_dwell_ms) >= READ_THRESHOLDS.bottomDwellMs;
      const existing = this.db.prepare("SELECT id, knowledge_status FROM articles WHERE canonical_url = ?").get(canonicalUrl);

      let articleId = existing?.id || null;
      let newlyCompleted = false;
      let analysisQueued = false;
      if (qualifies && !existing) {
        articleId = this.captureArticle({
          canonicalUrl,
          cachedItem,
          progress,
          totals
        });
        newlyCompleted = true;
        analysisQueued = Boolean(cachedItem?.readerArticle?.textContent && cachedItem?.readerArticle?.content);
      } else if (qualifies && existing) {
        this.db.prepare(`
          UPDATE articles
          SET active_reading_ms = MAX(active_reading_ms, ?),
              max_scroll_depth = MAX(max_scroll_depth, ?),
              updated_at = ?
          WHERE id = ?
        `).run(Number(totals.active_ms), Number(totals.max_scroll_depth), nowIso(), existing.id);
        if (existing.knowledge_status === "content_missing") {
          analysisQueued = this.restoreMissingContent(existing.id, cachedItem);
        }
      }

      if (qualifies) {
        const completedAt = totals.completed_at || nowIso();
        this.db.prepare(`
          UPDATE reading_sessions
          SET completed_at = COALESCE(completed_at, ?)
          WHERE article_url = ?
        `).run(completedAt, canonicalUrl);
      }

      const article = articleId
        ? this.db.prepare("SELECT knowledge_status FROM articles WHERE id = ?").get(articleId)
        : null;
      return {
        articleId,
        completed: qualifies,
        newlyCompleted,
        analysisQueued,
        activeMs: Number(totals.active_ms),
        maxScrollDepth: Number(totals.max_scroll_depth),
        bottomDwellMs: Number(totals.bottom_dwell_ms),
        knowledgeStatus: article?.knowledge_status || null,
        thresholds: READ_THRESHOLDS
      };
    });
  }

  captureArticle({ canonicalUrl, cachedItem, progress, totals }) {
    const site = cachedItem?.site || {};
    const article = cachedItem?.article || {};
    const readerArticle = cachedItem?.readerArticle || {};
    const contentText = cleanText(readerArticle.textContent || "");
    const contentHtml = String(readerArticle.content || "");
    const completedAt = nowIso();
    const hasContent = Boolean(contentText && contentHtml);
    const result = this.db.prepare(`
      INSERT INTO articles(
        canonical_url, original_url, site_id, site_title, site_domain, title,
        author, published_at, language, excerpt, content_html, content_text,
        content_hash, active_reading_ms, max_scroll_depth, knowledge_status,
        completed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      canonicalUrl,
      article.url || progress.articleUrl,
      site.id || progress.siteId || null,
      site.title || progress.siteTitle || null,
      site.domain || progress.siteDomain || safeHost(canonicalUrl),
      readerArticle.title || article.title || progress.articleTitle || canonicalUrl,
      readerArticle.byline || null,
      readerArticle.publishedAt || article.publishedAt || null,
      detectLanguage(contentText),
      readerArticle.excerpt || null,
      contentHtml || null,
      contentText || null,
      contentText ? hashText(contentText) : null,
      Number(totals.active_ms),
      Number(totals.max_scroll_depth),
      hasContent ? "pending_analysis" : "content_missing",
      completedAt,
      completedAt,
      completedAt
    );
    const articleId = Number(result.lastInsertRowid);
    if (hasContent) this.enqueueAnalysis(articleId);
    return articleId;
  }

  restoreMissingContent(articleId, cachedItem) {
    const readerArticle = cachedItem?.readerArticle || {};
    const contentText = cleanText(readerArticle.textContent || "");
    const contentHtml = String(readerArticle.content || "");
    if (!contentText || !contentHtml) return false;
    const article = cachedItem?.article || {};
    const timestamp = nowIso();
    this.db.prepare(`
      UPDATE articles
      SET title = COALESCE(NULLIF(?, ''), title),
          author = COALESCE(NULLIF(?, ''), author),
          published_at = COALESCE(NULLIF(?, ''), published_at),
          language = ?, excerpt = ?, content_html = ?, content_text = ?,
          content_hash = ?, updated_at = ?
      WHERE id = ?
    `).run(
      readerArticle.title || article.title || "",
      readerArticle.byline || "",
      readerArticle.publishedAt || article.publishedAt || "",
      detectLanguage(contentText),
      readerArticle.excerpt || null,
      contentHtml,
      contentText,
      hashText(contentText),
      timestamp,
      articleId
    );
    this.enqueueAnalysis(articleId);
    return true;
  }

  enqueueAnalysis(articleId) {
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO analysis_jobs(article_id, status, attempts, created_at, updated_at)
      VALUES (?, 'pending', 0, ?, ?)
      ON CONFLICT(article_id) DO UPDATE SET
        status = 'pending', attempts = 0, next_attempt_at = NULL,
        last_error = NULL, updated_at = excluded.updated_at
    `).run(articleId, timestamp, timestamp);
    this.db.prepare(`
      UPDATE articles SET knowledge_status = 'pending_analysis', updated_at = ? WHERE id = ?
    `).run(timestamp, articleId);
  }

  claimNextJob() {
    return this.transaction(() => {
      const job = this.db.prepare(`
        SELECT j.*, a.title, a.content_text, a.content_hash, a.original_url,
               a.site_title, a.published_at
        FROM analysis_jobs j
        JOIN articles a ON a.id = j.article_id
        WHERE j.status IN ('pending', 'failed')
          AND j.attempts < 3
          AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= ?)
        ORDER BY j.created_at ASC
        LIMIT 1
      `).get(nowIso());
      if (!job) return null;
      this.db.prepare(`
        UPDATE analysis_jobs SET status = 'running', updated_at = ? WHERE id = ?
      `).run(nowIso(), job.id);
      return { ...job, status: "running" };
    });
  }

  completeAnalysis(jobId, analysis, metadata = {}) {
    return this.transaction(() => {
      const job = this.db.prepare("SELECT article_id FROM analysis_jobs WHERE id = ?").get(jobId);
      if (!job) throw new Error("Analysis job not found");
      const articleId = Number(job.article_id);
      const generatedAt = nowIso();
      this.db.prepare(`
        INSERT INTO summaries(
          article_id, thesis, key_points_json, evidence_json, why_it_matters,
          entities_json, model, prompt_version, source_hash, generated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(article_id) DO UPDATE SET
          thesis = excluded.thesis,
          key_points_json = excluded.key_points_json,
          evidence_json = excluded.evidence_json,
          why_it_matters = excluded.why_it_matters,
          entities_json = excluded.entities_json,
          model = excluded.model,
          prompt_version = excluded.prompt_version,
          source_hash = excluded.source_hash,
          generated_at = excluded.generated_at
      `).run(
        articleId,
        analysis.thesis,
        JSON.stringify(analysis.keyPoints),
        JSON.stringify(analysis.evidence),
        analysis.whyItMatters,
        JSON.stringify(analysis.entities),
        metadata.model || "unknown",
        metadata.promptVersion || "v1",
        metadata.sourceHash || null,
        generatedAt
      );

      const manualPrimary = this.db.prepare(`
        SELECT 1 FROM article_categories
        WHERE article_id = ? AND is_primary = 1 AND source = 'manual'
      `).get(articleId);
      if (!manualPrimary && analysis.categorySlug) {
        const category = this.db.prepare("SELECT id FROM categories WHERE slug = ?").get(analysis.categorySlug);
        if (category) {
          this.db.prepare("DELETE FROM article_categories WHERE article_id = ? AND is_primary = 1 AND source = 'ai'").run(articleId);
          this.db.prepare(`
            INSERT OR REPLACE INTO article_categories(article_id, category_id, is_primary, source, confidence)
            VALUES (?, ?, 1, 'ai', ?)
          `).run(articleId, category.id, analysis.categoryConfidence);
        }
      }

      this.db.prepare("DELETE FROM article_tags WHERE article_id = ? AND source = 'ai'").run(articleId);
      for (const tagName of analysis.tags) {
        const tagId = this.ensureTag(tagName);
        if (!tagId) continue;
        this.db.prepare(`
          INSERT OR IGNORE INTO article_tags(article_id, tag_id, source, confidence)
          VALUES (?, ?, 'ai', ?)
        `).run(articleId, tagId, analysis.tagConfidence);
      }

      this.db.prepare(`
        UPDATE articles SET knowledge_status = 'analyzed', updated_at = ? WHERE id = ?
      `).run(generatedAt, articleId);
      this.db.prepare(`
        UPDATE analysis_jobs
        SET status = 'succeeded', last_error = NULL, updated_at = ?
        WHERE id = ?
      `).run(generatedAt, jobId);
      return articleId;
    });
  }

  failJob(jobId, error, retryAfterMs = 30_000) {
    const job = this.db.prepare("SELECT attempts, article_id FROM analysis_jobs WHERE id = ?").get(jobId);
    if (!job) return;
    const attempts = Number(job.attempts) + 1;
    const terminal = attempts >= 3;
    const timestamp = nowIso();
    this.db.prepare(`
      UPDATE analysis_jobs
      SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
      WHERE id = ?
    `).run(
      terminal ? "failed" : "pending",
      attempts,
      terminal ? null : new Date(Date.now() + retryAfterMs).toISOString(),
      truncate(String(error?.message || error || "analysis failed"), 1000),
      timestamp,
      jobId
    );
    this.db.prepare(`
      UPDATE articles SET knowledge_status = ?, updated_at = ? WHERE id = ?
    `).run(terminal ? "analysis_failed" : "pending_analysis", timestamp, job.article_id);
  }

  retryArticle(articleId) {
    const article = this.db.prepare("SELECT id, content_text FROM articles WHERE id = ?").get(articleId);
    if (!article) throw new Error("Knowledge article not found");
    if (!article.content_text) throw new Error("Article content is unavailable");
    this.enqueueAnalysis(Number(article.id));
    return true;
  }

  listArticles(filters = {}) {
    const query = cleanText(filters.query || "").toLowerCase();
    const like = `%${query}%`;
    const category = cleanText(filters.category || "");
    const status = cleanText(filters.status || "");
    const limit = clampInteger(filters.limit, 1, 100, 50);
    const offset = clampInteger(filters.offset, 0, 100_000, 0);
    const rows = this.db.prepare(`
      SELECT
        a.id, a.title, a.original_url AS originalUrl, a.site_title AS siteTitle,
        a.site_domain AS siteDomain, a.completed_at AS completedAt,
        a.active_reading_ms AS activeReadingMs, a.max_scroll_depth AS maxScrollDepth,
        a.knowledge_status AS knowledgeStatus,
        s.thesis,
        c.slug AS categorySlug, c.name AS categoryName,
        GROUP_CONCAT(DISTINCT t.name) AS tagNames
      FROM articles a
      LEFT JOIN summaries s ON s.article_id = a.id
      LEFT JOIN article_categories ac ON ac.article_id = a.id AND ac.is_primary = 1
      LEFT JOIN categories c ON c.id = ac.category_id
      LEFT JOIN article_tags at ON at.article_id = a.id
      LEFT JOIN tags t ON t.id = at.tag_id
      WHERE (
        ? = '' OR LOWER(a.title) LIKE ? OR LOWER(COALESCE(a.content_text, '')) LIKE ?
        OR LOWER(COALESCE(s.thesis, '')) LIKE ?
        OR LOWER(COALESCE(s.key_points_json, '')) LIKE ?
        OR LOWER(COALESCE(s.evidence_json, '')) LIKE ?
        OR LOWER(COALESCE(s.why_it_matters, '')) LIKE ?
        OR LOWER(COALESCE(s.entities_json, '')) LIKE ?
        OR EXISTS (
          SELECT 1 FROM article_tags sat
          JOIN tags st ON st.id = sat.tag_id
          WHERE sat.article_id = a.id AND LOWER(st.name) LIKE ?
        )
      )
      AND (? = '' OR c.slug = ?)
      AND (? = '' OR a.knowledge_status = ?)
      GROUP BY a.id
      ORDER BY a.completed_at DESC
      LIMIT ? OFFSET ?
    `).all(query, like, like, like, like, like, like, like, like, category, category, status, status, limit, offset);
    return rows.map((row) => ({
      ...row,
      tags: splitTags(row.tagNames),
      tagNames: undefined
    }));
  }

  getArticle(articleId) {
    const row = this.db.prepare(`
      SELECT
        a.*, s.thesis, s.key_points_json, s.evidence_json, s.why_it_matters,
        s.entities_json, s.model, s.generated_at,
        c.slug AS category_slug, c.name AS category_name,
        GROUP_CONCAT(DISTINCT t.name) AS tag_names
      FROM articles a
      LEFT JOIN summaries s ON s.article_id = a.id
      LEFT JOIN article_categories ac ON ac.article_id = a.id AND ac.is_primary = 1
      LEFT JOIN categories c ON c.id = ac.category_id
      LEFT JOIN article_tags at ON at.article_id = a.id
      LEFT JOIN tags t ON t.id = at.tag_id
      WHERE a.id = ?
      GROUP BY a.id
    `).get(articleId);
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      originalUrl: row.original_url,
      siteTitle: row.site_title,
      siteDomain: row.site_domain,
      author: row.author,
      publishedAt: row.published_at,
      excerpt: row.excerpt,
      contentText: row.content_text,
      activeReadingMs: row.active_reading_ms,
      maxScrollDepth: row.max_scroll_depth,
      knowledgeStatus: row.knowledge_status,
      completedAt: row.completed_at,
      thesis: row.thesis,
      keyPoints: parseJsonArray(row.key_points_json),
      evidence: parseJsonArray(row.evidence_json),
      whyItMatters: row.why_it_matters,
      entities: parseJsonArray(row.entities_json),
      model: row.model,
      generatedAt: row.generated_at,
      categorySlug: row.category_slug,
      categoryName: row.category_name,
      tags: splitTags(row.tag_names)
    };
  }

  updateMetadata(articleId, patch = {}) {
    return this.transaction(() => {
      const article = this.db.prepare("SELECT id FROM articles WHERE id = ?").get(articleId);
      if (!article) throw new Error("Knowledge article not found");
      if (patch.categorySlug !== undefined) {
        this.db.prepare("DELETE FROM article_categories WHERE article_id = ? AND is_primary = 1").run(articleId);
        const slug = cleanText(patch.categorySlug);
        if (slug) {
          const category = this.db.prepare("SELECT id FROM categories WHERE slug = ?").get(slug);
          if (!category) throw new Error("Unknown knowledge category");
          this.db.prepare(`
            INSERT INTO article_categories(article_id, category_id, is_primary, source, confidence)
            VALUES (?, ?, 1, 'manual', 1)
          `).run(articleId, category.id);
        }
      }
      if (patch.tags !== undefined) {
        this.db.prepare("DELETE FROM article_tags WHERE article_id = ?").run(articleId);
        for (const tagName of normalizeTagList(patch.tags)) {
          const tagId = this.ensureTag(tagName);
          if (tagId) {
            this.db.prepare(`
              INSERT OR IGNORE INTO article_tags(article_id, tag_id, source, confidence)
              VALUES (?, ?, 'manual', 1)
            `).run(articleId, tagId);
          }
        }
      }
      this.db.prepare("UPDATE articles SET updated_at = ? WHERE id = ?").run(nowIso(), articleId);
      return this.getArticle(articleId);
    });
  }

  listCategories() {
    return this.db.prepare("SELECT slug, name FROM categories ORDER BY sort_order, name").all();
  }

  getStats() {
    const totals = this.db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN knowledge_status = 'analyzed' THEN 1 ELSE 0 END) AS analyzed,
             SUM(CASE WHEN knowledge_status IN ('pending_analysis', 'analysis_failed') THEN 1 ELSE 0 END) AS pending
      FROM articles
    `).get();
    return {
      total: Number(totals.total || 0),
      analyzed: Number(totals.analyzed || 0),
      pending: Number(totals.pending || 0)
    };
  }

  ensureTag(name) {
    const normalized = truncate(cleanText(name), 80);
    if (!normalized) return null;
    this.db.prepare("INSERT OR IGNORE INTO tags(name) VALUES (?)").run(normalized);
    return this.db.prepare("SELECT id FROM tags WHERE name = ?").get(normalized)?.id || null;
  }

  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    if (this.db?.isOpen !== false) {
      try {
        this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch {
        // Shutdown should proceed even when checkpointing is unavailable.
      }
      this.db.close();
    }
  }
}

function normalizeProgress(payload) {
  const articleUrl = normalizeUrl(payload.articleUrl);
  const sessionId = String(payload.sessionId || "").trim();
  if (!sessionId || sessionId.length > 128) throw new Error("A valid reading session ID is required");
  return {
    sessionId,
    articleUrl,
    articleTitle: truncate(cleanText(payload.articleTitle || articleUrl), 500),
    siteId: truncate(cleanText(payload.siteId || ""), 200),
    siteTitle: truncate(cleanText(payload.siteTitle || ""), 300),
    siteDomain: truncate(cleanText(payload.siteDomain || ""), 200),
    startedAt: validDate(payload.startedAt) || nowIso(),
    activeMs: clampInteger(payload.activeMs, 0, 24 * 60 * 60 * 1000, 0),
    maxScrollDepth: clampNumber(payload.maxScrollDepth, 0, 1, 0),
    bottomDwellMs: clampInteger(payload.bottomDwellMs, 0, 60 * 60 * 1000, 0)
  };
}

function normalizeUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (!["http:", "https:"].includes(url.protocol)) return "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return "";
  }
}

function normalizeTagList(tags) {
  const values = Array.isArray(tags) ? tags : String(tags || "").split(/[,，]/);
  return [...new Set(values.map((value) => truncate(cleanText(value), 80)).filter(Boolean))].slice(0, 12);
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function splitTags(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function detectLanguage(text) {
  if (!text) return null;
  const chinese = (text.match(/[\u3400-\u9fff]/g) || []).length;
  return chinese / Math.max(text.length, 1) > 0.15 ? "zh" : "en";
}

function hashText(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function validDate(value) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function safeHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function clampInteger(value, min, max, fallback) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function truncate(value, maxLength) {
  return String(value || "").slice(0, maxLength);
}

function nowIso() {
  return new Date().toISOString();
}

module.exports = {
  KnowledgeDatabase,
  DEFAULT_CATEGORIES,
  READ_THRESHOLDS,
  normalizeUrl,
  normalizeProgress
};
