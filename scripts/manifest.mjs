// Manifest V3 definition. Generated (not hand-copied) so the E2E build can add
// the few extra permissions automated tests need without touching production.
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/** @param {{ e2e?: boolean }} [opts] */
export function createManifest(opts = {}) {
  const icons = {
    16: 'icons/icon-16.png',
    32: 'icons/icon-32.png',
    48: 'icons/icon-48.png',
    128: 'icons/icon-128.png',
  };

  /** @type {Record<string, unknown>} */
  const manifest = {
    manifest_version: 3,
    name: 'SnapFlow – Smart Screen Capture & Editor',
    short_name: 'SnapFlow',
    version: pkg.version,
    description:
      'Capture the visible area, a selection, an element or a full scrolling page. Copy it as a real image or annotate it first. 100% local, no account, no tracking.',
    minimum_chrome_version: '116',
    icons,
    action: {
      default_title: 'SnapFlow – capture a screenshot',
      default_popup: 'popup/index.html',
      default_icon: icons,
    },
    background: { service_worker: 'background.js', type: 'module' },
    options_ui: { page: 'options/index.html', open_in_tab: true },
    // Minimum-permission model: no host permissions. `activeTab` + `scripting`
    // give temporary access to the tab the user invoked SnapFlow on.
    permissions: ['activeTab', 'scripting', 'storage', 'downloads', 'clipboardWrite'],
    commands: {
      'capture-visible': {
        suggested_key: { default: 'Alt+Shift+V' },
        description: 'Capture visible area',
      },
      'capture-area': {
        suggested_key: { default: 'Alt+Shift+A' },
        description: 'Capture selected area',
      },
      'capture-full-page': {
        suggested_key: { default: 'Alt+Shift+F' },
        description: 'Capture full page',
      },
      // No default key: Chrome only lets an extension suggest four. Bind one at chrome://extensions/shortcuts.
      'capture-scroll-area': {
        description: 'Capture a scrolling area',
      },
      'capture-element': {
        suggested_key: { default: 'Alt+Shift+E' },
        description: 'Capture an element',
      },
    },
    // Only the preview document may be framed by pages (the capture overlay).
    // `use_dynamic_url` makes its URL unguessable, so pages cannot fingerprint SnapFlow.
    web_accessible_resources: [
      {
        resources: ['preview/index.html'],
        matches: ['<all_urls>'],
        use_dynamic_url: true,
      },
    ],
    content_security_policy: {
      extension_pages:
        "script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'",
    },
  };

  if (opts.e2e) {
    // Test-only: lets automated tests start captures without the toolbar click
    // that normally grants `activeTab`, and read the real clipboard back.
    manifest.name = 'SnapFlow (E2E build)';
    manifest.host_permissions = ['<all_urls>']; // captureVisibleTab needs <all_urls> or activeTab (no toolbar click in tests)
    manifest.permissions = [...manifest.permissions, 'clipboardRead', 'tabs'];
  }
  return manifest;
}
