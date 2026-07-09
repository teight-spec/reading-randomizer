const { app, BrowserWindow } = require("electron");
const { createExtractionSession } = require("../src/main/services/extractionSession");

const url = process.argv[2] || "https://www.economist.com/";

app.setName("reading-randomizer");

app.whenReady().then(async () => {
  const extractionSession = createExtractionSession({ label: "probe-browser-page", url });
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      session: extractionSession.session,
      contextIsolation: true,
      nodeIntegration: false,
      images: false
    }
  });

  const state = await new Promise((resolve) => {
    win.webContents.once("dom-ready", () => resolve("dom-ready"));
    win.webContents.once("did-finish-load", () => resolve("finish"));
    win.webContents.once("did-fail-load", (_event, code, description, failedUrl, isMainFrame) => {
      if (isMainFrame) resolve(`fail ${code} ${description} ${failedUrl}`);
    });
    setTimeout(() => resolve("timeout"), 25000);
    win.loadURL(url).catch((error) => resolve(`load-error ${error.message}`));
  });

  const data = await win.webContents.executeJavaScript(`
    ({
      href: location.href,
      title: document.title,
      text: document.body ? document.body.innerText.slice(0, 500) : "",
      linkCount: document.querySelectorAll("a[href]").length,
      links: Array.from(document.querySelectorAll("a[href]")).slice(0, 100).map((anchor) => ({
        title: (anchor.innerText || anchor.getAttribute("aria-label") || anchor.getAttribute("title") || "").replace(/\\s+/g, " ").trim(),
        url: anchor.href
      }))
    })
  `).catch((error) => ({ error: error.message }));

  console.log(JSON.stringify({ state, data }, null, 2));
  win.destroy();
  await extractionSession.cleanup();
  app.quit();
});
