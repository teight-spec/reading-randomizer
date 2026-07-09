const state = {
  currentSite: null,
  currentArticle: null,
  currentArticleSource: "",
  bypassUrls: [],
  readerArticle: null,
  readerFontSize: 20,
  readerWidth: 780,
  showingOriginal: false,
  translatePinned: false,
  translateRequestId: 0,
  translationState: {
    status: "idle",
    updatedAt: Date.now(),
    lastEvent: "init",
    error: null
  },
  translationCache: new Map(),
  lastSelectionKey: "",
  lastSelection: {
    text: "",
    articleId: "",
    key: "",
    capturedAt: 0
  },
  selectionTimer: null,
  toastTimer: null,
  eventsBound: false,
  drag: null
};

const elements = {
  status: document.querySelector("#status"),
  articleTitle: document.querySelector("#articleTitle"),
  siteMeta: document.querySelector("#siteMeta"),
  readerModeView: document.querySelector("#readerModeView"),
  readerArticle: document.querySelector("#readerArticle"),
  nextButton: document.querySelector("#nextButton"),
  searchInput: document.querySelector("#searchInput"),
  markReadButton: document.querySelector("#markReadButton"),
  originalButton: document.querySelector("#originalButton"),
  archiveButton: document.querySelector("#archiveButton"),
  translatePanelButton: document.querySelector("#translatePanelButton"),
  settingsPanelButton: document.querySelector("#settingsPanelButton"),
  drawer: document.querySelector("#drawer"),
  drawerTitle: document.querySelector("#drawerTitle"),
  closeDrawerButton: document.querySelector("#closeDrawerButton"),
  translatePanel: document.querySelector("#translatePanel"),
  bypassPanel: document.querySelector("#bypassPanel"),
  translationInput: document.querySelector("#translationInput"),
  translationOutput: document.querySelector("#translationOutput"),
  translateAutoButton: document.querySelector("#translateAutoButton"),
  translateZhButton: document.querySelector("#translateZhButton"),
  translateEnButton: document.querySelector("#translateEnButton"),
  addSiteForm: document.querySelector("#addSiteForm"),
  siteFolderInput: document.querySelector("#siteFolderInput"),
  siteTitleInput: document.querySelector("#siteTitleInput"),
  siteUrlInput: document.querySelector("#siteUrlInput"),
  siteFeedInput: document.querySelector("#siteFeedInput"),
  importChromeButton: document.querySelector("#importChromeButton"),
  clearCacheButton: document.querySelector("#clearCacheButton"),
  cacheUsage: document.querySelector("#cacheUsage"),
  siteTree: document.querySelector("#siteTree"),
  addBypassForm: document.querySelector("#addBypassForm"),
  bypassNameInput: document.querySelector("#bypassNameInput"),
  bypassTemplateInput: document.querySelector("#bypassTemplateInput"),
  bypassList: document.querySelector("#bypassList"),
  quickTranslate: document.querySelector("#quickTranslate"),
  quickTranslateHandle: document.querySelector("#quickTranslateHandle"),
  quickTranslateSource: document.querySelector("#quickTranslateSource"),
  quickTranslateResult: document.querySelector("#quickTranslateResult"),
  pinTranslateButton: document.querySelector("#pinTranslateButton"),
  closeQuickTranslateButton: document.querySelector("#closeQuickTranslateButton"),
  fontMinusButton: document.querySelector("#fontMinusButton"),
  fontPlusButton: document.querySelector("#fontPlusButton"),
  widthMinusButton: document.querySelector("#widthMinusButton"),
  widthPlusButton: document.querySelector("#widthPlusButton")
};

const TRANSLATION_STATES = {
  IDLE: "idle",
  SELECTION_CAPTURED: "selection_captured",
  REQUESTING: "requesting",
  SUCCESS: "success",
  FAILED: "failed",
  RATE_LIMITED: "rate_limited"
};

const SelectionService = {
  capture() {
    const snapshot = this.readLiveSelection();
    if (!snapshot) return false;
    this.remember(snapshot.text, snapshot.truncated);
    setTranslationState(TRANSLATION_STATES.SELECTION_CAPTURED, {
      event: "selection_captured",
      textLength: snapshot.text.length,
      articleId: getCurrentArticleId()
    });
    return true;
  },

  getSnapshot() {
    const liveSnapshot = this.readLiveSelection();
    if (liveSnapshot) {
      this.remember(liveSnapshot.text, liveSnapshot.truncated);
      return liveSnapshot;
    }

    const text = (state.lastSelection.text || "").trim();
    if (!text || state.lastSelection.articleId !== getCurrentArticleId()) return null;
    return {
      text,
      truncated: text.length >= 4500,
      key: state.lastSelection.key || getTranslationCacheKey(text, "auto")
    };
  },

  getTextSnapshot(text, direction = "auto") {
    const normalized = (text || "").replace(/\s+/g, " ").trim();
    if (normalized) {
      return {
        text: normalized,
        truncated: false,
        key: getTranslationCacheKey(normalized, direction)
      };
    }
    return this.getSnapshot();
  },

  readLiveSelection() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;

    const range = selection.getRangeAt(0);
    if (
      !elements.readerArticle.contains(range.commonAncestorContainer) &&
      !elements.readerArticle.contains(range.startContainer) &&
      !elements.readerArticle.contains(range.endContainer)
    ) {
      return null;
    }

    const normalized = selection.toString().replace(/\s+/g, " ").trim();
    if (!normalized) return null;
    const truncated = normalized.length > 4500;
    const text = truncated ? normalized.slice(0, 4500) : normalized;
    return {
      text,
      truncated,
      key: getTranslationCacheKey(text, "auto")
    };
  },

  remember(text, truncated = false) {
    const normalized = (text || "").replace(/\s+/g, " ").trim();
    if (!normalized) return;
    const finalText = truncated || normalized.length > 4500 ? normalized.slice(0, 4500) : normalized;
    state.lastSelection = {
      text: finalText,
      articleId: getCurrentArticleId(),
      key: getTranslationCacheKey(finalText, "auto"),
      capturedAt: Date.now()
    };
  },

  reset() {
    state.lastSelection = {
      text: "",
      articleId: getCurrentArticleId(),
      key: "",
      capturedAt: 0
    };
    setTranslationState(TRANSLATION_STATES.IDLE, {
      event: "selection_reset",
      articleId: getCurrentArticleId()
    });
  }
};

const TranslationService = {
  async translate({ text = "", direction = "auto", cacheKey = "", source = "manual" } = {}) {
    const snapshot = SelectionService.getTextSnapshot(text, direction);
    if (!snapshot?.text || snapshot.text.length < 2) {
      const message = "No selected text available.";
      setTranslationState(TRANSLATION_STATES.FAILED, {
        event: "empty_selection",
        source,
        error: message
      });
      showToast(message);
      return {
        translatedText: message,
        provider: "none",
        cached: false,
        error: "empty_selection"
      };
    }

    const key = cacheKey || snapshot.key || getTranslationCacheKey(snapshot.text, direction);
    if (state.translationCache.has(key)) {
      const result = {
        ...state.translationCache.get(key),
        cached: true
      };
      setTranslationState(TRANSLATION_STATES.SUCCESS, {
        event: "translate_request_success",
        source,
        cached: true,
        textLength: snapshot.text.length,
        provider: result.provider
      });
      return result;
    }

    const bridge = this.getBridge();
    if (!bridge) {
      const message = "Translation bridge is unavailable. Please reload the app.";
      setTranslationState(TRANSLATION_STATES.FAILED, {
        event: "ipc_missing",
        source,
        error: message
      });
      showToast(message);
      return {
        translatedText: message,
        provider: "ipc",
        cached: false,
        error: "ipc_missing"
      };
    }

    const requestId = ++state.translateRequestId;
    setTranslationState(TRANSLATION_STATES.REQUESTING, {
      event: "translate_request_start",
      source,
      direction,
      textLength: snapshot.text.length,
      requestId
    });

    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await bridge({
          text: snapshot.text,
          direction,
          articleId: getCurrentArticleId(),
          selectionKey: key
        });
        if (requestId !== state.translateRequestId) {
          return {
            ...result,
            stale: true
          };
        }

        if (result.error) {
          const rateLimited = isRateLimited(result);
          setTranslationState(rateLimited ? TRANSLATION_STATES.RATE_LIMITED : TRANSLATION_STATES.FAILED, {
            event: rateLimited ? "rate_limited" : "translate_request_failed",
            source,
            provider: result.provider,
            textLength: snapshot.text.length,
            error: result.error || result.translatedText
          });
          showToast(rateLimited ? "Translation rate limited. Please wait and retry." : "Translation failed. Please retry.");
          return result;
        }

        state.translationCache.set(key, result);
        setTranslationState(TRANSLATION_STATES.SUCCESS, {
          event: "translate_request_success",
          source,
          provider: result.provider,
          cached: false,
          textLength: snapshot.text.length,
          requestId
        });
        return result;
      } catch (error) {
        lastError = error;
        if (attempt === 0) await sleep(250);
      }
    }

    const rateLimited = isRateLimited(lastError);
    setTranslationState(rateLimited ? TRANSLATION_STATES.RATE_LIMITED : TRANSLATION_STATES.FAILED, {
      event: rateLimited ? "rate_limited" : "translate_request_failed",
      source,
      textLength: snapshot.text.length,
      error: lastError?.message || "unknown translation error"
    });
    showToast(rateLimited ? "Translation rate limited. Please wait and retry." : "Translation failed. Please retry.");
    throw lastError;
  },

  getBridge() {
    if (window.electronAPI?.translate) {
      return (payload) => window.electronAPI.translate(payload);
    }
    if (window.readerApi?.translateText) {
      return (payload) => window.readerApi.translateText(payload);
    }
    return null;
  }
};

window.readerRuntimeReporter?.install?.(getRuntimeContext);
boot().catch((error) => {
  reportRuntimeError("boot_failed", error);
  setStatus(`Startup failed: ${error.message}`);
});

async function boot() {
  bindEvents();
  await refreshSites();
  await refreshCacheUsage();
  await refreshBypassSources();
  await loadNextReading();
}

function bindEvents() {
  if (state.eventsBound) return;
  state.eventsBound = true;

  document.addEventListener("click", handleDocumentClick);
  document.addEventListener("submit", handleDocumentSubmit);
  document.addEventListener("selectionchange", handleSelectionChange);
  document.addEventListener("mousedown", handleDocumentMouseDown);
  document.addEventListener("keyup", handleReaderSelectionEvent);
  document.addEventListener("pointerup", handleReaderSelectionEvent);
  elements.searchInput.addEventListener("input", refreshSites);
  window.addEventListener("mousemove", moveTranslateDrag);
  window.addEventListener("mouseup", stopTranslateDrag);
}

function handleDocumentClick(event) {
  const target = event.target;
  const button = target.closest?.("button");
  if (!button) {
    openReaderLinkExternally(event);
    return;
  }

  if (button === elements.nextButton) runAction("reading:next", loadNextReading);
  if (button === elements.markReadButton) runAction("reading:markRead", markCurrentRead);
  if (button === elements.originalButton) runAction("article:openOriginal", openOriginal);
  if (button === elements.archiveButton) runAction("article:openArchive", openNextBypass);
  if (button === elements.translatePanelButton) openDrawer("translate");
  if (button === elements.settingsPanelButton) openDrawer("bypass");
  if (button === elements.closeDrawerButton) closeDrawer();
  if (button === elements.translateAutoButton) runAction("translation:auto", () => translate("auto"));
  if (button === elements.translateZhButton) runAction("translation:zh", () => translate("zh"));
  if (button === elements.translateEnButton) runAction("translation:en", () => translate("en"));
  if (button === elements.importChromeButton) runAction("sites:importChrome", importChromeSites);
  if (button === elements.clearCacheButton) runAction("maintenance:clearCache", clearBrowserCache);
  if (button === elements.fontMinusButton) adjustReaderFont(-1);
  if (button === elements.fontPlusButton) adjustReaderFont(1);
  if (button === elements.widthMinusButton) adjustReaderWidth(-80);
  if (button === elements.widthPlusButton) adjustReaderWidth(80);
  if (button === elements.closeQuickTranslateButton) closeQuickTranslate();
  if (button === elements.pinTranslateButton) toggleTranslatePin();

  if (button.dataset.siteAction) runAction(`site:${button.dataset.siteAction}`, () => handleSiteAction(button));
  if (button.dataset.sourceAction) runAction(`source:${button.dataset.sourceAction}`, () => handleSourceAction(button));
  if (button.dataset.bypassAction) runAction(`bypass:${button.dataset.bypassAction}`, () => handleBypassAction(button));
}

function handleDocumentSubmit(event) {
  if (event.target === elements.addSiteForm) runAction("sites:add", () => addSite(event));
  if (event.target === elements.addBypassForm) runAction("bypass:add", () => addBypassSource(event));
}

function handleDocumentMouseDown(event) {
  if (event.target === elements.quickTranslateHandle || elements.quickTranslateHandle.contains(event.target)) {
    startTranslateDrag(event);
  }
}

function handleReaderSelectionEvent(event) {
  if (elements.readerModeView.contains(event.target)) {
    if (SelectionService.capture()) scheduleSelectionTranslation();
  }
}

function handleSelectionChange() {
  if (SelectionService.capture()) scheduleSelectionTranslation();
}

async function loadNextReading() {
  setBusy(true);
  setStatus("Choosing a site and recent article...");
  renderReaderLoading();

  try {
    const result = await window.readerApi.getNextReading();
    if (!result.site || !result.article) {
      const skipped = result.skippedSites?.length ? ` Skipped ${result.skippedSites.length} sites without article URLs.` : "";
      renderEmptyLibrary(result.readerError || "No article-level URL found. Add better sources or retry.");
      setStatus(`${result.readerError || "No article-level URL found. Add better sources or retry."}${skipped}`);
      return;
    }

    state.currentSite = result.site;
    state.currentArticle = result.article;
    state.currentArticleSource = result.article.source || "";
    state.readerArticle = result.readerArticle;
    state.bypassUrls = [];
    renderCurrentReading();
    await refreshSites();
    if (result.readerArticle) {
      renderReaderArticle(result.readerArticle);
      showReader();
    } else {
      renderReaderFailure(result.readerError || "unknown error");
      showReader();
      setStatus("Article URL found, but reader extraction failed. Original remains available.");
    }
    await inspectPaywall(false);
  } catch (error) {
    setStatus(`Failed to choose reading: ${error.message}`);
  } finally {
    setBusy(false);
  }
}

function renderCurrentReading() {
  elements.articleTitle.textContent = state.currentArticle.title || state.currentArticle.url;
  elements.siteMeta.textContent = `${state.currentSite.domain} · ${state.currentArticle.source || "article"}`;
  setStatus("Ready");
}

async function markCurrentRead() {
  if (!state.currentSite || !state.currentArticle) return;
  await window.readerApi.markRead(state.currentSite, state.currentArticle);
  setStatus("Marked read.");
  await loadNextReading();
}

async function inspectPaywall(openIfPaywalled) {
  if (!state.currentArticle?.url) return;

  try {
    const result = await window.readerApi.inspectArticle(state.currentArticle.url);
    state.bypassUrls = result.bypassUrls || [];
    if (result.paywalled && openIfPaywalled) {
      openNextBypass();
      return;
    }
    if (result.paywalled) {
      setStatus("Likely paywalled. Bypass sources are ready.");
    }
  } catch (error) {
    setStatus(`Paywall check failed: ${error.message}`);
  }
}

async function openNextBypass() {
  if (!state.currentArticle?.url) return;
  if (!state.bypassUrls.length) {
    const result = await window.readerApi.inspectArticle(state.currentArticle.url);
    state.bypassUrls = result.bypassUrls || [];
  }

  const next = state.bypassUrls.shift();
  if (!next) {
    setStatus("No enabled bypass sources.");
    return;
  }

  await window.readerApi.openExternalArticle(next.url);
  setStatus(`Opened bypass externally: ${next.name}`);
}

async function openOriginal() {
  if (!state.currentArticle?.url) return;
  await window.readerApi.openExternalArticle(state.currentArticle.url);
  setStatus("Current article opened externally.");
}

async function enterReaderMode() {
  if (!state.currentArticle?.url) return;
  if (state.readerArticle) {
    renderReaderArticle(state.readerArticle);
    showReader();
    setStatus("Reader mode enabled.");
    return;
  }

  setStatus("Extracting reader mode...");

  try {
    const article = await window.readerApi.extractReaderMode(state.currentArticle.url);
    state.readerArticle = article;
    renderReaderArticle(article);
    showReader();
    setStatus("Reader mode enabled.");
  } catch (error) {
    setStatus(`Reader mode failed: ${error.message}`);
  }
}

function renderReaderArticle(article) {
  state.lastSelectionKey = "";
  SelectionService.reset();
  if (!state.translatePinned) closeQuickTranslate();
  elements.readerArticle.innerHTML = `
    <h1>${escapeHtml(article.title)}</h1>
    <div class="reader-meta">
      ${article.byline ? `<span>${escapeHtml(article.byline)}</span>` : ""}
      ${article.publishedAt ? `<span>${new Date(article.publishedAt).toLocaleDateString()}</span>` : ""}
      <span>${escapeHtml(new URL(article.url).hostname.replace(/^www\\./, ""))}</span>
    </div>
    ${article.content}
  `;
  decorateReaderLinks();
  applyReaderSettings();
}

function decorateReaderLinks() {
  elements.readerArticle.querySelectorAll("a[href]").forEach((link) => {
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noreferrer noopener");
  });
}

async function openReaderLinkExternally(event) {
  const link = event.target.closest?.("a[href]");
  if (!link || !elements.readerArticle.contains(link)) return;
  event.preventDefault();
  const href = link.href;
  if (!href) return;
  await runAction("article:openReaderLink", async () => {
    await window.readerApi.openExternalArticle(href);
    setStatus("Link opened externally.");
  });
}

function renderReaderFailure(errorMessage) {
  state.lastSelectionKey = "";
  SelectionService.reset();
  if (!state.translatePinned) closeQuickTranslate();
  elements.readerArticle.innerHTML = `
    <h1>${escapeHtml(state.currentArticle.title || "Article")}</h1>
    <div class="reader-meta">
      <span>${escapeHtml(new URL(state.currentArticle.url).hostname.replace(/^www\\./, ""))}</span>
    </div>
    <p>Reader mode could not extract this article.</p>
    <p>${escapeHtml(errorMessage)}</p>
    <p>Use <strong>Open Article</strong> only if you want to load the full page.</p>
  `;
}

function showReader() {
  state.showingOriginal = false;
  elements.readerModeView.classList.remove("hidden");
}

function adjustReaderFont(delta) {
  state.readerFontSize = clamp(state.readerFontSize + delta, 16, 28);
  applyReaderSettings();
}

function adjustReaderWidth(delta) {
  state.readerWidth = clamp(state.readerWidth + delta, 560, 1040);
  applyReaderSettings();
}

function applyReaderSettings() {
  document.documentElement.style.setProperty("--reader-font-size", `${state.readerFontSize}px`);
  document.documentElement.style.setProperty("--reader-width", `${state.readerWidth}px`);
}

function openDrawer(panelName) {
  elements.drawer.classList.remove("hidden");
  elements.translatePanel.classList.toggle("hidden", panelName !== "translate");
  elements.bypassPanel.classList.toggle("hidden", panelName !== "bypass");

  const titleMap = {
    translate: "Translation",
    bypass: "Mirror sources"
  };
  elements.drawerTitle.textContent = titleMap[panelName];

  if (panelName === "bypass") refreshBypassSources();
  if (panelName === "translate") fillSelectedText();
}

function closeDrawer() {
  elements.drawer.classList.add("hidden");
}

async function translate(direction) {
  const text = (elements.translationInput.value.trim() || state.lastSelection.text || "").trim();
  elements.translationOutput.textContent = "Translating...";
  try {
    const result = await TranslationService.translate({ text, direction, source: "drawer" });
    elements.translationOutput.textContent = result.error
      ? "Translation is temporarily unavailable. Please retry."
      : result.translatedText;
  } catch (error) {
    elements.translationOutput.textContent = "Translation is temporarily unavailable. Please retry.";
    showToast(error.message);
  }
}

function scheduleSelectionTranslation() {
  clearTimeout(state.selectionTimer);
  state.selectionTimer = setTimeout(handleSelectionTranslation, 280);
}

async function handleSelectionTranslation() {
  const snapshot = SelectionService.getSnapshot();
  if (!snapshot || snapshot.text.length < 2) {
    logTranslationEvent("empty_selection", {
      source: "quick",
      articleId: getCurrentArticleId()
    });
    if (!state.translatePinned) closeQuickTranslate();
    return;
  }

  if (snapshot.key === state.lastSelectionKey && !elements.quickTranslate.classList.contains("hidden")) {
    return;
  }
  state.lastSelectionKey = snapshot.key;

  showQuickTranslate(snapshot.text, snapshot.truncated ? "Translating first 4500 characters..." : "Translating...");

  try {
    const result = await TranslationService.translate({
      text: snapshot.text,
      direction: "auto",
      cacheKey: snapshot.key,
      source: "quick"
    });
    if (result.stale) return;
    if (result.error) {
      elements.quickTranslateResult.textContent = "Translation is temporarily unavailable.";
      showToast(result.translatedText);
      return;
    }
    elements.quickTranslateResult.textContent = result.translatedText + (result.cached ? "\n\n(cached)" : "");
  } catch (error) {
    elements.quickTranslateResult.textContent = "Translation is temporarily unavailable.";
    showToast(error.message);
  }
}

function getTranslationCacheKey(text, direction) {
  return `${getCurrentArticleId()}:${direction}:${text}`;
}

function getCurrentArticleId() {
  return state.currentArticle?.url || state.readerArticle?.url || "no-article";
}

function showQuickTranslate(sourceText, resultText) {
  elements.quickTranslateSource.textContent = sourceText;
  elements.quickTranslateResult.textContent = resultText;
  elements.quickTranslate.classList.toggle("loading", /translating/i.test(resultText));
  elements.quickTranslate.classList.remove("hidden");
}

function closeQuickTranslate() {
  if (state.translatePinned) return;
  elements.quickTranslate.classList.add("hidden");
  state.lastSelectionKey = "";
}

function toggleTranslatePin() {
  state.translatePinned = !state.translatePinned;
  elements.quickTranslate.classList.toggle("pinned", state.translatePinned);
  elements.pinTranslateButton.textContent = state.translatePinned ? "Pinned" : "Pin";
}

function startTranslateDrag(event) {
  const rect = elements.quickTranslate.getBoundingClientRect();
  state.drag = {
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top
  };
}

function moveTranslateDrag(event) {
  if (!state.drag) return;
  const left = clamp(event.clientX - state.drag.offsetX, 8, window.innerWidth - elements.quickTranslate.offsetWidth - 8);
  const top = clamp(event.clientY - state.drag.offsetY, 56, window.innerHeight - elements.quickTranslate.offsetHeight - 8);
  elements.quickTranslate.style.left = `${left}px`;
  elements.quickTranslate.style.top = `${top}px`;
  elements.quickTranslate.style.right = "auto";
  elements.quickTranslate.style.bottom = "auto";
}

function stopTranslateDrag() {
  state.drag = null;
}

async function fillSelectedText() {
  const snapshot = SelectionService.getSnapshot();
  if (snapshot?.text) {
    elements.translationInput.value = snapshot.text;
    return;
  }

}

async function refreshSites() {
  try {
    const tree = await window.readerApi.getSiteTree();
    const query = elements.searchInput.value.trim().toLowerCase();
    const filteredTree = query
      ? tree
          .map((folder) => ({
            ...folder,
            sites: folder.sites.filter((site) =>
              `${folder.name} ${site.title} ${site.url}`.toLowerCase().includes(query)
            )
          }))
          .filter((folder) => folder.sites.length)
      : tree;
    elements.siteTree.innerHTML = filteredTree
      .map((folder, index) => renderFolder(folder, index))
      .join("") || renderEmptySiteTree(query);
    syncSidebarToCurrentSite();
  } catch (error) {
    setStatus(`Failed to load sites: ${error.message}`);
  }
}

function renderReaderLoading() {
  elements.readerArticle.innerHTML = `
    <div class="article-skeleton">
      <div class="skeleton title"></div>
      <div class="skeleton meta"></div>
      <div class="skeleton line"></div>
      <div class="skeleton line wide"></div>
      <div class="skeleton line"></div>
      <div class="skeleton image"></div>
      <div class="skeleton line wide"></div>
      <div class="skeleton line"></div>
    </div>
  `;
}

function renderEmptyLibrary(message) {
  state.currentSite = null;
  state.currentArticle = null;
  state.readerArticle = null;
  elements.articleTitle.textContent = "Reading Randomizer";
  elements.siteMeta.textContent = "Add a website or import bookmark folders";
  elements.readerArticle.innerHTML = `
    <div class="empty-state">
      <h1>Your library is ready for sources.</h1>
      <p>${escapeHtml(message)}</p>
      <p>Use <strong>Import Bookmark Folders</strong> for a one-time Chrome bookmark import, or <strong>Add One Website</strong> for a single source.</p>
    </div>
  `;
}

function renderEmptySiteTree(query) {
  return `
    <div class="empty-site-tree">
      <strong>${query ? "No matching sources" : "No sources yet"}</strong>
      <span>${query ? "Try another search." : "Import bookmark folders or add one website above."}</span>
    </div>
  `;
}

function renderFolder(folder, index) {
  const hasCurrentSite = folder.sites.some((site) => site.id === state.currentSite?.id);
  const shouldOpen = hasCurrentSite || index < 3 || elements.searchInput.value.trim();
  return `
    <details class="folder ${hasCurrentSite ? "active-folder" : ""}" ${shouldOpen ? "open" : ""}>
      <summary>${escapeHtml(folder.name)} <span>${folder.sites.length}</span></summary>
      ${folder.sites.map((site) => renderSiteItem(site)).join("")}
    </details>
  `;
}

function renderSiteItem(site) {
  const isActive = site.id === state.currentSite?.id;
  const activeSource = normalizeComparableUrl(state.currentArticleSource);
  return `
    <div class="source-card ${isActive ? "active" : ""} ${site.paused ? "paused" : ""}" data-site-id="${site.id}">
      <div class="source-main">
        <button class="source-read" data-site-action="read" data-site-id="${site.id}">
          <span class="source-favicon" aria-hidden="true">${escapeHtml(faviconLabel(site.title || site.domain || site.url))}</span>
          <span>
            <strong>${escapeHtml(compactTitle(site.title))}</strong>
            <em>${escapeHtml(site.domain || hostFromUrl(site.url))}</em>
          </span>
        </button>
        <button class="source-open ghost" data-site-action="open" data-site-url="${escapeHtml(site.url)}">Open</button>
      </div>
      ${(site.articleSources || []).length ? `
        <div class="source-list">
          ${(site.articleSources || []).slice(0, isActive ? 6 : 2).map((source) => {
            const isActiveSource = activeSource && normalizeComparableUrl(source.url) === activeSource;
            return `
              <div class="source-row ${isActiveSource ? "active" : ""}">
                <span>${escapeHtml(source.title || source.type || "Source")}</span>
                <button class="ghost" data-source-action="delete" data-site-id="${site.id}" data-source-url="${escapeHtml(source.url)}">Remove</button>
              </div>
            `;
          }).join("")}
        </div>
      ` : ""}
      <div class="source-tools">
        <button class="ghost" data-site-action="toggle" data-site-id="${site.id}">${site.paused ? "Resume" : "Pause"}</button>
        <button class="ghost danger" data-site-action="delete" data-site-id="${site.id}">Delete</button>
      </div>
      ${isActive ? `
        <div class="now-reading">
          <span>Now reading</span>
          <strong>${escapeHtml(state.currentArticle?.title || "Current article")}</strong>
        </div>
      ` : ""}
    </div>
  `;
}

function syncSidebarToCurrentSite() {
  if (!state.currentSite?.id) return;
  const activeCard = elements.siteTree.querySelector(`[data-site-id="${cssEscape(state.currentSite.id)}"].source-card`);
  if (!activeCard) return;

  const folder = activeCard.closest("details");
  if (folder) folder.open = true;

  window.requestAnimationFrame(() => {
    activeCard.scrollIntoView({
      block: "center",
      behavior: "smooth"
    });
  });
}

function normalizeComparableUrl(url = "") {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function compactTitle(title = "") {
  return title
    .replace(/\s*\|\s*.*$/u, "")
    .replace(/\s*-\s*(Homepage|Home|Latest).*$/iu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function hostFromUrl(url = "") {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function faviconLabel(text = "") {
  return (String(text).trim()[0] || "?").toUpperCase();
}

function cssEscape(value) {
  if (window.CSS?.escape) return window.CSS.escape(value);
  return String(value).replace(/["\\]/g, "\\$&");
}

async function handleSiteAction(button) {
  const siteId = button.dataset.siteId;
  const action = button.dataset.siteAction;
  if (action === "read") {
    await loadSiteReading(siteId);
  }
  if (action === "open") {
    await window.readerApi.openExternalArticle(button.dataset.siteUrl);
  }
  if (action === "toggle") {
    const site = (await window.readerApi.listSites()).find((item) => item.id === siteId);
    await window.readerApi.updateSite(siteId, { paused: !site.paused });
  }
  if (action === "delete") {
    await window.readerApi.deleteSite(siteId);
  }
  await refreshSites();
}

async function loadSiteReading(siteId) {
  setBusy(true);
  setStatus("Finding an article from this site...");
  renderReaderLoading();
  try {
    const result = await window.readerApi.readSite(siteId);
    if (!result.site || !result.article) {
      setStatus("No valid article found for this site.");
      return;
    }
    state.currentSite = result.site;
    state.currentArticle = result.article;
    state.currentArticleSource = result.article.source || "";
    state.readerArticle = result.readerArticle;
    state.bypassUrls = [];
    renderCurrentReading();
    await refreshSites();
    if (result.readerArticle) {
      renderReaderArticle(result.readerArticle);
      showReader();
    } else {
      renderReaderFailure(result.readerError || "unknown error");
      showReader();
    }
    await inspectPaywall(false);
  } finally {
    setBusy(false);
  }
}

async function handleSourceAction(button) {
  if (button.dataset.sourceAction === "delete") {
    await window.readerApi.deleteArticleSource(button.dataset.siteId, button.dataset.sourceUrl);
    await refreshSites();
  }
}

async function addSite(event) {
  event.preventDefault();
  await window.readerApi.addSite({
    folderPath: elements.siteFolderInput.value,
    title: elements.siteTitleInput.value,
    url: elements.siteUrlInput.value,
    feedUrl: elements.siteFeedInput.value
  });
  elements.siteFolderInput.value = "";
  elements.siteTitleInput.value = "";
  elements.siteUrlInput.value = "";
  elements.siteFeedInput.value = "";
  await refreshSites();
  setStatus("Website added to your library.");
}

async function importChromeSites() {
  const result = await window.readerApi.importChromeSites();
  setStatus(`Imported ${result.importedCount} sources from bookmark folders. Library total: ${result.totalSites}.`);
  await refreshSites();
}

async function refreshCacheUsage() {
  if (!window.readerApi.getCacheUsage || !elements.cacheUsage) return;
  try {
    const usage = await window.readerApi.getCacheUsage();
    elements.cacheUsage.textContent = formatBytes(usage.totalBytes);
  } catch {
    elements.cacheUsage.textContent = "Unavailable";
  }
}

async function clearBrowserCache() {
  if (!window.readerApi.clearBrowserCache) return;
  elements.clearCacheButton.disabled = true;
  try {
    const result = await window.readerApi.clearBrowserCache();
    elements.cacheUsage.textContent = formatBytes(result.after.totalBytes);
    setStatus(`Cleared browser cache. Freed ${formatBytes(result.freedBytes)}.`);
  } finally {
    elements.clearCacheButton.disabled = false;
  }
}

async function refreshBypassSources() {
  try {
    const sources = await window.readerApi.listBypassSources();
    elements.bypassList.innerHTML = sources
      .map((source) => renderBypassItem(source))
      .join("");
  } catch (error) {
    setStatus(`Failed to load bypass sources: ${error.message}`);
  }
}

function renderBypassItem(source) {
  return `
    <div class="list-item">
      <div class="list-item-title">${escapeHtml(source.priority)}. ${escapeHtml(source.name)}</div>
      <div class="list-item-meta">${escapeHtml(source.template)}<br>${source.enabled ? "enabled" : "disabled"}</div>
      <div class="button-row">
        <button class="ghost" data-bypass-action="toggle" data-source-id="${source.id}">${source.enabled ? "Disable" : "Enable"}</button>
        <button class="ghost" data-bypass-action="up" data-source-id="${source.id}">Up</button>
        <button class="ghost" data-bypass-action="down" data-source-id="${source.id}">Down</button>
        <button class="ghost" data-bypass-action="delete" data-source-id="${source.id}">Delete</button>
      </div>
    </div>
  `;
}

async function handleBypassAction(button) {
  const sourceId = button.dataset.sourceId;
  const action = button.dataset.bypassAction;
  const sources = await window.readerApi.listBypassSources();
  const source = sources.find((item) => item.id === sourceId);

  if (action === "toggle") {
    await window.readerApi.updateBypassSource(sourceId, { enabled: !source.enabled });
  }
  if (action === "up") {
    await window.readerApi.updateBypassSource(sourceId, { priority: Math.max(1, Number(source.priority) - 1.5) });
  }
  if (action === "down") {
    await window.readerApi.updateBypassSource(sourceId, { priority: Number(source.priority) + 1.5 });
  }
  if (action === "delete") {
    await window.readerApi.deleteBypassSource(sourceId);
  }
  await refreshBypassSources();
}

async function addBypassSource(event) {
  event.preventDefault();
  await window.readerApi.addBypassSource({
    name: elements.bypassNameInput.value,
    template: elements.bypassTemplateInput.value
  });
  elements.bypassNameInput.value = "";
  elements.bypassTemplateInput.value = "";
  await refreshBypassSources();
}

function setBusy(isBusy) {
  elements.nextButton.disabled = isBusy;
}

function setStatus(message) {
  elements.status.textContent = message;
}

function showToast(message) {
  setStatus(message);
  elements.status.classList.add("visible");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    elements.status.classList.remove("visible");
  }, 3600);
}

async function runAction(action, fn) {
  try {
    return await fn();
  } catch (error) {
    reportRuntimeError("renderer_action_failed", error, { action });
    showToast(`${action} failed: ${error.message}`);
    return null;
  }
}

function reportRuntimeError(event, error, metadata = {}) {
  window.readerRuntimeReporter?.report?.(event, error, metadata, getRuntimeContext);
}

function getRuntimeContext() {
  return {
    articleUrl: state.currentArticle?.url || null,
    siteId: state.currentSite?.id || null
  };
}

function setTranslationState(status, payload = {}) {
  state.translationState = {
    status,
    updatedAt: Date.now(),
    lastEvent: payload.event || status,
    error: payload.error || null
  };
  logTranslationEvent(payload.event || status, payload);
}

function logTranslationEvent(event, payload = {}) {
  const entry = {
    event,
    timestamp: Date.now(),
    state: state.translationState?.status || TRANSLATION_STATES.IDLE,
    payload
  };
  console.info("[translation]", JSON.stringify(entry));
}

function isRateLimited(value) {
  return Boolean(
    value?.rateLimited ||
      value?.status === 429 ||
      value?.error === "HTTP 429 rate limited" ||
      /HTTP 429|rate limit/i.test(value?.message || value?.translatedText || value?.error || "")
  );
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatBytes(bytes = 0) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function escapeHtml(text = "") {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
