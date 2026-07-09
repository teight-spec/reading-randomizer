# Reading Randomizer

Mac-first desktop MVP for reading random articles from selected Chrome bookmark folders.

## MVP Scope

- Import Google Chrome bookmark folders on demand from the local profile.
- Recursively collect URLs under these folders:
  - `English`
  - `fashion`
  - `literary award`
- Rotate sites without repeating until all sites have been used.
- Try to discover recent articles from RSS/Atom feeds first.
- Fall back to opening the bookmarked site if no recent article can be found.
- Store local reading history in Electron `userData`.
- Open articles in an in-app webview.
- Provide translation panel for selected text, sentence, or paragraph.
- Paywall handling is conservative: detect likely paywall text and offer archive fallback URL.

## Run

```bash
npm install
npm run dev
```

## Notes

This MVP does not modify or monitor Chrome bookmarks. It reads Chrome's `Bookmarks` JSON file only when the user clicks the bookmark-folder import button.

Translation provider is intentionally abstracted. Add your own API key and implementation in
`src/main/services/translator.js`.
