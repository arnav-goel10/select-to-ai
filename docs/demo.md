# Screenshots and demo material

This page says where the repository's images come from. It is not a demo. For a tour of what the agent does, with real traces, read [walkthrough.md](walkthrough.md).

## Current screenshots

The images in `assets/store/` (the README uses `3-agent-result.png`) come from the `screenshots` job in `.github/workflows/ci.yml`. The job loads the packed build, not the source tree, in Chromium under xvfb at 1280x800. It drives the agent with the scripted model server in `tests/e2e/server.js` and uploads the PNGs as the `store-screens` artifact on every CI run. It fails on a console error, the text "undefined", an em dash in page text, or a wrong image size. So the screenshots show the code as it was built, with a scripted model in place of a real one.

## The 2.0 overview image

`assets/select-to-ai-overview.png` is older. It is the first screenshot from the 2.0 Chrome Web Store listing, which shows right-click sending ("Open ChatGPT with Selected Text"), and it shows nothing of the agent. Nothing in the repository links to it now. How it was made:

1. Taken from the public [Select to AI listing](https://chromewebstore.google.com/detail/select-to-ai/ifofkleafhmamganjnoaaipdmffifcgc?hl=en) (extension ID `ifofkleafhmamganjnoaaipdmffifcgc`, offered by `arnavprak`), accessed 11 Aug 2026.
2. Checked for any API key, email, account data, browsing history, private prompt or notification. There were none.
3. The 1280x800 source pixels were kept as they were and centred on a white 1600x900 canvas, with no scaling, cropping or redrawing.

When it was accessed, the listing showed version 2.0, the Featured badge and 977 users. That is the source of "approximately 1,000 users" in the README.

## Video

No video of the agent has been recorded yet. [demo-recording.md](demo-recording.md) is the script for one.
