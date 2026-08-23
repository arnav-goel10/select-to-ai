# Publishing: Chrome Web Store & Edge Add-ons

Both stores take the same MV3 package; only the upload portals differ.
Build per-target zips with:

```bash
npm run package -- --all
```

which produces:

- `dist/select-to-ai-chrome.zip`
- `dist/select-to-ai-edge.zip`

## Chrome Web Store

1. Upload `dist/select-to-ai-chrome.zip` at the
   [developer dashboard](https://chrome.google.com/webstore/devconsole).
2. Use the copy in `docs/store-listing.md` (kept in sync with releases).
3. Justify permissions in the review notes:
   - `contextMenus` / `tabs` / `activeTab` / `scripting`: the core select-to-send and agent flows.
   - `storage`: settings and (local-only) keys.
   - `sidePanel`: the assistant surface.
   - `alarms`: user-created scheduled routines.
   - `declarativeNetRequest`: removes framing-related response headers on pages the user automates, with consent.
   - Optional host permissions (`https://*/*`, `http://*/*`): requested per-origin when the user grants a site to the agent or configures a custom gateway/relay.

## Edge Add-ons

1. Package is identical: upload `dist/select-to-ai-edge.zip`
   at [Partner Center](https://partner.microsoft.com/dashboard/microsoftedge).
2. Same listing copy works; Edge reviews historically take longer than Chrome's.
3. Runtime requirements: Edge 114+ (side panel API). The manifest's
   `minimum_chrome_version` covers Chromium floor for both stores.

## Versioning discipline

Bump `version` in both `extension/manifest.json` and `package.json` in the
same PR as the release, update `docs/store-listing.md`, and paste the new
CHANGELOG section into the store's "What's new" field. All three should
describe the same release; this repo previously shipped a listing that
described v2.0 while the code was on 3.x — never again.
