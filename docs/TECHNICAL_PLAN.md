# Cross-platform Reading App Technical Plan

## 1. Technical Analysis

The product has four hard parts:

1. Reading Chrome bookmarks from the local machine.
2. Turning bookmarked sites into recent article candidates.
3. Avoiding repeated sites until all sites have been used.
4. Translating selected text inside a built-in reading view.

For the first Mac MVP, a desktop app is the simplest shape because Chrome's bookmark file is local.
A normal web app cannot read:

`~/Library/Application Support/Google/Chrome/Default/Bookmarks`

without manual upload. A desktop shell can read it directly after the user grants normal file access.

## 2. Recommended Stack

### MVP Stack

- Runtime: Electron
- UI: plain HTML/CSS/JavaScript for the first skeleton
- Main process: Node.js
- Reading view: Electron `webview`
- Local storage: JSON file under Electron `userData`
- Bookmark parser: direct JSON parsing of Chrome's `Bookmarks` file
- Article discovery: RSS/Atom discovery first, homepage fallback second

### Why Electron First

- Node is already installed on this machine.
- Rust/Cargo is not installed, so Tauri would add setup friction.
- Electron supports Mac and Windows well.
- It can read local Chrome bookmark files from the desktop app.
- It supports an embedded webview for MVP reading.

### Android Later

Electron does not target Android. To support Android later, keep business logic separated:

- Bookmark parsing can become a shared service or import/export flow.
- Article picking can remain plain JavaScript.
- UI can be ported to React Native or Capacitor.

For Android, Chrome bookmarks are not as directly readable as desktop Chrome. The likely future approach is:

- Google account sync API if available for the chosen integration path, or
- user export/import, or
- backend sync, or
- a custom bookmark list managed by the app.

## 3. MVP Split

### MVP 0: Project skeleton

Status: implemented.

- Electron app shell.
- Sidebar controls.
- Built-in webview.
- IPC bridge between UI and Node services.

### MVP 1: Bookmark reading

Status: implemented.

- Reads Chrome Default profile bookmarks.
- Recursively scans target folders:
  - English
  - fashion
  - literary award
- Collects all nested URLs.
- Deduplicates by URL.

Current local scan found:

- `fashion`
- `literary award`

The folder `English` was not found by exact name during local inspection, but it remains in the default target list.

### MVP 2: Random site rotation

Status: implemented.

- Maintains local `reading-history.json`.
- Chooses one unused site from the current round.
- When every site has been used, starts a new round.

### MVP 3: Recent article picking

Status: first-pass implemented.

- Discovers RSS/Atom feeds from common paths:
  - `/feed`
  - `/rss`
  - `/rss.xml`
  - `/atom.xml`
- Also scans homepage `<link rel="alternate">`.
- Parses RSS `<item>` and Atom `<entry>`.
- Filters to articles from the last 30 days when dates are available.
- Randomly chooses one article.
- Falls back to the bookmarked site URL if no feed article is found.

### MVP 4: Paywall/archive handling

Status: first-pass implemented.

- Detects obvious paywall phrases in fetched HTML.
- Always prepares an archive URL:

`https://archive.ph/newest/<encoded-url>`

- UI has:
  - Check paywall
  - Open archive

This is intentionally conservative because paywall detection is unreliable across websites.

### MVP 5: Translation

Status: UI and service boundary implemented; provider not yet connected.

The app has:

- Translation input box.
- Translate button.
- To Chinese button.
- To English button.
- Main-process translation service.

Next step:

Implement the provider inside:

`src/main/services/translator.js`

Good provider options:

- DeepL: strong translation quality.
- OpenAI-compatible API: flexible, can handle long sentence/paragraph explanation.
- Google Cloud Translation: stable traditional translation API.
- Local model: private but heavier.

## 4. Current Project Structure

```text
reading-randomizer/
  package.json
  README.md
  docs/
    TECHNICAL_PLAN.md
  scripts/
    smoke-check.js
  src/
    main/
      main.js
      services/
        archive.js
        articlePicker.js
        bypassRegistry.js
        bookmarks.js
        historyStore.js
        readerMode.js
        siteStore.js
        translator.js
    preload/
      preload.js
    renderer/
      index.html
      app.js
      styles.css
```

## 5. Next Implementation Steps

1. Install dependencies with `npm install`.
2. Run with `npm run dev`.
3. Confirm source count in the floating Sources drawer.
4. Test random article selection.
5. Add real translation provider.
6. Improve selection extraction inside webview.
7. Add settings screen for bookmark folder names.

## 6. Important Constraints

### Chrome bookmark access

The app reads only the JSON bookmark file. It does not modify Chrome data.

### Recent article selection

There is no universal way to list all recent articles from every website.
RSS/Atom is the best MVP path. Sites without feeds may need custom adapters later.

### Paywall handling

Automatic archive fallback may not work for every site. Paywall pages differ heavily.
The MVP should provide a visible manual archive button even when auto-detection fails.

### Translation length

Long translations should be chunked later. The current placeholder accepts text but does not call a provider yet.

## 7. Iteration: Long-reading Product Improvements

The first UI was too much like an Electron demo: a large left sidebar and a smaller article area.
The updated UI is now reading-first:

- Top toolbar only.
- Webview uses almost the full window.
- Translation, source management, and bypass settings live in a floating drawer.
- Reader mode displays extracted article content over the webview.
- Reader mode supports font size and reading width controls.

## 8. New Data Structures

### Website Sources

Stored in Electron `userData`:

`sites.json`

Shape:

```json
{
  "sites": [
    {
      "id": "stable id from url",
      "title": "Site title",
      "url": "https://example.com/",
      "domain": "example.com",
      "folderPath": "manual or Chrome folder",
      "source": "manual or chrome-bookmark",
      "paused": false,
      "createdAt": "ISO timestamp"
    }
  ],
  "importedChromeAt": "ISO timestamp"
}
```

Behavior:

- First run seeds the site list from Chrome bookmarks.
- User can add manual sites.
- User can pause or resume sites.
- User can delete sites.
- Random rotation only uses active sites.

### Paywall Bypass Registry

Stored in Electron `userData`:

`paywall-bypass.json`

Shape:

```json
{
  "sources": [
    {
      "id": "archive-ph",
      "name": "archive.ph",
      "template": "https://archive.ph/newest/{url}",
      "enabled": true,
      "priority": 1
    }
  ]
}
```

Behavior:

- No bypass source is hardcoded inside article selection anymore.
- Sources are user-editable.
- Template must contain `{url}`.
- Enabled sources are tried by priority.
- If one bypass page fails to load, the UI attempts the next enabled source.

## 9. New Services

```text
src/main/services/siteStore.js
  Owns editable website sources.

src/main/services/bypassRegistry.js
  Owns editable paywall bypass sources.

src/main/services/readerMode.js
  Fetches article HTML and extracts clean article content using Mozilla Readability.
```

## 10. Current Known Gaps

- Translation provider is still a placeholder.
- Reader mode depends on each website allowing article HTML fetches.
- Some sites block RSS or article fetches; per-site adapters may be needed later.
- Webview text selection extraction is best-effort; manual paste remains supported.
- Android support still needs a separate shell and a different bookmark-sync strategy.

## 11. Reading-flow Refactor

The app should behave like a long-form reading system, not like a browser shell.

Current intended flow:

```text
Choose active site
  -> discover RSS / Atom / sitemap / latest pages
  -> filter recent articles from last 30 days
  -> randomly select one article
  -> fetch article HTML in the main process
  -> extract clean content with Mozilla Readability
  -> render reader content directly in the app
  -> only open original webview on demand
```

Fallback behavior:

- If RSS/Atom fails, try sitemap.
- If sitemap fails, try common latest pages.
- If no article is found, fall back to the bookmarked homepage.
- If reader extraction fails, show the original page as fallback.

## 12. Performance And Noise Reduction

The app now installs a request blocker for the Electron session.

Blocked categories include common ad and tracking hosts:

- DoubleClick
- Google Analytics
- Google Tag Manager
- Facebook tracking scripts
- Taboola / Outbrain
- Criteo and other ad networks

The preferred reading path avoids loading the full page in `webview` at startup.
The main process fetches HTML, extracts readable content, and the renderer displays clean HTML.

## 13. Manual Verification Flow

The app does not try to break Cloudflare or CAPTCHA challenges.

Correct flow:

```text
article url
  -> try bypass source 1
  -> if it fails, try bypass source 2
  -> if all fail, user can open Verify
  -> user completes challenge manually
  -> session/cookies remain in Electron session
  -> user retries Reader or Bypass
```

This is intentionally conservative for long-term stability.

## 14. Translation System Refactor

The translation flow is now designed for reading without interruption.

Current behavior:

```text
User selects text in Reader Mode
  -> renderer waits 350ms debounce
  -> selected text is normalized
  -> text is capped at 4500 characters
  -> async IPC call to main process translator
  -> result appears in floating translation popup
```

The popup:

- does not navigate away from the article
- can be closed
- can be pinned
- can be dragged

Provider strategy:

- Primary/free fallback: Google Translate public endpoint
- Cache: in-memory cache in `Translator`, up to 500 entries
- Timeout: 8 seconds
- Failure mode: visible error text, no UI freeze

The translation service lives in:

`src/main/services/translator.js`

The selection popup logic lives in:

`src/renderer/app.js`

Future upgrade path:

- add DeepL as an optional first provider
- keep Google Translate as fallback
- persist translation cache if repeated long-form reading needs it

## 15. Stability Refactor: Article-level Preprocessing

The app now treats the article as the unit of work. It should not use a homepage as the default reading entry.

Current stable flow:

```text
App ready
  -> main process starts ArticlePrefetcher
  -> choose active sites in a small batch
  -> discover candidate article URLs from RSS / Atom / sitemap / latest pages
  -> reject homepage, tag, category, author, login, search, sponsored, ad-like URLs
  -> extract each candidate with Mozilla Readability
  -> validate text length and content density
  -> cache prepared reading result
  -> renderer consumes prepared article
```

Key files:

- `src/main/services/articlePrefetcher.js`
- `src/main/services/articlePicker.js`
- `src/main/services/readerMode.js`

Important rules:

- `pickRecentArticle` no longer falls back to the site homepage.
- Invalid candidate URLs return `null` and the prefetcher moves on.
- Reader extraction rejects short previews and low-density pages.
- Reader extraction tries canonical, AMP, and read-more / continue-reading variants.

## 17. WebView Removal And Structured Library

The renderer no longer uses `webview` for reading content.

Current rendering model:

```text
main process fetches article HTML
  -> Mozilla Readability extracts article
  -> renderer receives article object
  -> renderer displays article in custom DOM reader UI
```

Original pages and bypass mirrors are opened externally. They are not used as the reading surface.

Library structure:

```text
folder
  -> site
      -> articleSources
```

Site shape:

```json
{
  "title": "BBC",
  "url": "https://bbc.com/",
  "folderPath": "English",
  "articleSources": [
    {
      "type": "feed",
      "url": "https://bbc.com/feed",
      "title": "Manual feed"
    }
  ]
}
```

The left sidebar renders the folder/site/source tree. The right pane stays focused on reading.

## 18. Productization Pass

Current product behavior:

- App opens directly into article reading mode.
- The left library is not a browser bookmark dump; it is a reading source structure.
- Clicking `Read` on a site fetches a random valid article from that site.
- Clicking `Open` opens the website externally, outside the reader surface.

Translation behavior:

- Selection in the reader triggers a floating translation popup.
- Translation uses Google Translate first.
- DeepL is used as an optional fallback when `DEEPL_API_KEY` is configured.
- Long selections are split into chunks.
- Requests retry before failing.
- Cache prevents repeated translation of the same text.

UI direction:

- warmer paper-like reading surface
- softer cards and shadows
- restrained rounded corners
- dark-mode friendly CSS variables
- hover feedback without heavy animation

## 19. Translation Architecture And Product UI Pass

Translation requests now run through Electron IPC:

```text
renderer selection UI
  -> ipcRenderer.invoke("translate:text")
  -> main process Translator
  -> Electron net.request first
  -> fetch fallback only outside Electron
  -> renderer floating popup
```

Why this matters:

- The renderer no longer owns network translation requests.
- Electron `net.request` uses Chromium's network stack, which is more compatible with system proxy, Clash Verge, VPN, and TUN setups than plain Node `fetch`.
- The request wrapper guards timeout / abort races so a single request cannot reject multiple times.
- Google Translate remains the primary provider.
- DeepL is still optional when `DEEPL_API_KEY` is configured.
- Long text is chunked, retried, and cached before returning to the UI.

The UI pass keeps the app as an article renderer:

- No `webview` is used for article body rendering.
- The reader remains custom DOM rendered from Readability output.
- The visual system now uses a warm paper background, restrained blue/orange/teal accents, soft glass surfaces, and dark-mode variables.
- Loading uses skeleton placeholders instead of blank waits.
- Translation popup, drawers, sidebar rows, buttons, and article transitions use transform/opacity-based animation for smoother 60fps behavior.
- A reduced-motion media query disables motion for users who prefer it.

## 20. Reading Library Refinement

The app now treats the left navigation as a reading library, not a bookmark manager.

Sidebar behavior:

- When an article opens, the matching source is marked active.
- The matching collection is automatically expanded.
- The active source is scrolled into view with smooth behavior.
- The active source shows a small `Now reading` context block.
- Source rows show clean names and domains instead of raw imported metadata.

Library migration:

- Existing `sites.json` entries are migrated from raw browser folder paths into product-facing collections:
  - `English`
  - `Fashion`
  - `Literary Awards`
- Older entries without `articleSources` are backfilled with default or known feeds.
- Obvious utility entries, archive tools, subscription pages, PDF download indexes, and dictionaries are paused so random reading does not open non-article tools.

Compatibility improvements:

- Article discovery uses configured feeds first.
- Known feeds were added for high-value sources such as The New Yorker, The Atlantic, Wired, Vogue, GQ, NYRB, Slate, Granta, LRB, and several literary magazines.
- Feed and latest-page discovery now run with bounded concurrency.
- Random prefetch gives each source a discovery budget so one slow or blocked site cannot stall startup.
- Reader extraction has a JSON-LD `articleBody` fallback when Mozilla Readability fails or extracts only preview text.
- Audit tooling exists at `npm run audit:library` with optional filters:
  - `AUDIT_LIMIT=12`
  - `AUDIT_DOMAIN=newyorker`
  - `AUDIT_SITE_TIMEOUT_MS=22000`

Known network reality:

- Some sites block server-side fetch entirely with 403 or connection timeouts.
- In the current network environment, `newyorker.com`, `madame.lefigaro.fr`, and `wonderlandmagazine.com` showed fetch-level blocking or timeout behavior during audit.
- The correct product behavior is to skip these during random reading, keep `Open` available for manual browsing, and use mirror/original flows where appropriate.

## 21. Cache-first Article Loading Architecture

The article pipeline has been reworked away from click-time crawling.

Current architecture:

```text
app startup
  -> ArticlePrefetcher starts background warmup
  -> discover recent article candidates per active source
  -> extract and clean selected articles
  -> store article candidates + cleaned reader output in article-cache.json

user clicks source
  -> check local ready article cache first
  -> return cached cleaned article immediately when available
  -> refresh that source in the background
  -> only crawl/extract synchronously when the cache has no usable article
```

New files:

- `src/main/services/httpClient.js`
- `src/main/services/articleCache.js`

Important behavior:

- Main-process article fetches now use Electron `net.request` when running inside Electron.
- This uses Chromium's network stack instead of plain Node `fetch`, improving compatibility with system proxy, VPN, Clash Verge, and TUN.
- `article-cache.json` stores:
  - article candidates by site
  - article URL
  - title
  - published date
  - cleaned Readability/fallback HTML
  - extraction status and errors
- The cache is pruned to keep local storage bounded.
- Background warmup prepares multiple sources and stores ready-to-render articles before the user clicks.
- Random reading and source-click reading are now cache-first.

Reader extraction is now a chain, not a single parser:

```text
fetch HTML
  -> Mozilla Readability
  -> JSON-LD articleBody fallback
  -> DOM selector heuristic fallback
  -> validation
```

The fallback selector layer checks common article body containers such as:

- `article`
- `main article`
- `data-testid` article/body containers
- `.article-body`
- `.body__inner-container`
- `.entry-content`
- `.post-content`

The New Yorker validation:

- Previous behavior: Node fetch/feed discovery timed out, then the app treated the source as unreadable.
- New behavior: Electron network stack can fetch through the app's real network path, and fallback extraction succeeds.
- Audit result: `The New Yorker` successfully extracted a readable article with 3679 characters.

## 22. Stability Diagnostics And Source Health

The reader now records extraction diagnostics instead of storing only a generic failure string.

Each extraction attempt can record:

- fetch stage
- HTTP status
- HTML byte size
- variant URLs attempted
- parser used
- text length
- content density
- selector match count
- last error

`article-cache.json` now also stores `healthBySite`.

Health data includes:

- candidate discovery success rate
- extraction success rate
- parser distribution
- last text length
- last density
- last diagnostics
- last error

Commands:

```bash
npm run audit:library
npm run health:report
```

Targeted examples:

```bash
AUDIT_DOMAIN=newyorker AUDIT_ARTICLE_LIMIT=3 npm run audit:library
AUDIT_DOMAIN=economist AUDIT_SITE_TIMEOUT_MS=90000 npm run audit:library
```

Current targeted findings:

- `The New Yorker` now succeeds through the `json-ld` fallback parser.
- `The Economist` currently fails at article candidate discovery in this environment. Official RSS/sitemap/latest routes do not produce candidates, and dynamic browser indexing can time out. This is now diagnosed as candidate discovery failure, not extraction failure.
- In the app path, slow dynamic browser discovery is not allowed to block normal click-to-read behavior. It remains a diagnostic path, while reading stays cache-first and bounded.

Article opening:

- The top bar action is now explicitly `Open Article`.
- It opens the current article URL externally, not the source homepage.

## 23. Translation Lifecycle Hardening

Translation state is now decoupled from transient DOM state.

Renderer behavior:

- Selection handling listens to `selectionchange`, `pointerup`, `mouseup`, and `keyup`.
- A stable selection snapshot is created only when the selection belongs to the reader article.
- Translation cache keys include the current article URL plus the selected text and direction.
- Re-rendering an article clears stale selection state and closes the floating translation panel unless pinned.
- The floating translation panel no longer depends on a DOM range remaining alive after render.
- Renderer requests include `articleId` and `selectionKey`.

Main process behavior:

- `TranslationStore` persists translation results in `translation-cache.json`.
- Translator cache keys are hashed, article-aware, and stable across app sessions.
- Provider order now supports:
  - `LIBRETRANSLATE_URL` when configured
  - Google Translate public endpoint
  - MyMemory fallback
  - DeepL when `DEEPL_API_KEY` is configured

Current provider finding:

- In the current network environment, both Google Translate and MyMemory returned HTTP 429 during probing.
- The lifecycle/cache issue is fixed in code, but long-term reliable translation requires a less rate-limited provider, such as self-hosted LibreTranslate or DeepL.
- Probe command:

```bash
./node_modules/.bin/electron scripts/probe-translation.js "short test"
```

## 16. Translation Provider Strategy

Provider order:

1. Google Translate public endpoint.
2. DeepL fallback when `DEEPL_API_KEY` is configured.

Cache:

- in-memory cache
- max 500 entries
- key includes source language, target language, and selected text

Failure behavior:

- failures are returned as visible text
- UI does not freeze
- reading flow is not interrupted
