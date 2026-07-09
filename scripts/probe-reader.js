const { app } = require("electron");
const { extractReaderArticle } = require("../src/main/services/readerMode");

const url = process.argv[2];

app.setName("reading-randomizer");

app.whenReady().then(async () => {
  if (!url) {
    console.log("Usage: electron scripts/probe-reader.js <url>");
    app.quit();
    return;
  }

  try {
    const article = await extractReaderArticle(url);
    console.log(JSON.stringify({
      ok: true,
      title: article.title,
      length: article.textContent.length,
      parser: article.diagnostics?.parser,
      diagnostics: article.diagnostics
    }, null, 2));
  } catch (error) {
    console.log(JSON.stringify({
      ok: false,
      message: error.message,
      diagnostics: error.diagnostics
    }, null, 2));
  } finally {
    app.quit();
  }
});
