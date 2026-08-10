# Contributing

## Development setup

1. Install Node.js 20 or newer.
2. Run `npm ci`.
3. Run `npm run check` before loading the extension.
4. Load the repository as an unpacked extension from `chrome://extensions`.

After changing extension files, select **Reload** on the extension card. Background-worker logs are available through its **Service worker** link; page-specific logs are in the relevant DevTools console.

## Pull requests

- Keep each change focused and explain the user-visible behavior.
- Add regression tests for security policy or storage changes.
- Update the privacy policy when data collection, storage, transmission, or retention changes.
- Do not commit API keys, exported settings, browser profiles, recordings with personal data, or generated extension packages.
- Include manual verification steps for changes involving Chrome UI, permissions, side panels, or content scripts.

## Commit style

Use concise imperative subjects, for example: `Harden provider request boundary`. Squash experimental commits before merging so the default branch remains readable.
