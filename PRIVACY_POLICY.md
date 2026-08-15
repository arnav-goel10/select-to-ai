# Privacy Policy for Select to AI

Last updated: August 6, 2026

Select to AI does not operate an application server and does not sell personal data. The extension processes information in your browser and sends content only to the AI service or custom gateway you choose.

## Data the extension handles

- **API keys** are stored in `chrome.storage.local` in your browser profile. They are not placed in Chrome Sync and are excluded from settings exports. Version 3.1 migrates keys that older builds may have stored in sync and removes the synced copies.
- **Preferences** such as enabled services, theme, model, and safety limits are stored in `chrome.storage.sync` and may sync through your browser account.
- **Selected text, page context, DOM summaries, prompts, and optional screenshots** are sent directly to the selected AI provider when required for a request. Select to AI does not receive a copy on its own server.
- **Agent history** stores up to 20 validator-confirmed task outlines (the task goal and its subtask list — never page contents) in `chrome.storage.local`. It is read back locally into the planning step of new agent tasks, which means those stored goals and subtask lists are included in the planning prompt sent to your selected AI provider. It is never sent anywhere else, and unvalidated or failed runs are never stored.

Local extension storage is protected by the browser profile and extension permission model, but it is not an encrypted secrets vault. Users with access to your unlocked browser profile or a compromised device may be able to access it.

## External services

Depending on your selection, requests may be sent to OpenAI, Anthropic, OpenRouter, Google Gemini, DeepSeek, Mistral, Groq, Together AI, xAI, OpenCode, or a custom gateway you configure. Their own terms, retention rules, and privacy policies apply.

The extension does not use analytics, advertising SDKs, or third-party telemetry.

## Retention and deletion

Preferences and local data remain until you reset the extension, remove individual settings, clear extension storage, or uninstall it. Use **Options → Reset all settings** to remove preferences and API keys. Browser Sync may retain non-sensitive preferences according to your browser-account settings.

## Security controls

- Requests are restricted to documented provider origins or the exact configured custom-gateway origin.
- Remote custom gateways require HTTPS; HTTP is accepted only for loopback development.
- Arbitrary website access is optional and requested per origin.
- High-risk browser actions require confirmation by default.
- Settings backups exclude API keys.

See [SECURITY.md](SECURITY.md) for the threat model and vulnerability-reporting process.

## Contact

For privacy questions, open a repository discussion or contact the maintainer through [arnav-goel10/select-to-ai](https://github.com/arnav-goel10/select-to-ai). For suspected vulnerabilities, follow the private process in [SECURITY.md](SECURITY.md).
