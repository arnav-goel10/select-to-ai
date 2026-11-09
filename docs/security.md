# Security model

## Protected assets

- User-supplied provider API keys.
- Selected text, page content, screenshots, and task history.
- Privileged Chrome capabilities such as tab access and script injection.

## Principal threats and controls

| Threat | Control |
| --- | --- |
| API-key exfiltration through an arbitrary proxy URL | Exact provider/custom-origin allowlist in `extension/security.js`. Trusted extension pages may additionally name a typed-but-unsaved custom-gateway URL for a single connection test; that candidate passes the identical origin policy (HTTPS or loopback, no embedded credentials, exact-origin match) and is never used for agent traffic, which accepts only the saved gateway. |
| Look-alike domain such as `api.openai.com.evil.test` | URL parsing and strict origin equality. |
| Credentials synced across devices | Keys isolated in local storage; legacy sync values migrated and removed. |
| Secrets copied into backup files | Exports contain preferences only. |
| Malicious page invoking privileged proxy messages | Background worker accepts proxy/injection calls only from extension-page senders. |
| Agent operating across the web without consent | Optional host permissions requested per origin. |
| Destructive or sensitive user action | Confirmation gate enabled by default plus domain, step, cost, and failure limits. |
| Unbounded provider payload | GET/POST-only requests and a 2 MiB request limit. |
| Insecure remote gateway | HTTPS required except for loopback development. |

## Residual risks

- Browser-local storage is not an encrypted vault; a compromised machine or browser profile can expose keys.
- Page content can contain prompt-injection instructions. Human confirmation and bounded actions reduce, but do not eliminate, this class of risk.
- The side panel embeds ChatGPT, Gemini, Perplexity and Claude, whose sites forbid framing. A session rule installed by `background.js` (`installSidePanelFrameRule`) removes `X-Frame-Options`, the full `Content-Security-Policy`, `Cross-Origin-Opener-Policy`, `Cross-Origin-Embedder-Policy` and `Permissions-Policy`/`Feature-Policy` from `sub_frame` responses of those domains, and only for requests that belong to no tab (`tabIds: [TAB_ID_NONE]`), which is the side panel. Websites in ordinary tabs cannot frame those assistants because of it; before 3.4 a static rule applied to every iframe, which exposed signed-in users to clickjacking. While embedded in the side panel the assistants run without their own CSP, and upstream site changes can still break embeds.
- AI providers receive the content required for a user-requested operation and apply their own retention policies.

## Verification

`npm run check` runs syntax validation, Node unit tests, and an adversarial outbound-policy benchmark. Security-sensitive changes should add a failing test before modifying the policy.

See [SECURITY.md](../SECURITY.md) to report a vulnerability.
