# scroll-capture-edit

**SnapFlow – Smart Screen Capture & Editor** – a privacy-first Chrome extension (Manifest V3) that captures the
visible area, a selected region, an HTML element or a whole scrolling page, lets you **copy it as a real image**
(or annotate it first) and export PNG / JPEG / WebP. No backend, no account, no tracking – everything stays in the browser.

```
Optional pre-capture action → Capture → Preview → Copy or Edit → Copy / Export
```

* **Capture** – visible area · selected area · element (incl. "entire scrollable content") · full page.
* **Preview** (small overlay on the page, not the editor): **Copy**, **Edit**, **Save**, **Close**. `Ctrl/Cmd+C` copies the real PNG.
* **Editor** – rectangle, ellipse, arrow, line, text, pen, highlighter, smart sequential numbering (1, 2, 3 …), blur, pixelate,
  crop, undo/redo, presets. Exports contain only image pixels (no handles/toolbars).
* **Export** – PNG, JPEG, WebP (quality), custom file name / prefix / timestamp.

## Quick start

```bash
npm install
npm run build          # type-check + production build into dist/
```

Load it in Chrome: `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the **`dist/` folder**
(not the project root – only `dist/` contains `manifest.json`; it is created by `npm run build`).

| Command | What it does |
| --- | --- |
| `npm run dev` | rebuild on change (reload the extension in `chrome://extensions` afterwards) |
| `npm run build` | type-check + production bundle in `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm test` | unit tests (Vitest) |
| `npm run test:e2e` | builds `dist-e2e/` and runs the Playwright suite against real Chrome |

## Tests

* **Unit (Vitest, 70 tests)** – pixel-ratio maths, crop boundaries, scroll positions, stitching/overlap/last-frame cropping,
  output-size limits, filenames, undo/redo, annotation serialization, marker numbering, message validation,
  storage policy, and "page is restored after cancel/failure".
* **E2E (Playwright, real Chrome)** – the extension is loaded into Chrome via the DevTools protocol
  (`Extensions.loadUnpacked`; branded Chrome ≥ 137 ignores `--load-extension`). Fixture pages cover long pages, sticky headers,
  fixed navigation, lazy images, nested scroll containers, dynamic height, very tall pages, hi-DPI and browser zoom. Assertions
  are pixel-exact (band order, exact seams, no duplicated headers) and the **real system clipboard is read back** after Copy.

The E2E build (`dist-e2e/`) only differs from production by `host_permissions: <all_urls>` and `clipboardRead`/`tabs`,
because automated tests cannot click the toolbar icon that normally grants `activeTab`.

## Status & known limitations

Verified end-to-end in Chrome 157: visible / area / element / full-page capture, preview + clipboard, editor
(rectangle, arrow, text, markers, blur, pixelate, crop, undo/redo), save as PNG/JPEG/WebP, return-to-preview without losing edits.

Not yet covered by automated tests: ellipse / line / pen / highlighter styling details, annotation presets UI, options page,
history page. Not implemented on purpose (later phase): merging screenshots, before/after layouts, QA report templates.

Full-page capture limits (stated plainly, never silent): cross-origin iframes and virtualised lists are captured as seen;
horizontal scrolling is not stitched; pages taller than the browser canvas limit are scaled down or cut with an explicit
warning; Chrome's PDF viewer and `chrome://` pages cannot be scripted (visible-area capture still works on the PDF viewer).

## Permissions

`activeTab`, `scripting`, `storage`, `downloads`, `clipboardWrite` – and **no host permissions**.
