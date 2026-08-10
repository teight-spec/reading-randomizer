(() => {
  const state = {
    configured: false,
    categories: [],
    selectedId: null,
    searchTimer: null,
    options: null
  };

  const ui = {
    configure(options = {}) {
      state.options = options;
      this.elements = {
        view: document.querySelector("#knowledgeView"),
        reader: document.querySelector("#readerModeView"),
        button: document.querySelector("#knowledgeButton"),
        closeButton: document.querySelector("#closeKnowledgeButton"),
        search: document.querySelector("#knowledgeSearchInput"),
        category: document.querySelector("#knowledgeCategoryFilter"),
        status: document.querySelector("#knowledgeStatusFilter"),
        stats: document.querySelector("#knowledgeStats"),
        list: document.querySelector("#knowledgeList"),
        detail: document.querySelector("#knowledgeDetail")
      };
      if (state.configured) return;
      state.configured = true;
      this.elements.closeButton.addEventListener("click", () => this.close());
      this.elements.search.addEventListener("input", () => {
        clearTimeout(state.searchTimer);
        state.searchTimer = setTimeout(() => this.run(() => this.refresh()), 220);
      });
      this.elements.category.addEventListener("change", () => this.run(() => this.refresh()));
      this.elements.status.addEventListener("change", () => this.run(() => this.refresh()));
      this.elements.list.addEventListener("click", (event) => {
        const row = event.target.closest("[data-knowledge-id]");
        if (row) this.run(() => this.select(Number(row.dataset.knowledgeId)));
      });
      this.elements.detail.addEventListener("submit", (event) => {
        event.preventDefault();
        this.run(() => this.saveMetadata(event));
      });
      this.elements.detail.addEventListener("click", (event) => {
        this.run(() => this.handleDetailClick(event));
      });
    },

    isOpen() {
      return Boolean(this.elements && !this.elements.view.classList.contains("hidden"));
    },

    async open() {
      state.options?.onOpen?.();
      this.elements.reader.classList.add("hidden");
      this.elements.view.classList.remove("hidden");
      this.elements.button.classList.add("active");
      await this.loadCategories();
      await this.refresh();
    },

    close() {
      this.elements.view.classList.add("hidden");
      this.elements.reader.classList.remove("hidden");
      this.elements.button.classList.remove("active");
      state.options?.onClose?.();
    },

    async loadCategories() {
      if (state.categories.length) return;
      state.categories = await window.readerApi.listKnowledgeCategories();
      this.elements.category.innerHTML = [
        '<option value="">全部分类</option>',
        ...state.categories.map((category) => `<option value="${escapeHtml(category.slug)}">${escapeHtml(category.name)}</option>`)
      ].join("");
    },

    async refresh() {
      const [articles, stats] = await Promise.all([
        window.readerApi.listKnowledge({
          query: this.elements.search.value,
          category: this.elements.category.value,
          status: this.elements.status.value,
          limit: 100
        }),
        window.readerApi.getKnowledgeStats()
      ]);
      this.elements.stats.textContent = `已收录 ${stats.total} 篇 · 已分析 ${stats.analyzed} 篇 · 待分析 ${stats.pending} 篇`;
      this.elements.list.innerHTML = articles.length
        ? articles.map((article) => renderListItem(article, article.id === state.selectedId)).join("")
        : '<div class="knowledge-empty"><strong>没有匹配的文章</strong><span>完成阅读的文章会自动收录到这里。</span></div>';
      if (state.selectedId && articles.some((article) => article.id === state.selectedId)) {
        await this.select(state.selectedId, false);
      } else if (articles[0]) {
        await this.select(articles[0].id, false);
      } else {
        state.selectedId = null;
        this.renderEmptyDetail();
      }
    },

    async select(articleId, rerenderList = true) {
      state.selectedId = articleId;
      const article = await window.readerApi.getKnowledgeArticle(articleId);
      if (!article) return;
      if (rerenderList) {
        this.elements.list.querySelectorAll("[data-knowledge-id]").forEach((row) => {
          row.classList.toggle("active", Number(row.dataset.knowledgeId) === articleId);
        });
      }
      this.elements.detail.innerHTML = renderDetail(article, state.categories);
    },

    async saveMetadata(event) {
      if (event.target.id !== "knowledgeMetadataForm") return;
      const form = new FormData(event.target);
      await window.readerApi.updateKnowledgeArticle(state.selectedId, {
        categorySlug: form.get("categorySlug"),
        tags: String(form.get("tags") || "").split(/[,，]/)
      });
      state.options?.setStatus?.("分类和标签已保存。");
      await this.refresh();
    },

    async handleDetailClick(event) {
      const button = event.target.closest("button");
      if (!button) return;
      if (button.dataset.knowledgeAction === "retry") {
        await window.readerApi.retryKnowledgeAnalysis(state.selectedId);
        state.options?.setStatus?.("已重新加入 AI 分析队列。");
        await this.refresh();
      }
      if (button.dataset.knowledgeAction === "open") {
        const article = await window.readerApi.getKnowledgeArticle(state.selectedId);
        if (article?.originalUrl) await window.readerApi.openExternalArticle(article.originalUrl);
      }
    },

    renderEmptyDetail() {
      this.elements.detail.innerHTML = `
        <div class="knowledge-empty">
          <strong>完成的阅读会出现在这里。</strong>
          <span>在阅读模式中有效阅读三分钟，并读到文章末尾即可收录。</span>
        </div>
      `;
    },

    async run(task) {
      try {
        return await task();
      } catch (error) {
        state.options?.setStatus?.(`知识库操作失败：${error.message}`);
        window.readerRuntimeReporter?.report?.("knowledge_ui_failed", error, {}, () => ({}));
        return null;
      }
    }
  };

  function renderListItem(article, active) {
    return `
      <button class="knowledge-row ${active ? "active" : ""}" data-knowledge-id="${article.id}">
        <span class="knowledge-row-top">
          <strong>${escapeHtml(article.title)}</strong>
          <em>${escapeHtml(statusLabel(article.knowledgeStatus))}</em>
        </span>
        <span class="knowledge-row-meta">${escapeHtml(article.categoryName || "未分类")} · ${escapeHtml(article.siteTitle || article.siteDomain || "未知来源")}</span>
        ${article.thesis ? `<span class="knowledge-row-summary">${escapeHtml(article.thesis)}</span>` : ""}
        ${article.tags.length ? `<span class="knowledge-tag-line">${article.tags.map((tag) => `<i>${escapeHtml(tag)}</i>`).join("")}</span>` : ""}
      </button>
    `;
  }

  function renderDetail(article, categories) {
    const canRetry = article.knowledgeStatus === "analysis_failed";
    return `
      <header class="knowledge-detail-head">
        <span class="eyebrow">${escapeHtml(article.siteTitle || article.siteDomain || "阅读记录")}</span>
        <h2>${escapeHtml(article.title)}</h2>
        <div class="knowledge-detail-meta">
          <span>${formatDate(article.completedAt)}</span>
          <span>${formatDuration(article.activeReadingMs)}</span>
          <span>阅读深度 ${Math.round(Number(article.maxScrollDepth || 0) * 100)}%</span>
        </div>
        <div class="button-row">
          <button class="ghost" data-knowledge-action="open">查看原文</button>
          ${canRetry ? '<button class="ghost" data-knowledge-action="retry">重新分析</button>' : ""}
        </div>
      </header>
      ${article.thesis ? `
        <section class="knowledge-summary-card">
          <span class="eyebrow">核心主旨</span>
          <p class="knowledge-thesis">${escapeHtml(article.thesis)}</p>
        </section>
        <section class="knowledge-detail-section">
          <h3>核心观点</h3>
          <ul>${article.keyPoints.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
        </section>
        ${article.evidence.length ? `<section class="knowledge-detail-section"><h3>关键事实与论据</h3><ul>${article.evidence.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></section>` : ""}
        <section class="knowledge-detail-section">
          <h3>为什么值得记住</h3>
          <p>${escapeHtml(article.whyItMatters)}</p>
        </section>
        ${article.entities.length ? `<section class="knowledge-detail-section"><h3>涉及对象</h3><p>${article.entities.map(escapeHtml).join(" · ")}</p></section>` : ""}
      ` : `<div class="analysis-pending"><strong>${escapeHtml(statusLabel(article.knowledgeStatus))}</strong><span>文章原文已经保存，AI 摘要会在后台生成。</span></div>`}
      <form id="knowledgeMetadataForm" class="knowledge-metadata-form">
        <label>分类
          <select name="categorySlug">
            <option value="">未分类</option>
            ${categories.map((category) => `<option value="${escapeHtml(category.slug)}" ${category.slug === article.categorySlug ? "selected" : ""}>${escapeHtml(category.name)}</option>`).join("")}
          </select>
        </label>
        <label>标签
          <input name="tags" value="${escapeHtml(article.tags.join(", "))}" placeholder="人工智能、媒体、公共政策">
        </label>
        <button type="submit">保存</button>
      </form>
      ${article.contentText ? `<details class="knowledge-source-preview"><summary>查看原文预览</summary><p>${escapeHtml(article.contentText.slice(0, 3000))}${article.contentText.length > 3000 ? "…" : ""}</p></details>` : ""}
    `;
  }

  function statusLabel(status) {
    return ({
      analyzed: "已分析",
      pending_analysis: "等待 AI 分析",
      analysis_failed: "分析失败",
      content_missing: "正文缺失"
    })[status] || status || "已收录";
  }

  function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("zh-CN");
  }

  function formatDuration(ms) {
    const minutes = Math.max(1, Math.round(Number(ms || 0) / 60_000));
    return `有效阅读 ${minutes} 分钟`;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  window.KnowledgeUI = ui;
})();
