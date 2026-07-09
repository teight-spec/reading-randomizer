const { app } = require("electron");
const { Translator } = require("../src/main/services/translator");
const { TranslationStore } = require("../src/main/services/translationStore");

app.setName("reading-randomizer");

app.whenReady().then(async () => {
  try {
    const translator = new Translator({
      translationStore: new TranslationStore(app.getPath("userData"))
    });
    const result = await translator.translate({
      text: process.argv.slice(2).join(" ") || "Translation health check",
      direction: "zh",
      articleId: "probe",
      selectionKey: "probe:zh:translation-health-check"
    });
    console.log(JSON.stringify({
      ok: !result.error,
      provider: result.provider,
      cached: result.cached,
      error: result.error || null,
      text: result.translatedText
    }, null, 2));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
