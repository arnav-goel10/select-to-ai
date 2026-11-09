# The debugger permission in 4.0.0

Decision needed before the store upload: ship 4.0.0 with `debugger` in the manifest, or without it.

## What uses it

All in `extension/engine.js`. The engine attaches to a tab the first time a run acts on it (`connected`) and detaches when the run ends (`releaseKeys`, called from `release`). It never attaches to a tab no run is working in.

| Use | Chrome DevTools Protocol call | Without the debugger |
|---|---|---|
| Real key presses (Enter, Tab, Escape, arrows) that move focus, scroll and submit like a person's | `Input.dispatchKeyEvent` | Scripted `KeyboardEvent`s, which pages see as `isTrusted: false` and which do not scroll or move focus |
| Real pointer: hover to open menus, drag sliders and lists, press at a point on a canvas, press inside another site's frame | `Input.dispatchMouseEvent` through `TOOLS.runGesture` | Scripted clicks only. Hover menus, drags, canvas points and cross-site frames do not work |
| Screenshots of a tab behind another | `Page.captureScreenshot` | `chrome.tabs.captureVisibleTab`, which only sees the front tab, so the tab has to be brought forward |
| Finding controls that only a script listener makes clickable (a `div` with a click handler and no text) | `DOMDebugger.getEventListeners` | Those controls are not listed |
| Knowing when a press has finished loading what it asked for | `Network.enable` events | The wait goes by what the page shows, which is slower and misses late results |
| Keeping a background tab focused for input | `Emulation.setFocusEmulationEnabled` | Input to a background tab can be dropped |

The code already runs without it: every call is behind `connected()`, which returns false when `chrome.debugger` is missing, when the hidden setting `agentDebuggerMode` is `"off"`, or when the user dismissed Chrome's bar during a run. So dropping the permission is a one-line manifest change and needs no code change.

## What breaks without it (measured)

The 59 scripted end-to-end scenarios (`tests/e2e/run-v4.js`, local fixture pages and a scripted model) were run on 10 Nov 2026 with and without the debugger:

| Arm | Passed | Output |
|---|---|---|
| Debugger on (the default) | 59 of 59 | `results/e2e/e2e-debugger-on-2026-11-10.txt` |
| Debugger off (`E2E_DEBUGGER=off`) | 52 of 59 | `results/e2e/e2e-debugger-off-2026-11-10.txt` |
| v4 tip before the merge, debugger on | 59 of 59 | `results/e2e/e2e-v4-tip-baseline-2026-11-10.txt` |

The 7 that fail without it: `listened` (a control known only by its listener), `slowResults` (a press whose result arrives late), `pointerHover` (a menu that opens on hover), `pointerFrame` (a seat map in another site's frame), `pointerDrag` (a slider and a reorderable list), `pointerCanvas` (a press at a point on a drawing), `realKeys` (a key the page checks is real). These are scripted fixtures, so they show which kinds of page break, not how often real sites use them. No real-site comparison has been run.

## What the user sees

- **At install or update**, Chrome lists "Access the page debugger backend" and "Read and change all your data on all websites" (Chrome's permission warnings page). The second line also comes from the optional all-sites access, but with `debugger` it appears at install, before the user has granted any site.
- **Existing users** are disabled on update until they accept the new warnings. The 2.0 manifest on the store asked for `contextMenus`, `storage`, `sidePanel`, `tabs` and `declarativeNetRequest`, with access to chatgpt.com, gemini.google.com and www.perplexity.ai only (checked in the original `arnav-prak` repository, commit `2f1afab`). 4.0.0 adds access to claude.ai and 13 AI provider hosts, plus `favicon` and others, so existing users get a new-warnings prompt with or without `debugger`. Adding `debugger` later, in a 4.1, would disable everyone a second time.
- **During a run**, Chrome shows a bar on every window: "Select to AI started debugging this browser", with Cancel. It stays until the run ends. Cancel switches that run to scripted input.
- Chrome does not allow `debugger` in `optional_permissions` (Chrome's permissions API page lists it among those that cannot be optional), so it cannot be asked for at the first run.

## Risks for the store

- Broad permissions and `debugger` lead to a longer, in-depth review, and can be a reason to remove the Featured badge on re-review.
- A reviewer must see a clear purpose. The justification in `docs/store-listing.md` names each use and says it applies only to tabs in a task the user started.

## Recommendation

Ship 4.0.0 with `debugger`. Users are re-prompted on this update anyway, so this is the one update where adding it costs no extra prompt, and the agent without it fails on hover menus, drags, real keys and cross-site frames, which are common on shopping and booking sites. The listing already says what the bar is.

Ship without it if keeping the Featured badge and a fast review matter more than those page types for this release. Then remove `"debugger"` from `permissions` in `extension/manifest.json`, delete the debugger line from the permission justifications, and drop the bar sentence from the long description. Nothing else changes. Adding it back later costs a second disable-and-accept for every user.
