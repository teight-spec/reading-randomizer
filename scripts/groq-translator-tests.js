module.exports = function registerGroqTranslatorTests({ test, fs, path, assert, os }) {
  const {
    GroqTranslator,
    MAX_DAILY_CHARS,
    MAX_DAILY_REQUESTS,
    CONSENT_REQUIRED_MESSAGE,
    BUDGET_EXCEEDED_MESSAGE,
    shanghaiCalendarDate
  } = require("../src/main/services/groqTranslator");
  const { Translator } = require("../src/main/services/translator");

  async function withTempDir(prefix, fn) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    try {
      return await fn(dir);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  function makeStore(dir, { consent = true, apiKey = "test-groq-key-with-enough-length", model = "qwen/qwen3.6-27b" } = {}) {
    return {
      filePath: path.join(dir, "secure-settings.json"),
      getGroqApiKey: async () => apiKey,
      getModel: async () => model,
      getPublicSettings: async () => ({ translationConsent: consent === true })
    };
  }

  function successRequest(calls) {
    return async () => {
      calls.count += 1;
      return {
        ok: true,
        status: 200,
        text: JSON.stringify({ choices: [{ message: { content: "译文" } }] })
      };
    };
  }

  test("shanghaiCalendarDate uses the Asia/Shanghai calendar day, not UTC", () => {
    assert.equal(shanghaiCalendarDate(new Date("2026-11-26T15:59:59.000Z")), "2026-11-26");
    assert.equal(shanghaiCalendarDate(new Date("2026-11-26T16:00:00.000Z")), "2026-11-27");
  });

  test("GroqTranslator refuses to call the cloud API when translation consent is missing", async () => {
    await withTempDir("groq-consent-", async (dir) => {
      const calls = { count: 0 };
      const translator = new GroqTranslator({
        settingsStore: makeStore(dir, { consent: false }),
        request: successRequest(calls)
      });
      await assert.rejects(
        () => translator.translate({ text: "Hello world", target: "zh-CN" }),
        (error) => error.code === "GROQ_CONSENT_REQUIRED" && error.message === CONSENT_REQUIRED_MESSAGE
      );
      assert.equal(calls.count, 0);
      const budgetPath = path.join(dir, "translation-budget.json");
      assert.equal(await fs.access(budgetPath).then(() => true, () => false), false);
    });
  });

  test("GroqTranslator refuses a 81st request in the same Shanghai day without calling the API", async () => {
    await withTempDir("groq-req-limit-", async (dir) => {
      const calls = { count: 0 };
      const now = () => new Date("2026-11-27T08:00:00.000+08:00");
      const translator = new GroqTranslator({
        settingsStore: makeStore(dir),
        request: successRequest(calls),
        now
      });
      await fs.writeFile(
        path.join(dir, "translation-budget.json"),
        JSON.stringify({ date: "2026-11-27", requests: MAX_DAILY_REQUESTS, chars: 100 }) + "\n",
        "utf8"
      );
      await assert.rejects(
        () => translator.translate({ text: "Hello", target: "zh-CN" }),
        (error) => error.code === "GROQ_BUDGET_EXCEEDED" && error.message === BUDGET_EXCEEDED_MESSAGE
      );
      assert.equal(calls.count, 0);
      const budget = JSON.parse(await fs.readFile(path.join(dir, "translation-budget.json"), "utf8"));
      assert.equal(budget.requests, MAX_DAILY_REQUESTS);
      assert.equal(budget.chars, 100);
    });
  });

  test("GroqTranslator refuses a request that would exceed 80,000 Shanghai-day characters without calling the API", async () => {
    await withTempDir("groq-char-limit-", async (dir) => {
      const calls = { count: 0 };
      const now = () => new Date("2026-11-27T08:00:00.000+08:00");
      const translator = new GroqTranslator({
        settingsStore: makeStore(dir),
        request: successRequest(calls),
        now
      });
      await fs.writeFile(
        path.join(dir, "translation-budget.json"),
        JSON.stringify({ date: "2026-11-27", requests: 3, chars: MAX_DAILY_CHARS - 10 }) + "\n",
        "utf8"
      );
      await assert.rejects(
        () => translator.translate({ text: "abcdefghijk", target: "zh-CN" }),
        (error) => error.code === "GROQ_BUDGET_EXCEEDED" && error.message === BUDGET_EXCEEDED_MESSAGE
      );
      assert.equal(calls.count, 0);
    });
  });

  test("GroqTranslator resets the daily budget at the next Asia/Shanghai calendar day", async () => {
    await withTempDir("groq-day-reset-", async (dir) => {
      const calls = { count: 0 };
      let current = new Date("2026-11-26T23:30:00.000+08:00");
      const translator = new GroqTranslator({
        settingsStore: makeStore(dir),
        request: successRequest(calls),
        now: () => current
      });
      await fs.writeFile(
        path.join(dir, "translation-budget.json"),
        JSON.stringify({ date: "2026-11-26", requests: MAX_DAILY_REQUESTS, chars: MAX_DAILY_CHARS }) + "\n",
        "utf8"
      );
      await assert.rejects(
        () => translator.translate({ text: "Hello", target: "zh-CN" }),
        (error) => error.code === "GROQ_BUDGET_EXCEEDED"
      );
      assert.equal(calls.count, 0);

      current = new Date("2026-11-27T00:00:00.000+08:00");
      const result = await translator.translate({ text: "Hello", target: "zh-CN" });
      assert.equal(result.translatedText, "译文");
      assert.equal(calls.count, 1);
      const budget = JSON.parse(await fs.readFile(path.join(dir, "translation-budget.json"), "utf8"));
      assert.equal(budget.date, "2026-11-27");
      assert.equal(budget.requests, 1);
      assert.equal(budget.chars, 5);
    });
  });

  test("Translator surfaces Groq consent and budget errors instead of silently falling through", async () => {
    const consentError = new Error(CONSENT_REQUIRED_MESSAGE);
    consentError.code = "GROQ_CONSENT_REQUIRED";
    const budgetError = new Error(BUDGET_EXCEEDED_MESSAGE);
    budgetError.code = "GROQ_BUDGET_EXCEEDED";

    const consentTranslator = new Translator({
      groqTranslator: { translate: async () => { throw consentError; } }
    });
    await assert.rejects(
      () => consentTranslator.translate({ text: "Hello world", direction: "auto" }),
      (error) => error.code === "GROQ_CONSENT_REQUIRED" && error.message === CONSENT_REQUIRED_MESSAGE
    );

    const budgetTranslator = new Translator({
      groqTranslator: { translate: async () => { throw budgetError; } }
    });
    await assert.rejects(
      () => budgetTranslator.translate({ text: "Hello world", direction: "auto" }),
      (error) => error.code === "GROQ_BUDGET_EXCEEDED" && error.message === BUDGET_EXCEEDED_MESSAGE
    );
  });
};
