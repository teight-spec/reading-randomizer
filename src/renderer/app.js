const state = {
  currentSite: null,
  currentArticle: null,
  currentArticleSource: "",
  bypassUrls: [],
  readerArticle: null,
  readerFontSize: 20,
  readerWidth: 720,
  libraryTree: [],
  selectedLibraryFolder: "",
  showingOriginal: false,
  translatePinned: false,
  translationConsent: false,
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
  preferenceSaveTimer: null,
  eventsBound: false,
  busy: false,
  shelf: { later: [], recent: [] },
  shelfTab: "later",
  savedLaterUrls: new Set(),
  onboarding: null,
  onboardingStep: 1,
  onboardingMode: "first-run",
  selectedFolderPaths: new Set(),
  selectedPackIds: new Set(),
  resumeOffer: null,
  resumeTimer: null,
  mirrorConfigured: false,
  failedShelfUrl: "",
  failedShelfKind: "later",
  undoReadLater: null
};

const elements = {
  status: document.querySelector("#status"),
  articleTitle: document.querySelector("#articleTitle"),
  siteMeta: document.querySelector("#siteMeta"),
  readerModeView: document.querySelector("#readerModeView"),
  readerArticle: document.querySelector("#readerArticle"),
  nextButton: document.querySelector("#nextButton"),
  saveAndNextButton: document.querySelector("#saveAndNextButton"),
  readLaterButton: document.querySelector("#readLaterButton"),
  shelfButton: document.querySelector("#shelfButton"),
  shelfBadge: document.querySelector("#shelfBadge"),
  shelfView: document.querySelector("#shelfView"),
  shelfHeading: document.querySelector("#shelfHeading"),
  shelfStats: document.querySelector("#shelfStats"),
  shelfList: document.querySelector("#shelfList"),
  closeShelfButton: document.querySelector("#closeShelfButton"),
  onboardingView: document.querySelector("#onboardingView"),
  resumePrompt: document.querySelector("#resumePrompt"),
  resumePromptText: document.querySelector("#resumePromptText"),
  todayButton: document.querySelector("#todayButton"),
  libraryButton: document.querySelector("#libraryButton"),
  libraryView: document.querySelector("#libraryView"),
  libraryStats: document.querySelector("#libraryStats"),
  libraryCategories: document.querySelector("#libraryCategories"),
  librarySectionTitle: document.querySelector("#librarySectionTitle"),
  libraryManageButton: document.querySelector("#libraryManageButton"),
  closeLibraryButton: document.querySelector("#closeLibraryButton"),
  searchInput: document.querySelector("#searchInput"),
  knowledgeButton: document.querySelector("#knowledgeButton"),
  sourceManagerButton: document.querySelector("#sourceManagerButton"),
  originalButton: document.querySelector("#originalButton"),
  archiveButton: document.querySelector("#archiveButton"),
  settingsPanelButton: document.querySelector("#settingsPanelButton"),
  aiSettingsButton: document.querySelector("#aiSettingsButton"),
  drawer: document.querySelector("#drawer"),
  drawerTitle: document.querySelector("#drawerTitle"),
  closeDrawerButton: document.querySelector("#closeDrawerButton"),
  bypassPanel: document.querySelector("#bypassPanel"),
  sourcePanel: document.querySelector("#sourcePanel"),
  aiSettingsPanel: document.querySelector("#aiSettingsPanel"),
  aiSettingsStatus: document.querySelector("#aiSettingsStatus"),
  groqSettingsForm: document.querySelector("#groqSettingsForm"),
  groqApiKeyInput: document.querySelector("#groqApiKeyInput"),
  clearGroqApiKeyButton: document.querySelector("#clearGroqApiKeyButton"),
  translationConsentInput: document.querySelector("#translationConsentInput"),
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
  widthPlusButton: document.querySelector("#widthPlusButton"),
  readingProgress: document.querySelector("#readingProgress"),
  readingProgressBar: document.querySelector("#readingProgressBar"),
  issueNumber: document.querySelector("#issueNumber"),
  onboardingStartButton: document.querySelector("#onboardingStartButton"),
  onboardingSkipButton: document.querySelector("#onboardingSkipButton"),
  onboardingFoldersNextButton: document.querySelector("#onboardingFoldersNextButton"),
  onboardingFinishButton: document.querySelector("#onboardingFinishButton"),
  onboardingFoldersCancelButton: document.querySelector("#onboardingFoldersCancelButton"),
  onboardingFoldersEyebrow: document.querySelector("#onboardingFoldersEyebrow"),
  onboardingFoldersTitle: document.querySelector("#onboardingFoldersTitle"),
  onboardingDots: document.querySelector(".onboarding-dots"),
  onboardingStepWelcome: document.querySelector("#onboardingStepWelcome"),
  onboardingStepFolders: document.querySelector("#onboardingStepFolders"),
  onboardingStepPacks: document.querySelector("#onboardingStepPacks"),
  bookmarkFolderTree: document.querySelector("#bookmarkFolderTree"),
  bookmarkFolderHint: document.querySelector("#bookmarkFolderHint"),
  bookmarkFolderSummary: document.querySelector("#bookmarkFolderSummary"),
  sourcePackList: document.querySelector("#sourcePackList"),
  resumeContinueButton: document.querySelector("#resumeContinueButton"),
  resumeFreshButton: document.querySelector("#resumeFreshButton")
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
      const message = "请先选择需要翻译的文本。";
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
      const message = "翻译服务暂不可用，请重新打开应用。";
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
          showToast(rateLimited ? "翻译请求过于频繁，请稍后重试。" : "翻译失败，请重试。");
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
      error: lastError?.message || "未知翻译错误"
    });
    showToast(rateLimited ? "翻译请求过于频繁，请稍后重试。" : "翻译失败，请重试。");
    throw lastError;
  },

  getBridge() {
    if (window.readerApi?.translateText) {
      return (payload) => window.readerApi.translateText(payload);
    }
    return null;
  }
};

window.readerRuntimeReporter?.install?.(getRuntimeContext);
boot().catch((error) => {
  reportRuntimeError("boot_failed", error);
  setStatus(`启动失败：${error.message}`);
});

async function boot() {
  window.ReaderProgressTracker?.configure({
    scrollElement: elements.readerModeView,
    getContext: getReadingTrackerContext,
    getAnchor: () => window.ReadingAnchor?.captureFromDom?.(elements.readerModeView, elements.readerArticle) || null,
    isReaderVisible,
    onProgress: renderReadingProgress,
    onCompleted: (result) => {
      refreshIssueNumber();
      if (result?.removedFromLater) {
        showUndoToast("已读完，已移出稍后读", async () => {
          await window.readerApi.restoreReadLater(result.removedFromLater);
          await refreshShelf();
        });
      } else {
        showToast("文章已读完，并已收录到知识库。AI 分析正在排队。");
      }
      refreshShelf();
    },
    onError: (error) => reportRuntimeError("reading_progress_failed", error)
  });
  window.KnowledgeUI?.configure({
    onOpen: () => {
      elements.todayButton?.classList.remove("active");
      elements.libraryButton?.classList.remove("active");
      window.ReaderProgressTracker?.flush();
    },
    onClose: () => {
      window.ReaderProgressTracker?.recordInteraction();
    },
    setStatus: showToast
  });
  bindEvents();
  await refreshSites();
  await refreshCacheUsage();
  await refreshBypassSources();
  await refreshAiSettings();
  await refreshIssueNumber();
  await refreshShelf();
  const onboarding = await window.readerApi.getOnboardingState?.();
  if (onboarding?.show) {
    showOnboarding(onboarding, "first-run");
    return;
  }
  const offer = await window.readerApi.getResumeOffer?.();
  if (offer && window.ReadingAnchor?.isResumePromptRange?.(offer.progressPercent)) {
    showResumePrompt(offer);
    return;
  }
  await loadNextReading();
}

function bindEvents() {
  if (state.eventsBound) return;
  state.eventsBound = true;

  document.addEventListener("click", handleDocumentClick);
  document.addEventListener("submit", handleDocumentSubmit);
  document.addEventListener("change", handleDocumentChange);
  document.addEventListener("keydown", handleReadingShortcut);
  elements.resumePrompt?.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button")) return;
    armResumeTimer();
  });
  document.addEventListener("selectionchange", handleSelectionChange);
  document.addEventListener("keyup", handleReaderSelectionEvent);
  document.addEventListener("pointerup", handleReaderSelectionEvent);
  elements.searchInput.addEventListener("input", renderLibraryView);
  elements.translationConsentInput?.addEventListener("change", () => {
    runAction("privacy:translationConsent", saveTranslationConsent);
  });
}

function handleDocumentClick(event) {
  const target = event.target;
  const button = target.closest?.("button");
  if (!button) {
    openReaderLinkExternally(event);
    return;
  }

  if (button === elements.nextButton) runAction("reading:next", loadNextReading);
  if (button === elements.saveAndNextButton) runAction("reading:saveAndNext", saveCurrentAndNext);
  if (button === elements.readLaterButton) runAction("reading:saveLater", toggleReadLater);
  if (button === elements.todayButton) showReader();
  if (button === elements.libraryButton) runAction("library:open", openLibraryView);
  if (button === elements.closeLibraryButton) showReader();
  if (button === elements.libraryManageButton) openDrawer("sources");
  if (button === elements.knowledgeButton) runAction("knowledge:toggle", toggleKnowledgeView);
  if (button === elements.shelfButton) runAction("shelf:open", openShelfView);
  if (button === elements.closeShelfButton) showReader();
  if (button === elements.sourceManagerButton) openDrawer("sources");
  if (button === elements.originalButton) runAction("article:openOriginal", openOriginal);
  if (button === elements.aiSettingsButton) openDrawer("ai");
  if (button === elements.onboardingStartButton) setOnboardingStep(2);
  if (button === elements.onboardingSkipButton) runAction("onboarding:skip", skipOnboarding);
  if (button === elements.onboardingFoldersNextButton) runAction("onboarding:folders", advanceFromFolderStep);
  if (button === elements.onboardingFoldersCancelButton) showReader();
  if (button === elements.onboardingFinishButton) runAction("onboarding:finish", finishOnboarding);
  if (button === elements.resumeContinueButton) runAction("reading:resume", continueResume);
  if (button === elements.resumeFreshButton) runAction("reading:fresh", dismissResumeAndReadNew);
  if (button.id === "openMirrorButton") runAction("article:openArchive", openNextBypass);
  if (button.id === "removeFailedShelfButton") runAction("shelf:removeFailed", removeFailedShelfArticle);
  if (button.id === "backToShelfButton") runAction("shelf:back", openShelfView);
  if (button.id === "undoReadLaterButton") {
    const undo = state.undoReadLater;
    state.undoReadLater = null;
    if (undo) runAction("shelf:undo", undo);
  }
  if (button === elements.closeDrawerButton) closeDrawer();
  if (button === elements.importChromeButton) runAction("sites:importChrome", importChromeSites);
  if (button === elements.clearCacheButton) runAction("maintenance:clearCache", clearBrowserCache);
  if (button === elements.clearGroqApiKeyButton) runAction("knowledge:clearApiKey", clearGroqApiKey);
  if (button === elements.fontMinusButton) adjustReaderFont(-1);
  if (button === elements.fontPlusButton) adjustReaderFont(1);
  if (button === elements.widthMinusButton) adjustReaderWidth(-80);
  if (button === elements.widthPlusButton) adjustReaderWidth(80);
  if (button === elements.closeQuickTranslateButton) closeQuickTranslate();
  if (button === elements.pinTranslateButton) toggleTranslatePin();

  if (button.dataset.libraryFolder !== undefined) {
    state.selectedLibraryFolder = button.dataset.libraryFolder;
    renderLibraryView();
  }
  if (button.dataset.siteAction) runAction(`site:${button.dataset.siteAction}`, () => handleSiteAction(button));
  if (button.dataset.sourceAction) runAction(`source:${button.dataset.sourceAction}`, () => handleSourceAction(button));
  if (button.dataset.bypassAction) runAction(`bypass:${button.dataset.bypassAction}`, () => handleBypassAction(button));
  if (button.dataset.shelfTab) setShelfTab(button.dataset.shelfTab);
  if (button.dataset.shelfAction) runAction(`shelf:${button.dataset.shelfAction}`, () => handleShelfAction(button));
}

function handleDocumentChange(event) {
  const input = event.target;
  if (input?.dataset?.folderPath !== undefined && input.type === "checkbox") {
    if (input.checked) state.selectedFolderPaths.add(input.dataset.folderPath);
    else state.selectedFolderPaths.delete(input.dataset.folderPath);
    updateFolderSummary();
    updateFinishButton();
  }
  if (input?.dataset?.packId !== undefined && input.type === "checkbox") {
    if (input.checked) state.selectedPackIds.add(input.dataset.packId);
    else state.selectedPackIds.delete(input.dataset.packId);
    updateFinishButton();
  }
}

function isReaderVisible() {
  return window.ReadingAnchor.isReaderShortcutEnabled({
    readerVisible: !elements.readerModeView.classList.contains("hidden"),
    libraryOpen: isLibraryOpen(),
    shelfOpen: isShelfOpen(),
    onboardingOpen: isOnboardingOpen(),
    knowledgeOpen: Boolean(window.KnowledgeUI?.isOpen?.())
  });
}

function handleReadingShortcut(event) {
  if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
  const tag = event.target?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || event.target?.isContentEditable) return;
  const key = String(event.key || "").toLowerCase();
  if (key !== "s" && key !== "n") return;
  if (!isReaderVisible() || state.busy) return;
  if (key === "s") {
    if (!state.currentArticle?.url) return;
    event.preventDefault();
    runAction("reading:saveLater", toggleReadLater);
  }
  if (key === "n") {
    event.preventDefault();
    dismissResumePrompt();
    runAction("reading:next", loadNextReading);
  }
}

function handleDocumentSubmit(event) {
  if (event.target === elements.addSiteForm) runAction("sites:add", () => addSite(event));
  if (event.target === elements.addBypassForm) runAction("bypass:add", () => addBypassSource(event));
  if (event.target === elements.groqSettingsForm) runAction("knowledge:saveApiKey", () => saveGroqApiKey(event));
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
  dismissResumePrompt();
  state.resumeOffer = null;
  await window.ReaderProgressTracker?.stop();
  setBusy(true);
  setStatus("正在为你挑选一篇新文章…");
  renderReaderLoading();

  try {
    const result = await window.readerApi.getNextReading();
    if (!result.site || !result.article) {
      const skipped = result.skippedSites?.length ? ` 已跳过 ${result.skippedSites.length} 个未找到文章的来源。` : "";
      const message = localizeReadingError(result.readerError);
      renderEmptyLibrary(message);
      setStatus(`${message}${skipped}`);
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
      rememberRecentArticle();
    } else {
      renderReaderFailure(localizeReadingError(result.readerError, "阅读模式暂时无法解析这篇文章。"));
      showReader();
      setStatus("已找到文章，但阅读模式解析失败；你仍可查看原文。");
    }
    await inspectPaywall(false);
  } catch (error) {
    setStatus(`挑选文章失败：${error.message}`);
  } finally {
    setBusy(false);
  }
}

function renderCurrentReading() {
  elements.articleTitle.textContent = state.currentArticle.title || state.currentArticle.url;
  elements.siteMeta.textContent = `${state.currentSite.domain} · ${state.currentArticle.source || "文章"}`;
  setStatus("就绪");
}

async function toggleKnowledgeView() {
  if (window.KnowledgeUI?.isOpen?.()) {
    showReader();
    return;
  }
  forceCloseQuickTranslate();
  closeDrawer();
  await window.ReaderProgressTracker?.flush();
  elements.libraryView?.classList.add("hidden");
  elements.shelfView?.classList.add("hidden");
  elements.onboardingView?.classList.add("hidden");
  elements.libraryButton?.classList.remove("active");
  elements.shelfButton?.classList.remove("active");
  await window.KnowledgeUI?.open();
}

function getReadingTrackerContext() {
  if (!state.currentArticle?.url || !state.readerArticle?.content) return null;
  return {
    articleUrl: state.currentArticle.url,
    articleTitle: state.readerArticle.title || state.currentArticle.title,
    siteId: state.currentSite?.id || "",
    siteTitle: state.currentSite?.title || "",
    siteDomain: state.currentSite?.domain || ""
  };
}

function renderReadingProgress(progress) {
  if (!elements.readingProgress) return;
  if (!progress) {
    elements.readingProgress.textContent = "阅读进度 0%";
    if (elements.readingProgressBar) elements.readingProgressBar.style.width = "0%";
    elements.readingProgress.classList.remove("complete");
    elements.readingProgress.removeAttribute("title");
    return;
  }
  if (progress.completed) {
    elements.readingProgress.textContent = "已完成 · 已收录";
    if (elements.readingProgressBar) elements.readingProgressBar.style.width = "100%";
    elements.readingProgress.classList.add("complete");
    elements.readingProgress.title = "已达到有效阅读、阅读深度和文末停留要求";
    return;
  }
  const completion = window.ReaderProgressTracker?.getDisplayPercent?.(progress)
    ?? Math.round(Math.max(0, Math.min(1, Number(progress.maxScrollDepth || 0))) * 100);
  elements.readingProgress.textContent = `阅读进度 ${completion}%`;
  if (elements.readingProgressBar) elements.readingProgressBar.style.width = `${completion}%`;
  elements.readingProgress.classList.remove("complete");
  elements.readingProgress.title = [
    `有效阅读 ${formatReadingDuration(progress.activeMs)}`,
    `最深阅读 ${completion}%`,
    `文末停留 ${formatReadingDuration(progress.bottomDwellMs)}`
  ].join(" · ");
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
      renderReaderNotice("这篇文章可能有付费墙。");
      setStatus("这篇文章可能有付费墙。");
    }
  } catch (error) {
    setStatus(`付费墙检测失败：${error.message}`);
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
    setStatus("没有可用的镜像来源。");
    return;
  }

  await window.readerApi.openExternalArticle(next.url);
  setStatus(`已通过外部浏览器打开镜像：${next.name}`);
}

async function openOriginal() {
  if (!state.currentArticle?.url) return;
  await window.readerApi.openExternalArticle(state.currentArticle.url);
  setStatus("已在外部浏览器打开原文。");
}

async function enterReaderMode() {
  if (!state.currentArticle?.url) return;
  if (state.readerArticle) {
    renderReaderArticle(state.readerArticle);
    showReader();
    setStatus("已进入阅读模式。");
    return;
  }

  setStatus("正在提取阅读模式…");

  try {
    const article = await window.readerApi.extractReaderMode(state.currentArticle.url);
    state.readerArticle = article;
    renderReaderArticle(article);
    showReader();
    setStatus("已进入阅读模式。");
  } catch (error) {
    setStatus(`阅读模式解析失败：${error.message}`);
  }
}

function renderReaderArticle(article, resume = null) {
  state.lastSelectionKey = "";
  SelectionService.reset();
  if (!state.translatePinned) closeQuickTranslate();
  const hostname = new URL(article.url).hostname.replace(/^www\./, "");
  const readingMinutes = estimateReadingMinutes(article.textContent || "");
  resetReaderScroll();
  elements.readerArticle.innerHTML = `
    <div class="article-eyebrow">今日精选 · ${escapeHtml(hostname)}</div>
    <h1>${escapeHtml(article.title)}</h1>
    <div class="reader-meta">
      ${article.byline ? `<span>${escapeHtml(article.byline)}</span>` : ""}
      ${article.publishedAt ? `<span>${new Date(article.publishedAt).toLocaleDateString("zh-CN")}</span>` : ""}
      <span>${readingMinutes} 分钟</span>
    </div>
    ${article.content}
  `;
  decorateReaderLinks();
  applyReaderSettings();
  updateReadLaterButton();
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      restoreReadingPosition(resume);
      window.ReaderProgressTracker?.start();
    });
  });
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
    setStatus("已在外部浏览器打开链接。");
  });
}

function renderReaderFailure(errorMessage) {
  window.ReaderProgressTracker?.stop();
  state.lastSelectionKey = "";
  SelectionService.reset();
  if (!state.translatePinned) closeQuickTranslate();
  resetReaderScroll();
  elements.readerArticle.innerHTML = `
    <div class="article-eyebrow">今日精选</div>
    <h1>${escapeHtml(state.currentArticle.title || "文章")}</h1>
    <div class="reader-meta">
      <span>${escapeHtml(new URL(state.currentArticle.url).hostname.replace(/^www\\./, ""))}</span>
    </div>
    <p>阅读模式无法解析这篇文章。</p>
    <p>${escapeHtml(errorMessage)}</p>
    <p>你可以点击顶部的<strong>原文</strong>，在外部浏览器中继续阅读。</p>
    ${mirrorActionHtml()}
  `;
}

function renderReaderNotice(message) {
  if (!elements.readerArticle) return;
  elements.readerArticle.querySelector(".reader-notice")?.remove();
  if (!message) return;
  const notice = document.createElement("div");
  notice.className = "reader-notice";
  notice.innerHTML = `<p>${escapeHtml(message)}</p>${mirrorActionHtml()}`;
  elements.readerArticle.prepend(notice);
}

function mirrorActionHtml() {
  return state.mirrorConfigured ? `<button id="openMirrorButton" type="button">用镜像打开</button>` : "";
}

function showReader() {
  if (window.KnowledgeUI?.isOpen?.()) window.KnowledgeUI.close();
  elements.libraryView?.classList.add("hidden");
  elements.shelfView?.classList.add("hidden");
  elements.onboardingView?.classList.add("hidden");
  elements.libraryButton?.classList.remove("active");
  elements.shelfButton?.classList.remove("active");
  elements.todayButton?.classList.add("active");
  elements.knowledgeButton?.classList.remove("active");
  state.showingOriginal = false;
  elements.readerModeView.classList.remove("hidden");
  window.ReaderProgressTracker?.recordInteraction();
}

function isLibraryOpen() {
  return Boolean(elements.libraryView && !elements.libraryView.classList.contains("hidden"));
}

async function openLibraryView() {
  if (isLibraryOpen()) return;
  await window.ReaderProgressTracker?.flush();
  forceCloseQuickTranslate();
  closeDrawer();
  if (window.KnowledgeUI?.isOpen?.()) window.KnowledgeUI.close();
  elements.readerModeView.classList.add("hidden");
  elements.shelfView?.classList.add("hidden");
  elements.onboardingView?.classList.add("hidden");
  elements.libraryView.classList.remove("hidden");
  elements.todayButton?.classList.remove("active");
  elements.knowledgeButton?.classList.remove("active");
  elements.shelfButton?.classList.remove("active");
  elements.libraryButton?.classList.add("active");
  await refreshSites();
}

function adjustReaderFont(delta) {
  state.readerFontSize = clamp(state.readerFontSize + delta, 16, 28);
  applyReaderSettings();
  scheduleReaderPreferenceSave();
}

function adjustReaderWidth(delta) {
  state.readerWidth = clamp(state.readerWidth + delta, 560, 1040);
  applyReaderSettings();
  scheduleReaderPreferenceSave();
}

function applyReaderSettings() {
  document.documentElement.style.setProperty("--reader-font-size", `${state.readerFontSize}px`);
  document.documentElement.style.setProperty("--reader-width", `${state.readerWidth}px`);
}

function openDrawer(panelName) {
  elements.drawer.classList.remove("hidden");
  elements.aiSettingsPanel.classList.toggle("hidden", panelName !== "ai");
  elements.sourcePanel?.classList.toggle("hidden", panelName !== "sources");

  const titleMap = {
    ai: "隐私与 AI",
    sources: "来源管理"
  };
  elements.drawerTitle.textContent = titleMap[panelName] || "面板";

  if (panelName === "ai") refreshAiSettings();
  if (panelName === "sources") {
    refreshCacheUsage();
    refreshBypassSources();
  }
}

function closeDrawer() {
  elements.drawer.classList.add("hidden");
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

  if (!state.translationConsent) {
    showQuickTranslate(snapshot.text, "远程划词翻译尚未启用。可在“设置 → 隐私与 AI”中阅读说明并开启。");
    return;
  }

  showQuickTranslate(snapshot.text, snapshot.truncated ? "正在翻译前 4500 个字符…" : "正在翻译…");

  try {
    const result = await TranslationService.translate({
      text: snapshot.text,
      direction: "auto",
      cacheKey: snapshot.key,
      source: "quick"
    });
    if (result.stale) return;
    if (result.error) {
      elements.quickTranslateResult.textContent = "翻译服务暂时不可用。";
      showToast(result.translatedText);
      return;
    }
    elements.quickTranslateResult.textContent = result.translatedText + (result.cached ? "\n\n（来自缓存）" : "");
  } catch (error) {
    elements.quickTranslateResult.textContent = "翻译服务暂时不可用。";
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
  elements.quickTranslate.classList.toggle("loading", /翻译|translating/i.test(resultText));
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
  elements.pinTranslateButton.textContent = state.translatePinned ? "已固定" : "固定";
}

function forceCloseQuickTranslate() {
  state.translatePinned = false;
  elements.quickTranslate.classList.remove("pinned");
  elements.quickTranslate.classList.add("hidden");
  elements.pinTranslateButton.textContent = "固定";
  state.lastSelectionKey = "";
}

async function refreshSites() {
  try {
    state.libraryTree = await window.readerApi.getSiteTree();
    const selectedFolderExists = state.libraryTree.some((folder) => folder.name === state.selectedLibraryFolder);
    if (state.selectedLibraryFolder && !selectedFolderExists) state.selectedLibraryFolder = "";
    renderLibraryView();
  } catch (error) {
    setStatus(`加载来源失败：${error.message}`);
  }
}

function renderLibraryView() {
  if (!elements.siteTree || !elements.libraryCategories) return;
  const query = elements.searchInput.value.trim().toLowerCase();
  const allSites = state.libraryTree.flatMap((folder) =>
    folder.sites.map((site) => ({ ...site, folderName: folder.name }))
  );
  const selectedFolder = state.libraryTree.find((folder) => folder.name === state.selectedLibraryFolder);
  const scopedSites = selectedFolder
    ? selectedFolder.sites.map((site) => ({ ...site, folderName: selectedFolder.name }))
    : allSites;
  const visibleSites = query
    ? scopedSites.filter((site) =>
        `${site.folderName} ${site.title} ${site.domain || ""} ${site.url}`.toLowerCase().includes(query)
      )
    : scopedSites;

  elements.libraryStats.textContent = `${state.libraryTree.length} 个分类 · ${allSites.length} 个来源`;
  elements.librarySectionTitle.textContent = query
    ? `搜索结果 · ${visibleSites.length}`
    : `${state.selectedLibraryFolder || "全部来源"} · ${visibleSites.length}`;
  elements.libraryCategories.innerHTML = [
    renderLibraryCategory("", "全部来源", allSites.length),
    ...state.libraryTree.map((folder) => renderLibraryCategory(folder.name, folder.name, folder.sites.length))
  ].join("");
  elements.siteTree.innerHTML = visibleSites.length
    ? visibleSites.map((site) => renderLibrarySiteItem(site)).join("")
    : renderEmptySiteTree(query);
}

function renderReaderLoading() {
  resetReaderScroll();
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
  elements.articleTitle.textContent = "随阅";
  elements.siteMeta.textContent = "添加网站或导入书签文件夹";
  resetReaderScroll();
  elements.readerArticle.innerHTML = `
    <div class="empty-state">
      <h1>从一篇好文章开始。</h1>
      <p>${escapeHtml(message)}</p>
      <p>打开<strong>来源管理</strong>，导入 Chrome 书签文件夹，或添加一个新网站。</p>
    </div>
  `;
}

function renderEmptySiteTree(query) {
  return `
    <div class="empty-site-tree">
      <strong>${query ? "没有匹配的来源" : "还没有阅读来源"}</strong>
      <span>${query ? "换一个关键词试试。" : "可以从右上角添加网站或导入书签。"}</span>
    </div>
  `;
}

function renderLibraryCategory(folderName, label, count) {
  const isActive = folderName === state.selectedLibraryFolder;
  return `
    <button class="library-category ${isActive ? "active" : ""}" type="button" data-library-folder="${escapeHtml(folderName)}">
      <span>${escapeHtml(label)}</span>
      <em>${count}</em>
    </button>
  `;
}

function renderLibrarySiteItem(site) {
  const isActive = site.id === state.currentSite?.id;
  const activeSource = normalizeComparableUrl(state.currentArticleSource);
  const articleSources = site.articleSources || [];
  return `
    <article class="library-site-card ${isActive ? "active" : ""} ${site.paused ? "paused" : ""}" data-site-id="${escapeHtml(site.id)}">
      <button class="library-site-read" type="button" data-site-action="read" data-site-id="${escapeHtml(site.id)}">
        <span class="library-site-favicon" aria-hidden="true">${escapeHtml(faviconLabel(site.title || site.domain || site.url))}</span>
        <span class="library-site-copy">
          <span class="library-site-title-line">
            <strong>${escapeHtml(compactTitle(site.title))}</strong>
            ${isActive ? "<em>正在阅读</em>" : ""}
            ${site.paused ? "<em class=\"paused-label\">已暂停</em>" : ""}
          </span>
          <span>${escapeHtml(site.domain || hostFromUrl(site.url))}</span>
          <small>${escapeHtml(site.folderName)}</small>
        </span>
      </button>
      <div class="library-site-side">
        <span>${articleSources.length ? `${articleSources.length} 个文章入口` : "自动发现文章"}</span>
        <div class="library-site-actions">
          <button class="ghost" type="button" data-site-action="open" data-site-url="${escapeHtml(site.url)}">访问网站</button>
          <button class="ghost" type="button" data-site-action="toggle" data-site-id="${escapeHtml(site.id)}">${site.paused ? "恢复" : "暂停"}</button>
          <button class="ghost danger" type="button" data-site-action="delete" data-site-id="${escapeHtml(site.id)}">删除</button>
        </div>
      </div>
      ${articleSources.length ? `
        <details class="library-entry-details">
          <summary>查看文章入口</summary>
          <div class="library-entry-list">
          ${articleSources.map((source) => {
            const isActiveSource = activeSource && normalizeComparableUrl(source.url) === activeSource;
            return `
              <div class="library-entry-row ${isActiveSource ? "active" : ""}">
                <span>${escapeHtml(source.title || source.type || "来源")}</span>
                <button class="ghost" type="button" data-source-action="delete" data-site-id="${escapeHtml(site.id)}" data-source-url="${escapeHtml(source.url)}">移除</button>
              </div>
            `;
          }).join("")}
          </div>
        </details>
      ` : ""}
      ${isActive && state.currentArticle ? `
        <div class="library-now-reading">
          <span>当前文章</span>
          <strong>${escapeHtml(state.currentArticle.title || "当前文章")}</strong>
        </div>
      ` : ""}
    </article>
  `;
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
    if (!window.confirm("确定删除这个阅读来源吗？历史阅读和知识库文章不会被删除。")) return;
    await window.readerApi.deleteSite(siteId);
  }
  await refreshSites();
}

async function loadSiteReading(siteId) {
  await window.ReaderProgressTracker?.stop();
  setBusy(true);
  setStatus("正在从这个来源查找文章…");
  renderReaderLoading();
  try {
    const result = await window.readerApi.readSite(siteId);
    if (!result.site || !result.article) {
      setStatus("这个来源暂时没有找到可阅读的文章。");
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
      rememberRecentArticle();
    } else {
      renderReaderFailure(localizeReadingError(result.readerError, "阅读模式暂时无法解析这篇文章。"));
      showReader();
    }
    await inspectPaywall(false);
  } finally {
    setBusy(false);
  }
}

async function handleSourceAction(button) {
  if (button.dataset.sourceAction === "delete") {
    if (!window.confirm("确定移除这个文章入口吗？")) return;
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
  setStatus("网站已添加到资料库。");
}

async function importChromeSites() {
  const onboarding = await window.readerApi.getOnboardingState();
  showOnboarding(onboarding, "settings");
}

async function refreshCacheUsage() {
  if (!window.readerApi.getCacheUsage || !elements.cacheUsage) return;
  try {
    const usage = await window.readerApi.getCacheUsage();
    elements.cacheUsage.textContent = formatBytes(usage.totalBytes);
  } catch {
    elements.cacheUsage.textContent = "不可用";
  }
}

async function refreshAiSettings() {
  if (!window.readerApi.getKnowledgeSettings || !elements.aiSettingsStatus) return;
  try {
    const settings = await window.readerApi.getKnowledgeSettings();
    const sourceLabel = settings.source === "environment"
      ? "环境变量"
      : settings.source === "secure-storage"
        ? "加密本地存储"
        : "尚未配置";
    elements.aiSettingsStatus.textContent = `${settings.model} · ${sourceLabel}`;
    elements.groqApiKeyInput.placeholder = settings.configured ? "已配置 — 输入新密钥可替换" : "gsk_...";
    elements.groqApiKeyInput.disabled = !settings.secureStorageAvailable && settings.source !== "environment";
    state.translationConsent = settings.translationConsent === true;
    if (elements.translationConsentInput) elements.translationConsentInput.checked = state.translationConsent;
    if (settings.readerPreferences) {
      state.readerFontSize = clamp(Number(settings.readerPreferences.fontSize), 16, 28);
      state.readerWidth = clamp(Number(settings.readerPreferences.width), 560, 1040);
      applyReaderSettings();
    }
  } catch (error) {
    elements.aiSettingsStatus.textContent = `不可用：${error.message}`;
  }
}

async function refreshIssueNumber() {
  if (!elements.issueNumber || !window.readerApi.getKnowledgeStats) return;
  try {
    const stats = await window.readerApi.getKnowledgeStats();
    elements.issueNumber.textContent = `第 ${Math.max(1, Number(stats.total || 0) + 1)} 期`;
  } catch {
    elements.issueNumber.textContent = "今日阅读";
  }
}

function scheduleReaderPreferenceSave() {
  clearTimeout(state.preferenceSaveTimer);
  state.preferenceSaveTimer = setTimeout(() => {
    window.readerApi.saveReaderPreferences({
      fontSize: state.readerFontSize,
      width: state.readerWidth
    }).catch((error) => reportRuntimeError("reader_preferences_save_failed", error));
  }, 250);
}

async function saveTranslationConsent() {
  const enabled = Boolean(elements.translationConsentInput?.checked);
  const settings = await window.readerApi.saveTranslationConsent(enabled);
  state.translationConsent = settings.translationConsent === true;
  showToast(state.translationConsent ? "远程划词翻译已启用。" : "远程划词翻译已关闭。");
}

async function saveGroqApiKey(event) {
  event.preventDefault();
  const apiKey = elements.groqApiKeyInput.value.trim();
  if (!apiKey) throw new Error("请先输入 Groq API 密钥");
  await window.readerApi.saveGroqApiKey(apiKey);
  elements.groqApiKeyInput.value = "";
  await refreshAiSettings();
  showToast("Groq API 密钥已安全保存，等待中的分析将自动开始。");
}

async function clearGroqApiKey() {
  await window.readerApi.saveGroqApiKey("");
  elements.groqApiKeyInput.value = "";
  await refreshAiSettings();
  showToast("已清除保存的 Groq API 密钥。");
}

async function clearBrowserCache() {
  if (!window.readerApi.clearBrowserCache) return;
  elements.clearCacheButton.disabled = true;
  try {
    const result = await window.readerApi.clearBrowserCache();
    elements.cacheUsage.textContent = formatBytes(result.after.totalBytes);
    setStatus(`浏览器缓存已清理，释放 ${formatBytes(result.freedBytes)}。`);
  } finally {
    elements.clearCacheButton.disabled = false;
  }
}

async function refreshBypassSources() {
  try {
    const sources = await window.readerApi.listBypassSources();
    state.mirrorConfigured = sources.some((source) => source.enabled);
    elements.bypassList.innerHTML = sources
      .map((source) => renderBypassItem(source))
      .join("");
  } catch (error) {
    setStatus(`加载镜像来源失败：${error.message}`);
  }
}

function renderBypassItem(source) {
  return `
    <div class="list-item">
      <div class="list-item-title">${escapeHtml(source.priority)}. ${escapeHtml(source.name)}</div>
      <div class="list-item-meta">${escapeHtml(source.template)}<br>${source.enabled ? "已启用" : "已停用"}</div>
      <div class="button-row">
        <button class="ghost" data-bypass-action="toggle" data-source-id="${source.id}">${source.enabled ? "停用" : "启用"}</button>
        <button class="ghost" data-bypass-action="up" data-source-id="${source.id}">上移</button>
        <button class="ghost" data-bypass-action="down" data-source-id="${source.id}">下移</button>
        <button class="ghost" data-bypass-action="delete" data-source-id="${source.id}">删除</button>
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
    if (!window.confirm("确定删除这个镜像来源吗？")) return;
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
  state.busy = isBusy;
  elements.nextButton.disabled = isBusy;
  if (elements.saveAndNextButton) elements.saveAndNextButton.disabled = isBusy;
}

function setStatus(message) {
  elements.status.textContent = message;
  elements.status.classList.toggle("visible", Boolean(message) && message !== "就绪");
}

function showToast(message) {
  state.undoReadLater = null;
  setStatus(message);
  elements.status.classList.add("visible");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    elements.status.classList.remove("visible");
  }, 3600);
}

function showUndoToast(message, onUndo) {
  state.undoReadLater = onUndo;
  elements.status.innerHTML = `${escapeHtml(message)} <button id="undoReadLaterButton" class="ghost" type="button">撤销</button>`;
  elements.status.classList.add("visible");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    if (state.undoReadLater === onUndo) state.undoReadLater = null;
    elements.status.classList.remove("visible");
  }, 8000);
}

async function runAction(action, fn) {
  try {
    return await fn();
  } catch (error) {
    reportRuntimeError("renderer_action_failed", error, { action });
    showToast(`操作失败：${error.message}`);
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

function estimateReadingMinutes(text) {
  const normalized = String(text || "").trim();
  if (!normalized) return 1;
  const cjkCharacters = (normalized.match(/[\u3400-\u9fff]/g) || []).length;
  const latinWords = normalized.replace(/[\u3400-\u9fff]/g, " ").split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(cjkCharacters / 420 + latinWords / 220));
}

function formatReadingDuration(milliseconds = 0) {
  const totalSeconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
}

function resetReaderScroll() {
  if (!elements.readerModeView) return;
  if (window.ReaderProgressTracker?.resetScroll) {
    window.ReaderProgressTracker.resetScroll();
    return;
  }
  elements.readerModeView.scrollTop = 0;
  elements.readerModeView.scrollLeft = 0;
}

function localizeReadingError(message, fallback = "暂时没有找到可阅读的文章，请添加来源或稍后重试。") {
  const normalized = String(message || "").toLowerCase();
  if (!normalized) return fallback;
  if (normalized.includes("no reading sources")) return "还没有阅读来源，请添加网站或导入书签。";
  if (normalized.includes("no valid article") || normalized.includes("no article")) {
    return "暂时没有找到适合阅读的文章，请稍后再试。";
  }
  if (normalized.includes("timeout")) return "文章加载超时，请稍后再试。";
  return fallback;
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
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isShelfOpen() {
  return Boolean(elements.shelfView && !elements.shelfView.classList.contains("hidden"));
}

function isOnboardingOpen() {
  return Boolean(elements.onboardingView && !elements.onboardingView.classList.contains("hidden"));
}

function currentShelfPayload() {
  const anchor = window.ReadingAnchor?.captureFromDom?.(elements.readerModeView, elements.readerArticle) || null;
  return {
    articleUrl: state.currentArticle?.url || "",
    articleTitle: state.readerArticle?.title || state.currentArticle?.title || "",
    siteId: state.currentSite?.id || "",
    siteTitle: state.currentSite?.title || "",
    siteDomain: state.currentSite?.domain || "",
    progressPercent: Number(anchor?.progressPercent || 0),
    anchor
  };
}

function updateReadLaterButton() {
  if (!elements.readLaterButton) return;
  const saved = Boolean(state.currentArticle?.url && state.savedLaterUrls.has(state.currentArticle.url));
  elements.readLaterButton.textContent = saved ? "已存" : "稍后读";
  elements.readLaterButton.classList.toggle("is-saved", saved);
  elements.readLaterButton.setAttribute("aria-pressed", saved ? "true" : "false");
}

async function refreshShelf() {
  if (!window.readerApi.listShelf) return;
  const shelf = await window.readerApi.listShelf();
  state.shelf = {
    later: shelf.later || [],
    recent: shelf.recent || []
  };
  state.savedLaterUrls = new Set(state.shelf.later.map((item) => item.articleUrl));
  const count = state.shelf.later.length;
  if (elements.shelfBadge) {
    elements.shelfBadge.textContent = String(count);
    elements.shelfBadge.classList.toggle("hidden", count <= 0);
  }
  updateReadLaterButton();
  if (isShelfOpen()) renderShelf();
}

async function toggleReadLater() {
  if (!state.currentArticle?.url) return;
  const payload = currentShelfPayload();
  if (state.savedLaterUrls.has(payload.articleUrl)) {
    await window.readerApi.removeShelfItem("later", payload.articleUrl);
  } else {
    const saved = await window.readerApi.saveForLater(payload);
    if (saved?.articleUrl) state.savedLaterUrls.add(saved.articleUrl);
  }
  await refreshShelf();
}

async function saveCurrentAndNext() {
  if (state.currentArticle?.url && !state.savedLaterUrls.has(state.currentArticle.url)) {
    await window.readerApi.saveForLater(currentShelfPayload());
  }
  await loadNextReading();
}

function rememberRecentArticle() {
  if (!state.currentArticle?.url || !window.readerApi.touchRecent) return;
  window.readerApi.touchRecent(currentShelfPayload())
    .then(() => refreshShelf())
    .catch((error) => reportRuntimeError("recent_article_failed", error));
}

async function openShelfView() {
  if (isShelfOpen()) return;
  await window.ReaderProgressTracker?.flush();
  forceCloseQuickTranslate();
  closeDrawer();
  if (window.KnowledgeUI?.isOpen?.()) window.KnowledgeUI.close();
  elements.readerModeView.classList.add("hidden");
  elements.libraryView?.classList.add("hidden");
  elements.onboardingView?.classList.add("hidden");
  elements.shelfView.classList.remove("hidden");
  elements.todayButton?.classList.remove("active");
  elements.libraryButton?.classList.remove("active");
  elements.knowledgeButton?.classList.remove("active");
  elements.shelfButton?.classList.add("active");
  await refreshShelf();
}

function setShelfTab(tab) {
  state.shelfTab = tab === "recent" ? "recent" : "later";
  document.querySelectorAll("[data-shelf-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.shelfTab === state.shelfTab);
  });
  if (elements.shelfHeading) elements.shelfHeading.textContent = state.shelfTab === "recent" ? "最近阅读" : "稍后读";
  renderShelf();
}

function renderShelf() {
  if (!elements.shelfList) return;
  const items = state.shelfTab === "recent" ? state.shelf.recent : state.shelf.later;
  if (elements.shelfStats) {
    elements.shelfStats.textContent = state.shelfTab === "recent"
      ? `${items.length} 篇最近阅读`
      : `${items.length} 篇稍后读`;
  }
  if (!items.length) {
    elements.shelfList.innerHTML = state.shelfTab === "later"
      ? `<div class="empty-site-tree"><strong>读到想留着的文章，点顶部“稍后读”即可。</strong></div>`
      : `<div class="empty-site-tree"><strong>还没有最近阅读。</strong></div>`;
    return;
  }
  elements.shelfList.innerHTML = items.map((item) => `
    <article class="shelf-card">
      <button class="shelf-open" type="button" data-shelf-action="open" data-shelf-url="${escapeHtml(item.articleUrl)}">
        <strong>${escapeHtml(item.articleTitle || item.articleUrl)}</strong>
        <span>${escapeHtml(item.siteTitle || item.siteDomain || "来源未知")} · ${escapeHtml(formatShelfTime(item.updatedAt))} · ${Number(item.progressPercent) || 0}%</span>
        ${item.collected ? `<em class="shelf-collected">已收录</em>` : ""}
        ${window.ReadingAnchor.shouldShowContinueTag(item) ? `<em class="shelf-collected">继续</em>` : ""}
      </button>
      <button class="shelf-remove ghost" type="button" data-shelf-action="remove" data-shelf-url="${escapeHtml(item.articleUrl)}">移除</button>
    </article>
  `).join("");
}

async function handleShelfAction(button) {
  const url = button.dataset.shelfUrl;
  if (!url) return;
  if (button.dataset.shelfAction === "remove") {
    await window.readerApi.removeShelfItem(state.shelfTab, url);
    await refreshShelf();
    return;
  }
  await openSavedArticle(url);
}

async function openSavedArticle(url) {
  await window.ReaderProgressTracker?.stop();
  dismissResumePrompt();
  setBusy(true);
  setStatus("正在打开保存的文章…");
  try {
    const result = await window.readerApi.openSavedArticle(url);
    if (!result || result.unavailable || !result.readerArticle) {
      state.failedShelfUrl = url;
      state.failedShelfKind = state.shelfTab;
      renderUnavailableArticle();
      showReader();
      setStatus("这篇暂时打不开");
      return;
    }
    state.currentSite = result.site;
    state.currentArticle = result.article;
    state.currentArticleSource = result.article?.source || "";
    state.readerArticle = result.readerArticle;
    state.bypassUrls = [];
    renderCurrentReading();
    renderReaderArticle(result.readerArticle, result.resume);
    showReader();
    await refreshShelf();
    await inspectPaywall(false);
  } finally {
    setBusy(false);
  }
}

function renderUnavailableArticle() {
  resetReaderScroll();
  elements.articleTitle.textContent = "随阅";
  elements.siteMeta.textContent = "这篇暂时打不开";
  elements.readerArticle.innerHTML = `
    <div class="empty-state">
      <h1>这篇暂时打不开</h1>
      <p>保存的原文暂时无法解析。</p>
      <div class="onboarding-actions">
        <button id="backToShelfButton" class="ghost" type="button">返回列表</button>
        <button id="removeFailedShelfButton" type="button">移出</button>
        ${mirrorActionHtml()}
      </div>
    </div>
  `;
}

async function removeFailedShelfArticle() {
  if (!state.failedShelfUrl) return;
  await window.readerApi.removeShelfItem(state.failedShelfKind || "later", state.failedShelfUrl);
  state.failedShelfUrl = "";
  await refreshShelf();
  await openShelfView();
}

function formatShelfTime(value, now = Date.now()) {
  return window.ReadingAnchor.formatShelfTime(value, now);
}

function restoreReadingPosition(resume) {
  const anchor = resume?.anchor;
  if (!anchor || !window.ReadingAnchor?.resolveRestoreTarget) return;
  const paragraphs = [...elements.readerArticle.querySelectorAll("p")].map((element) => ({
    top: element.getBoundingClientRect().top - elements.readerModeView.getBoundingClientRect().top + elements.readerModeView.scrollTop,
    height: element.getBoundingClientRect().height,
    textLength: (element.textContent || "").length
  }));
  const target = window.ReadingAnchor.resolveRestoreTarget({
    paragraphs,
    anchor,
    scrollHeight: elements.readerModeView.scrollHeight,
    clientHeight: elements.readerModeView.clientHeight
  });
  elements.readerModeView.scrollTop = target.scrollTop;
  if (target.mode === "paragraph" && Number.isInteger(target.paragraphIndex)) {
    const paragraph = elements.readerArticle.querySelectorAll("p")[target.paragraphIndex];
    paragraph?.classList.add("reading-anchor-highlight");
    window.setTimeout(() => paragraph?.classList.remove("reading-anchor-highlight"), 1600);
  }
}

function showResumePrompt(offer) {
  state.resumeOffer = offer;
  if (!elements.resumePrompt || !elements.resumePromptText) {
    loadNextReading();
    return;
  }
  elements.resumePromptText.textContent = `上次读到《${offer.articleTitle}》的 ${offer.progressPercent}%`;
  elements.resumePrompt.classList.remove("hidden");
  elements.readerArticle.innerHTML = "";
  showReader();
  armResumeTimer();
}

function armResumeTimer() {
  clearTimeout(state.resumeTimer);
  state.resumeTimer = setTimeout(() => {
    dismissResumeAndReadNew();
  }, 8000);
}

function dismissResumePrompt() {
  clearTimeout(state.resumeTimer);
  state.resumeTimer = null;
  elements.resumePrompt?.classList.add("hidden");
}

async function continueResume() {
  const offer = state.resumeOffer;
  state.resumeOffer = null;
  dismissResumePrompt();
  if (!offer?.articleUrl) {
    await loadNextReading();
    return;
  }
  await openSavedArticle(offer.articleUrl);
}

async function dismissResumeAndReadNew() {
  state.resumeOffer = null;
  dismissResumePrompt();
  await loadNextReading();
}

function showOnboarding(onboarding, mode) {
  state.onboarding = onboarding;
  state.onboardingMode = mode;
  const saved = Array.isArray(onboarding?.selectedBookmarkFolders) ? onboarding.selectedBookmarkFolders : [];
  const defaults = window.OnboardingSelection?.defaultSelectedFolderPaths?.(onboarding?.folders || []) || [];
  state.selectedFolderPaths = new Set(saved.length ? saved : defaults);
  state.selectedPackIds = new Set();
  elements.readerModeView.classList.add("hidden");
  elements.libraryView?.classList.add("hidden");
  elements.shelfView?.classList.add("hidden");
  elements.onboardingView.classList.remove("hidden");
  elements.todayButton?.classList.add("active");
  elements.libraryButton?.classList.remove("active");
  elements.shelfButton?.classList.remove("active");
  elements.knowledgeButton?.classList.remove("active");
  renderOnboardingFolders();
  renderOnboardingPacks();
  if (elements.bookmarkFolderHint) {
    const showHint = onboarding?.chromeAvailable === false;
    elements.bookmarkFolderHint.textContent = showHint
      ? "没找到 Chrome 书签，可以直接用下一步的推荐来源。"
      : "";
    elements.bookmarkFolderHint.classList.toggle("hidden", !showHint);
  }
  const settingsMode = mode === "settings";
  elements.onboardingDots?.classList.toggle("hidden", settingsMode);
  elements.onboardingFoldersEyebrow?.classList.toggle("hidden", settingsMode);
  if (elements.onboardingFoldersTitle) {
    elements.onboardingFoldersTitle.textContent = settingsMode ? "导入书签" : "选择书签文件夹";
  }
  elements.onboardingFoldersCancelButton?.classList.toggle("hidden", !settingsMode);
  if (elements.onboardingFoldersNextButton) {
    elements.onboardingFoldersNextButton.textContent = settingsMode ? "导入所选文件夹" : "下一步";
  }
  setOnboardingStep(mode === "settings" ? 2 : 1);
  updateFinishButton();
}

function setOnboardingStep(step) {
  state.onboardingStep = step;
  elements.onboardingStepWelcome?.classList.toggle("hidden", step !== 1);
  elements.onboardingStepFolders?.classList.toggle("hidden", step !== 2);
  elements.onboardingStepPacks?.classList.toggle("hidden", step !== 3 || state.onboardingMode === "settings");
  document.querySelectorAll("[data-onboarding-dot]").forEach((dot) => {
    dot.classList.toggle("active", Number(dot.dataset.onboardingDot) === step);
  });
}

function renderOnboardingFolders() {
  if (!elements.bookmarkFolderTree) return;
  const folders = state.onboarding?.folders || [];
  elements.bookmarkFolderTree.innerHTML = folders.length
    ? renderFolderNodes(folders)
    : "";
  updateFolderSummary();
}

function renderFolderNodes(folders) {
  return (folders || []).map((folder) => `
    <div class="bookmark-folder-node">
      <label class="bookmark-folder-row">
        <input type="checkbox" data-folder-path="${escapeHtml(folder.path)}" ${state.selectedFolderPaths.has(folder.path) ? "checked" : ""}>
        <span>${escapeHtml(folder.name)}</span>
        <em>${Number(folder.urlCount) || 0}</em>
      </label>
      ${folder.children?.length ? `<div class="bookmark-folder-children">${renderFolderNodes(folder.children)}</div>` : ""}
    </div>
  `).join("");
}

function updateFolderSummary() {
  if (!elements.bookmarkFolderSummary || !window.OnboardingSelection?.summarizeFolderSelection) return;
  const summary = window.OnboardingSelection.summarizeFolderSelection(
    state.onboarding?.folders || [],
    [...state.selectedFolderPaths]
  );
  elements.bookmarkFolderSummary.textContent = window.OnboardingSelection.formatFolderSummary(summary);
}

function renderOnboardingPacks() {
  if (!elements.sourcePackList) return;
  const packs = state.onboarding?.packs || [];
  elements.sourcePackList.innerHTML = packs.map((pack) => {
    const sites = pack.sites || [];
    return `
      <label class="source-pack-card" title="${escapeHtml(sites.map((site) => site.title).join("、"))}">
        <input type="checkbox" data-pack-id="${escapeHtml(pack.id)}" ${state.selectedPackIds.has(pack.id) ? "checked" : ""}>
        <span>
          <strong>${escapeHtml(pack.title)}</strong>
          <span>${escapeHtml(pack.description || "")}</span>
          <span>共 ${sites.length} 个来源</span>
        </span>
      </label>
    `;
  }).join("");
}

function updateFinishButton() {
  if (!elements.onboardingFinishButton) return;
  const selected = state.selectedFolderPaths.size > 0 || state.selectedPackIds.size > 0;
  elements.onboardingFinishButton.textContent = selected ? "完成，读第一篇" : "以后再说";
}

async function advanceFromFolderStep() {
  if (state.onboardingMode === "settings") {
    await importSelectedFolders();
    return;
  }
  setOnboardingStep(3);
  updateFinishButton();
}

async function importSelectedFolders() {
  setStatus("正在导入来源…");
  const result = await window.readerApi.applyOnboarding({
    folderPaths: [...state.selectedFolderPaths],
    packIds: []
  });
  hideOnboarding();
  await refreshSites();
  setStatus(`已添加 ${result.added} 个来源，跳过 ${result.duplicates} 个重复链接。`);
}

async function finishOnboarding() {
  const selected = state.selectedFolderPaths.size > 0 || state.selectedPackIds.size > 0;
  if (!selected) {
    await window.readerApi.completeOnboarding();
    hideOnboarding();
    renderEmptyLibrary("还没有阅读来源，请添加网站或导入书签。");
    return;
  }
  setStatus("正在导入来源…");
  const result = await window.readerApi.applyOnboarding({
    folderPaths: [...state.selectedFolderPaths],
    packIds: [...state.selectedPackIds]
  });
  hideOnboarding();
  await refreshSites();
  await loadNextReading();
  if (state.readerArticle) showToast(`已添加 ${result.added} 个来源`);
}

async function skipOnboarding() {
  await window.readerApi.completeOnboarding();
  hideOnboarding();
  renderEmptyLibrary("还没有阅读来源，请添加网站或导入书签。");
}

function hideOnboarding() {
  elements.onboardingView?.classList.add("hidden");
  elements.readerModeView.classList.remove("hidden");
}
