# First-run screenshots (4.0.0)

Taken on 10 Nov 2026 by `npm run test:first-run` (`tests/e2e/first-run.js`), which builds the store zip, unzips it and loads it in a fresh Chromium profile. 9 of 9 checks passed.

| File | What it shows |
|---|---|
| 01-welcome.png | The page Chrome opens on install. OpenRouter is offered, the ChatGPT plan is not, and the quick box key is read from Chrome (Control+Shift+Q on a Mac). |
| 02-popup.png | The toolbar popup. |
| 03-settings.png | Settings. |
| 04-asks-for-site-access.png | The agent asked to work on Wikipedia before any site is allowed: it asks for that site or all sites. |
| 05-hacker-news.png | "What's the top story on Hacker News right now?" answered from the live page. |
| 06-wikipedia-search.png, 06b-wikipedia-after-search.png | "Search Wikipedia for Ada Lovelace and tell me when she was born." The agent typed into Wikipedia's own search box, pressed Enter, read the article and answered 10 December 1815. |
| 07-github-trending.png | "What is the top repository on GitHub Trending today?" answered from the live page. |

For 05 to 07 the three sites were allowed in a test copy of the manifest, because automation cannot click Chrome's permission prompt. The model is a scripted local gateway that picks each step from the page text the extension sends it. These screens show the extension's own flows on live sites, not how well a model does. They are not store screenshots of a real model run; those need a real provider key.
