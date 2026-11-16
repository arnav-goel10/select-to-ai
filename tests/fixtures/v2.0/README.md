# Select to AI 2.0 fixture

`manifest.json` is the manifest of the version on the Chrome Web Store (2.0, updated 3 January 2026), byte for byte from commit `2f1afab7271fcc872dcbefd0aa5462ce214ea327` of the original repository `arnav-prak/select-to-ai`, fetched with `gh api` on 16 Nov 2026.

`storage-seed.json` holds the settings a 2.0 user has in `chrome.storage`, read from that commit's `background.js`, `popup.js` and `sidepanel.js`.

Used by `tests/contract/permission-warning-diff.js` (warnings a 2.0 user already accepted) and `tests/e2e/upgrade-from-2.0.js` (a 2.0 profile updated to this build).
