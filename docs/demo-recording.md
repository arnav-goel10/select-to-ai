# Recording script: 60-second agent run

The clip this script produces fills two slots: the demo player on the
[arnavg.com](https://www.arnavg.com/#/work/select-to-ai) case study and a README embed here. One take, no
narration needed, captions carry the story.

## Ground rules

- Fresh Chrome profile, no personal accounts, no bookmarks bar, default theme.
- The API key entered on camera must be a dummy or revoked immediately after.
- Only public pages on camera (use Wikipedia and example.com, and a public practice form page for scene 5). No mail, no
  chats, no history, no notifications: enable Do Not Disturb.
- 1280×800 window, 60fps screen recording, cursor visible. Target 55-65s.

## Scene list

| # | Seconds | On screen | The point it proves |
| --- | --- | --- | --- |
| 1 | 0-8 | Select a paragraph on a Wikipedia article, right-click, "Open ChatGPT with Selected Text"; the provider opens with the text in place | the original product: selection to model, zero copy-paste |
| 2 | 8-18 | Open the agent page, type a bounded cross-tab task (e.g. "collect the population figures from these two open tabs into a list") | task input, plain language |
| 3 | 18-30 | The "Let the agent use this site?" card appears the first time the agent needs a site; choose **Only** followed by the site's name | site access is asked for one site at a time, not all at once |
| 4 | 30-45 | Steps appear one by one in the panel, each with its goal, the action and what the page did; hover the cost line under the task box | read, act, read again; each result is what the page showed |
| 5 | 45-58 | The approval card: before a step that sends, submits, deletes or spends money, the run stops and asks; click **Allow this step**; the answer appears with the pages it used | nothing consequential happens without the user's yes |
| 6 | 58-62 | End card: extension ID + "local keys · exact-origin permissions · confirmation gates" | the trust model in one line |

## After the take

- Export MP4 (H.264) and a lightweight GIF of scenes 3-5 for the README.
- File names: `assets/agent-run-60s.mp4`, `assets/agent-run.gif`.
- Check every frame once at 0.5x for anything personal before publishing.
