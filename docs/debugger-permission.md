# Decision: no debugger permission in 4.0

Status: proposed 16 Nov 2026, awaiting the owner's confirmation. The 4.0.0 build ships without `debugger`. This replaces the 10 Nov 2026 note, which recommended shipping it.

## Decision

`debugger` is not in `extension/manifest.json` for 4.0. It is not added in any later update of this store item either. If real key and pointer input is ever wanted, it ships as a separate companion listing that users install on purpose.

## Why

- **It would disable every existing user.** The live listing is 2.0, with about 1,000 users. Its manifest (original `arnav-prak` repository, commit `2f1afab`, checked in as `tests/fixtures/v2.0/manifest.json`) asks for `contextMenus`, `storage`, `sidePanel`, `tabs` and `declarativeNetRequest`, with access to chatgpt.com, gemini.google.com and www.perplexity.ai. Chrome disables an extension on update when the update adds a permission warning, until the user accepts it. `debugger` adds "Access the page debugger backend" and "Read and change all your data on all websites".
- **It cannot be optional.** Chrome's permissions API page lists `debugger` among the permissions that cannot go in `optional_permissions`, so it cannot be asked for at the first agent run.
- **Nothing else forces a prompt.** The 10 Nov note argued that users were re-prompted on this update anyway. That stopped being true once every other new permission was made optional (see the 4.0 manifest below), so `debugger` would be the only reason for the prompt.
- **Store review.** `debugger` brings a longer, in-depth review and puts the Featured badge at risk on re-review.
- **The code already runs without it.** Every debugger call in `extension/engine.js` is behind `connected()`, which returns false when `chrome.debugger` is missing. `extension/recipes/driver.js` is guarded the same way. No code change was needed to drop it.

## The 4.0 manifest

- Required permissions: `contextMenus`, `storage`, `sidePanel`, `tabs`, `declarativeNetRequest` (all in 2.0), plus `activeTab`, `scripting`, `identity`, `alarms` and `idle`, which give no install warning.
- Optional permissions: `notifications`, asked when the user sets up the agent.
- Host permissions and content-script matches: exactly chatgpt.com, gemini.google.com and www.perplexity.ai, as in 2.0.
- Everything else (claude.ai, perplexity.ai without www, AI provider hosts, openrouter.ai, localhost and the sites the agent works on) is an optional host permission, asked in the click that needs it.
- Also gone: `favicon` (tab icons come from the tab itself) and the address-bar keyword `ai`.

## What the agent loses in 4.0

Measured on 10 Nov 2026 with the 59 scripted end-to-end scenarios (`tests/e2e/run-v4.js`, local fixture pages and a scripted model): 59 of 59 pass with the debugger, 52 of 59 without it. The 7 that need it are listed as not applicable to 4.0 in `tests/e2e/not-applicable-4.0.json`:

| Scenario | What it needs |
|---|---|
| `listened` | Finding a control known only by its script listener |
| `slowResults` | Knowing a press has finished loading a late result |
| `pointerHover` | A menu that opens on hover |
| `pointerFrame` | A press inside another site's frame |
| `pointerDrag` | Dragging a slider or a reorderable list |
| `pointerCanvas` | A press at a point on a drawing |
| `realKeys` | A key press the page checks is real |

In 4.0 these page types get scripted input, and screenshots use `chrome.tabs.captureVisibleTab`, which sees only the front tab. These are scripted fixtures, so they show which kinds of page break, not how often real sites use them. No real-site comparison has been run.

## What a later companion listing would need

- Its own store item, name and listing, with `debugger` required from its first version, so nobody is disabled on update.
- A clear single purpose (real keyboard and pointer input for the Select to AI agent) and a justification naming each use: `Input.dispatchKeyEvent`, `Input.dispatchMouseEvent`, `Page.captureScreenshot`, `DOMDebugger.getEventListeners`, `Network.enable` and `Emulation.setFocusEmulationEnabled`, only on a tab where the user started a task.
- Three fixes first, found in the 16 Nov review and not applicable to 4.0: the debugger must not stay attached while the agent waits for the user to sign in, it must not attach for a task that only reads a page, and Settings needs a visible switch for `agentDebuggerMode`.
- The debugger-on end-to-end suite passing (today a non-required nightly job), including the `busyPage` wait.
- Its own privacy disclosure for what it can read, and a note that Chrome shows "started debugging this browser" while it is attached.
