# Recording script: 60-second agent run

The clip this script produces fills two slots: the demo player on the
[arnavg.com](https://www.arnavg.com/#/work/select-to-ai) case study and a README embed here. One take, no
narration needed, captions carry the story.

## Ground rules

- Fresh Chrome profile, no personal accounts, no bookmarks bar, default theme.
- The API key entered on camera must be a dummy or revoked immediately after.
- Only public pages on camera (use Wikipedia and example.com). No mail, no
  chats, no history, no notifications: enable Do Not Disturb.
- 1280×800 window, 60fps screen recording, cursor visible. Target 55-65s.

## Scene list

| # | Seconds | On screen | The point it proves |
| --- | --- | --- | --- |
| 1 | 0-8 | Select a paragraph on a Wikipedia article, right-click, "Open ChatGPT with Selected Text"; the provider opens with the text in place | the original product: selection to model, zero copy-paste |
| 2 | 8-18 | Open the agent page, type a bounded cross-tab task (e.g. "collect the population figures from these two open tabs into a list") | task input, plain language |
| 3 | 18-30 | The plan renders step by step; point the cursor at the step list and the per-origin permission card; grant one origin | the agent proposes before it acts; permissions are per-origin, not blanket |
| 4 | 30-45 | Execution: watch steps validate one by one; pause on the step/cost budget readout | plan → execute → validate loop, bounded budgets |
| 5 | 45-58 | The confirmation gate: the agent stops before the final consequential action and asks; click confirm; done state | the user disposes; nothing consequential is automatic |
| 6 | 58-62 | End card: extension ID + "local keys · exact-origin permissions · confirmation gates" | the trust model in one line |

## After the take

- Export MP4 (H.264) and a lightweight GIF of scenes 3-5 for the README.
- File names: `assets/agent-run-60s.mp4`, `assets/agent-run.gif`.
- Check every frame once at 0.5x for anything personal before publishing.
