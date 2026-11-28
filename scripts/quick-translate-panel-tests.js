module.exports = function registerQuickTranslatePanelTests({ test, fs, path, assert }) {
  function isQuickTranslateOpen(document) {
    const panel = document.querySelector("#quickTranslate");
    return Boolean(panel) && !panel.classList.contains("hidden");
  }

  function readerWidthVar(document) {
    return document.documentElement.style.getPropertyValue("--reader-width").trim();
  }

  function findTextNode(root, text) {
    const nodes = [];
    const walker = root.ownerDocument.createTreeWalker(root, root.ownerDocument.defaultView.NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      if (node.nodeValue && node.nodeValue.includes(text)) nodes.push(node);
      node = walker.nextNode();
    }
    return nodes[0] || null;
  }

  function selectTextIn(window, element, text) {
    const node = findTextNode(element, text);
    if (!node) throw new Error(`stub text not found: ${text}`);
    const start = node.nodeValue.indexOf(text);
    const range = window.document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + text.length);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return selection.toString();
  }

  function clearWindowSelection(window) {
    window.getSelection().removeAllRanges();
  }

  function dispatch(window, target, type, extra = {}) {
    const event = new window.Event(type, { bubbles: true, cancelable: true, ...extra });
    target.dispatchEvent(event);
  }

  async function waitFor(condition, timeoutMs, message) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    throw new Error(message || "timed out");
  }

  async function loadQuickTranslateHarness({
    translationConsent = true,
    translateText,
    articles
  } = {}) {
    const { JSDOM } = require("jsdom");
    const html = await fs.readFile(path.join(__dirname, "..", "src", "renderer", "index.html"), "utf8");
    const dom = new JSDOM(html, {
      url: "file:///suiyue-quick-translate-stub.html",
      runScripts: "outside-only",
      pretendToBeVisual: true
    });
    const window = dom.window;
    const document = window.document;

    const articleFixtures = articles || [
      {
        site: { id: "site-1", domain: "stub.example", title: "Stub Site", url: "https://stub.example/" },
        article: { title: "Stub article one", url: "https://stub.example/one", source: "stub" },
        readerArticle: {
          title: "Stub article one",
          url: "https://stub.example/one",
          byline: "",
          publishedAt: null,
          textContent: "ALPHA_SELECTION_TEXT is the first local stub passage used only for tests. BETA_SELECTION_TEXT is the second local stub passage used only for tests.",
          content: "<p>ALPHA_SELECTION_TEXT is the first local stub passage used only for tests.</p><p>BETA_SELECTION_TEXT is the second local stub passage used only for tests.</p>"
        }
      },
      {
        site: { id: "site-1", domain: "stub.example", title: "Stub Site", url: "https://stub.example/" },
        article: { title: "Stub article two", url: "https://stub.example/two", source: "stub" },
        readerArticle: {
          title: "Stub article two",
          url: "https://stub.example/two",
          byline: "",
          publishedAt: null,
          textContent: "GAMMA_SELECTION_TEXT is the third local stub passage used only for tests.",
          content: "<p>GAMMA_SELECTION_TEXT is the third local stub passage used only for tests.</p>"
        }
      }
    ];
    let articleIndex = 0;
    let consent = translationConsent === true;
    const translateCalls = [];

    window.readerApi = {
      getSiteTree: async () => [],
      listSites: async () => [],
      listBypassSources: async () => [],
      listShelf: async () => ({ later: [], recent: [] }),
      getCacheUsage: async () => ({ bytes: 0 }),
      getKnowledgeStats: async () => ({ total: 0 }),
      getOnboardingState: async () => ({ show: false }),
      getResumeOffer: async () => null,
      getKnowledgeSettings: async () => ({
        model: "stub-model",
        source: "secure-storage",
        configured: false,
        secureStorageAvailable: true,
        translationConsent: consent,
        readerPreferences: { fontSize: 20, width: 720 }
      }),
      saveTranslationConsent: async (enabled) => {
        consent = Boolean(enabled);
        return { translationConsent: consent };
      },
      saveReaderPreferences: async (prefs) => prefs,
      inspectArticle: async () => ({
        paywalled: false,
        outcome: "no_paywall",
        bypassUrls: [],
        reason: null,
        target: "original"
      }),
      getNextReading: async () => {
        const item = articleFixtures[Math.min(articleIndex, articleFixtures.length - 1)];
        articleIndex += 1;
        return { ...item, skippedSites: [], readerError: null };
      },
      translateText: async (payload) => {
        translateCalls.push({ ...payload, at: Date.now() });
        if (translateText) return translateText(payload);
        return {
          translatedText: `STUB_TRANSLATION:${payload.text}`,
          provider: "local-stub",
          cached: false
        };
      }
    };

    const sessionSource = await fs.readFile(path.join(__dirname, "..", "src", "renderer", "nextReadingSession.js"), "utf8");
    window.eval(sessionSource);
    const source = await fs.readFile(path.join(__dirname, "..", "src", "renderer", "app.js"), "utf8");
    window.eval(source);
    await waitFor(
      () => document.querySelector("#readerArticle")?.textContent?.includes("SELECTION_TEXT")
        || document.querySelector("#readerArticle")?.textContent?.includes("Stub article"),
      2000,
      "renderer boot did not render the local stub article"
    );

    const readerModeView = document.querySelector("#readerModeView");
    let scrollTop = 180;
    Object.defineProperties(readerModeView, {
      clientHeight: { configurable: true, get: () => 400 },
      scrollHeight: { configurable: true, get: () => 1200 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value) => { scrollTop = Number(value); }
      }
    });
    readerModeView.scrollTop = 180;

    return {
      window,
      document,
      dom,
      translateCalls,
      setConsent(value) { consent = value; },
      getConsent() { return consent; },
      getScrollTop() { return readerModeView.scrollTop; },
      async selectInArticle(text) {
        const article = document.querySelector("#readerArticle");
        const selected = selectTextIn(window, article, text);
        dispatch(window, document, "selectionchange");
        dispatch(window, article, "pointerup");
        return selected;
      },
      clearInArticle() {
        clearWindowSelection(window);
        dispatch(window, document, "selectionchange");
        dispatch(window, document.querySelector("#readerArticle"), "pointerup");
      },
      interactWithPanel(kind) {
        const panel = document.querySelector("#quickTranslate");
        const sourceBox = document.querySelector("#quickTranslateSource");
        if (kind === "scroll") {
          dispatch(window, panel, "pointerdown");
          panel.scrollTop = 12;
          dispatch(window, panel, "scroll");
          dispatch(window, panel, "pointerup");
          return;
        }
        dispatch(window, panel, "pointerdown");
        clearWindowSelection(window);
        if (kind === "select" && sourceBox?.textContent) {
          try { selectTextIn(window, sourceBox, sourceBox.textContent.trim().slice(0, 8) || sourceBox.textContent.trim()); }
          catch { /* source box may be empty in some stubs */ }
        }
        dispatch(window, document, "selectionchange");
        dispatch(window, kind === "copy" ? sourceBox || panel : panel, kind === "select" ? "pointerup" : "click");
        dispatch(window, panel, "pointerup");
      },
      blurOrLeave() {
        dispatch(window, window, "blur");
        dispatch(window, document, "visibilitychange");
        dispatch(window, readerModeView, "mouseleave");
        dispatch(window, document.querySelector("#readerArticle"), "focusout");
      },
      async waitForPanel(open, timeoutMs = 800) {
        await waitFor(
          () => isQuickTranslateOpen(document) === open,
          timeoutMs,
          `quick translate panel did not become ${open ? "open" : "hidden"}`
        );
      },
      click(id) {
        const button = document.querySelector(id);
        if (!button) throw new Error(`missing ${id}`);
        button.click();
      },
      async goNextArticle() {
        const button = document.querySelector("#nextButton");
        if (!button) throw new Error("missing #nextButton");
        button.click();
        await waitFor(
          () => document.querySelector("#readerArticle")?.textContent?.includes("GAMMA_SELECTION_TEXT")
            || document.querySelector("#articleTitle")?.textContent === "Stub article two",
          2000,
          "did not switch to the second stub article"
        );
      },
      async setConsentInUi(enabled) {
        const input = document.querySelector("#translationConsentInput");
        input.checked = Boolean(enabled);
        dispatch(window, input, "change");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
  }

  test("clearing an article selection closes the temporary translate panel, but panel interaction does not (local stub, no paid API)", async () => {
    const harness = await loadQuickTranslateHarness();
    const widthBefore = readerWidthVar(harness.document) || "720px";
    await harness.selectInArticle("ALPHA_SELECTION_TEXT");
    await harness.waitForPanel(true);
    assert.equal(isQuickTranslateOpen(harness.document), true);

    harness.interactWithPanel("select");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(isQuickTranslateOpen(harness.document), true, "selecting text in the panel must not close it");

    harness.interactWithPanel("copy");
    harness.interactWithPanel("scroll");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(isQuickTranslateOpen(harness.document), true, "copy or scroll in the panel must not close it");

    harness.blurOrLeave();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(isQuickTranslateOpen(harness.document), true, "blur or mouse leave must not close the panel");

    harness.clearInArticle();
    await harness.waitForPanel(false);
    assert.equal(isQuickTranslateOpen(harness.document), false);
    assert.equal(readerWidthVar(harness.document) || widthBefore, widthBefore);
    assert.equal(harness.getScrollTop(), 180, "closing the panel must not jump the reader to the top");

    // lastSelection fallback must not reopen the old phrase after an explicit body clear
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(isQuickTranslateOpen(harness.document), false, "cleared selection must not reopen from lastSelection");
    harness.dom.window.close();
  });

  test("pinned translate panel stays open on body clear, but explicit close always dismisses and unpins (local stub, no paid API)", async () => {
    const harness = await loadQuickTranslateHarness();
    await harness.selectInArticle("ALPHA_SELECTION_TEXT");
    await harness.waitForPanel(true);
    harness.click("#pinTranslateButton");
    assert.match(harness.document.querySelector("#pinTranslateButton").textContent, /已固定/);
    assert.equal(harness.document.querySelector("#quickTranslate").classList.contains("pinned"), true);

    harness.clearInArticle();
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(isQuickTranslateOpen(harness.document), true, "pin must keep the panel open after a body clear");

    harness.click("#closeQuickTranslateButton");
    await harness.waitForPanel(false);
    assert.equal(isQuickTranslateOpen(harness.document), false);
    assert.equal(harness.document.querySelector("#quickTranslate").classList.contains("pinned"), false);
    assert.equal(harness.document.querySelector("#pinTranslateButton").textContent, "固定");
    harness.dom.window.close();
  });

  test("a slower first translation cannot overwrite a later cache hit or a later no-consent notice (local stub, no paid API)", async () => {
    const pending = new Map();
    const harness = await loadQuickTranslateHarness({
      translateText: (payload) => new Promise((resolve, reject) => {
        pending.set(payload.text, { resolve, reject, payload });
      })
    });

    await harness.selectInArticle("BETA_SELECTION_TEXT");
    await waitFor(() => pending.has("BETA_SELECTION_TEXT"), 800, "BETA stub request was not started");
    pending.get("BETA_SELECTION_TEXT").resolve({
      translatedText: "STUB_BETA",
      provider: "local-stub",
      cached: false
    });
    await waitFor(
      () => harness.document.querySelector("#quickTranslateResult")?.textContent?.includes("STUB_BETA"),
      800,
      "cached source was not stored from the first BETA result"
    );

    await harness.selectInArticle("ALPHA_SELECTION_TEXT");
    await waitFor(() => pending.has("ALPHA_SELECTION_TEXT"), 800, "ALPHA stub request was not started");
    await harness.selectInArticle("BETA_SELECTION_TEXT");
    await waitFor(
      () => harness.document.querySelector("#quickTranslateResult")?.textContent?.includes("STUB_BETA"),
      800,
      "BETA cache hit did not show"
    );
    pending.get("ALPHA_SELECTION_TEXT").resolve({
      translatedText: "STUB_ALPHA_LATE",
      provider: "local-stub",
      cached: false
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.match(harness.document.querySelector("#quickTranslateResult").textContent, /STUB_BETA/);
    assert.equal(harness.document.querySelector("#quickTranslateResult").textContent.includes("STUB_ALPHA_LATE"), false);

    const pendingFail = new Map();
    const harness2 = await loadQuickTranslateHarness({
      translateText: (payload) => new Promise((resolve, reject) => {
        pendingFail.set(payload.text, { resolve, reject, payload });
      })
    });
    await harness2.selectInArticle("ALPHA_SELECTION_TEXT");
    await waitFor(() => pendingFail.has("ALPHA_SELECTION_TEXT"), 800, "ALPHA request missing in no-consent case");
    await harness2.setConsentInUi(false);
    await harness2.selectInArticle("BETA_SELECTION_TEXT");
    await waitFor(
      () => harness2.document.querySelector("#quickTranslateResult")?.textContent?.includes("尚未启用"),
      800,
      "no-consent notice did not appear for the later selection"
    );
    pendingFail.get("ALPHA_SELECTION_TEXT").reject(new Error("STUB_ALPHA_FAILED"));
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.match(harness2.document.querySelector("#quickTranslateResult").textContent, /尚未启用/);
    assert.equal(isQuickTranslateOpen(harness2.document), true);
    harness.dom.window.close();
    harness2.dom.window.close();
  });

  test("closing during debounce or while a translation is loading does not reopen from the old request (local stub, no paid API)", async () => {
    const pending = new Map();
    const harness = await loadQuickTranslateHarness({
      translateText: (payload) => new Promise((resolve) => {
        pending.set(payload.text, { resolve, payload });
      })
    });

    await harness.selectInArticle("ALPHA_SELECTION_TEXT");
    harness.click("#closeQuickTranslateButton");
    await harness.waitForPanel(false, 200);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(isQuickTranslateOpen(harness.document), false, "debounce must be cancelled by explicit close");
    if (pending.has("ALPHA_SELECTION_TEXT")) {
      pending.get("ALPHA_SELECTION_TEXT").resolve({
        translatedText: "STUB_SHOULD_NOT_REOPEN",
        provider: "local-stub",
        cached: false
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(isQuickTranslateOpen(harness.document), false);
    assert.equal(
      (harness.document.querySelector("#quickTranslateResult").textContent || "").includes("STUB_SHOULD_NOT_REOPEN"),
      false
    );

    await harness.selectInArticle("BETA_SELECTION_TEXT");
    await harness.waitForPanel(true);
    await waitFor(() => pending.has("BETA_SELECTION_TEXT"), 800, "BETA loading request was not started");
    assert.match(harness.document.querySelector("#quickTranslateResult").textContent, /正在翻译/);
    harness.click("#closeQuickTranslateButton");
    await harness.waitForPanel(false);
    pending.get("BETA_SELECTION_TEXT").resolve({
      translatedText: "STUB_LOADING_LATE",
      provider: "local-stub",
      cached: false
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(isQuickTranslateOpen(harness.document), false, "an in-flight result must not reopen a closed panel");
    assert.equal(
      (harness.document.querySelector("#quickTranslateResult").textContent || "").includes("STUB_LOADING_LATE"),
      false
    );

    await harness.selectInArticle("ALPHA_SELECTION_TEXT");
    await harness.waitForPanel(true);
    harness.dom.window.close();
  });

  test("a translation result from a previous article context cannot apply after the article changes (local stub, no paid API)", async () => {
    const pending = new Map();
    const harness = await loadQuickTranslateHarness({
      translateText: (payload) => new Promise((resolve) => {
        pending.set(payload.text, { resolve, payload });
      })
    });
    await harness.selectInArticle("ALPHA_SELECTION_TEXT");
    await waitFor(() => pending.has("ALPHA_SELECTION_TEXT"), 800, "article-one request was not started");
    const widthBefore = readerWidthVar(harness.document);
    await harness.goNextArticle();
    await new Promise((resolve) => setTimeout(resolve, 50));
    pending.get("ALPHA_SELECTION_TEXT").resolve({
      translatedText: "STUB_FROM_ARTICLE_ONE",
      provider: "local-stub",
      cached: false
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(
      (harness.document.querySelector("#quickTranslateResult").textContent || "").includes("STUB_FROM_ARTICLE_ONE"),
      false,
      "old article result must not be applied"
    );
    assert.equal(isQuickTranslateOpen(harness.document), false, "old packet must not reopen the panel on a new article");
    assert.equal(readerWidthVar(harness.document) || widthBefore, widthBefore);
    harness.dom.window.close();
  });
};
