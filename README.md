# scroll-capture-edit

**SnapFlow – Smart Screen Capture & Editor** – a privacy-first Chrome extension (Manifest V3) that captures the
visible area, a selected region, an HTML element or a whole scrolling page, lets you **copy it as a real image**
(or annotate it first) and export PNG / JPEG / WebP. No backend, no account, no tracking – everything stays in the browser.

```
Optional pre-capture action → Capture → Preview → Copy or Edit → Copy / Export
```

* **Capture** – visible area · selected area · full page · **scrolling area** · element (incl. "entire scrollable content").
* **Scrolling area** – select a scrollable table / modal / panel (**Auto detect**: containers under your selection are found,
  ranked and highlighted; if several match equally you must choose) or a rectangle of the page that stays fixed while the page
  scrolls through it (**Manual region**). Vertical, horizontal or both (2-D tile grid), stitched at exact scroll offsets.
  The selection always defines what is captured: a region of the page is captured on its own (no sidebars/ads); inside a
  container the capture is narrowed to the selection across the scroll direction. **Esc while capturing stops and keeps what
  was captured so far** (the pill also has a Discard button).
  Keys in the overlay: `A`/`M` method · `V`/`H`/`B` direction · `1`–`9` pick a container · `Enter` start · `Esc` cancel.
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

## Sharing the extension with other people

```bash
npm run package        # builds and writes release/snapflow-<version>.zip
```

Send that zip. The recipient: unzip it to a folder they will keep → open `chrome://extensions` → turn on **Developer mode** →
**Load unpacked** → select the unzipped folder (the one containing `manifest.json`). To update, replace the folder's contents and
press the reload icon on the extension card. The same zip is what you upload to the Chrome Web Store for public/unlisted distribution
(Chrome does not allow installing a self-made `.crx` outside the Store).

## Tests

* **Unit (Vitest, 124 tests)** – pixel-ratio maths, crop boundaries, scroll positions, stitching/overlap/last-frame cropping,
  output-size limits, scroll coordinates / 2-D tiles / target ranking and ambiguity, filenames, undo/redo, annotation serialization, marker numbering, message validation,
  storage policy, and "page is restored after cancel/failure". The desktop app adds pixel-based shift measurement and the scroll/settle/stitch loop
  (sticky bars, side panels, scrollbars, smooth scrolling, sparse content, repetitive content).
* **E2E (Playwright, real Chrome)** – the extension is loaded into Chrome via the DevTools protocol
  (`Extensions.loadUnpacked`; branded Chrome ≥ 137 ignores `--load-extension`). Fixture pages cover long pages, sticky headers,
  fixed navigation, lazy images, nested scroll containers, dynamic height, very tall pages, hi-DPI and browser zoom. Assertions
  are pixel-exact (band order, exact seams, no duplicated headers) and the **real system clipboard is read back** after Copy.

* **Desktop E2E (Playwright + Electron, 14 tests)** – real screen capture, real mouse wheel over a real window, Esc via the OS, the system
  clipboard read back, save to disk, editor round trip; also runnable against the packaged `SnapFlow.exe` (`SNAPFLOW_EXE=…`).

The E2E build (`dist-e2e/`) only differs from production by `host_permissions: <all_urls>` and `clipboardRead`/`tabs`,
because automated tests cannot click the toolbar icon that normally grants `activeTab`.

## Status & known limitations

Verified end-to-end in Chrome 157 (48 Playwright tests): visible / area / element / full-page / scrolling-area capture, preview + clipboard, editor
(rectangle, arrow, text, markers, blur, pixelate, crop, undo/redo), save as PNG/JPEG/WebP, return-to-preview without losing edits.

Not yet covered by automated tests: ellipse / line / pen / highlighter styling details, annotation presets UI, options page,
history page. Not implemented on purpose (later phase): merging screenshots, before/after layouts, QA report templates.

Scrolling capture limits (stated plainly, never silent): cross-origin iframes and virtualised lists / infinite feeds are captured
as rendered; 2-D capture hides fixed elements except on the first and last tile; containers that scroll only via
`overflow:hidden` + script cannot be auto-detected (pick them with Element capture); pages taller than the browser canvas limit are scaled down or cut with an explicit
warning; Chrome's PDF viewer and `chrome://` pages cannot be scripted (visible-area capture still works on the PDF viewer).

## Desktop app (Electron) – capture anything on the screen

The extension can only see web pages. The desktop app (this branch, `desktop-app`) reuses the same preview, editor and
export UI but captures **the whole screen**: any window, any application.

| Shortcut | Mode |
| --- | --- |
| `Ctrl+Shift+1` | **Region** – drag a rectangle anywhere (every monitor) |
| `Ctrl+Shift+2` | **Scrolling region** – drag over the area that scrolls |
| `Ctrl+Shift+3` | **Full screen** – the display the mouse is on |
| `Ctrl+Shift+4` | **Window** – pick one from the list |

In the selection overlay press `R` (region) or `S` (scrolling) to switch mode, `Esc` or right-click to cancel. SnapFlow
lives in the system tray; the launcher window has the same four buttons plus *Recent screenshots* and *Settings*.

**Scrolling region.** SnapFlow does not know how far another application scrolled, so it *measures* it: it rolls the
mouse wheel over the area, takes screenshots, finds how many pixels the content moved between two of them
(`src/shared/overlap.ts`) and stitches the new rows. It ignores sticky headers/footers (kept once), fixed side panels,
the scrollbar and hover highlights, waits for smooth-scrolling animations to finish, and stops at the end of the content.
**Esc** (or *Stop & use* on the pill) stops and keeps what was captured so far; *Discard* throws it away. Keep the mouse
still, and do not cover the area with another window while it runs.

```powershell
npm install                 # downloads Electron (if github.com is blocked: $env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/')
npm run desktop             # build + start the app
npm run desktop:pack        # portable Windows build: release/snapflow-desktop-<version>-win32-x64.zip (unzip, run SnapFlow.exe)
npm run test:desktop        # real-Electron E2E suite – uses the real screen, mouse wheel and clipboard: do not touch the mouse
```

The packaged app is not code-signed, so Windows SmartScreen shows "unknown publisher" the first time (More info → Run anyway).

Desktop limits (stated plainly): scrolling capture and window capture need **Windows** for now (mouse-wheel injection and window
geometry use the Win32 API; the rest is cross-platform); vertical scrolling only; content that is mostly flat colour with
little to anchor on is captured with smaller and smaller steps and, if it still cannot be lined up, ends with an explicit
warning; a fixed side panel appears in every stitched tile; a window that is covered by another one cannot be captured.

## Permissions

`activeTab`, `scripting`, `storage`, `downloads`, `clipboardWrite` – and **no host permissions** (extension). The desktop app has
no network access of its own: pages are served from the app bundle under a strict Content-Security-Policy and only the clipboard
permission is granted.
