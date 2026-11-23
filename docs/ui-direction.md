# How Select to AI looks and moves

The agent does work for the user while they watch or look away. The interface has one job: make it obvious, at a glance, what the agent is doing, what it found, and when it needs them. Everything else stays quiet.

## Character

Calm, precise, quick. A well-made instrument, not a chat toy. Think of the restraint of a good code editor or a native macOS app: few colours, real type, nothing that moves without a reason.

The logo is a silver mark on graphite. It is never replaced or redrawn; the interface takes its palette from it.

## Colour

- **Neutral base.** Graphite and warm greys in dark mode, near-white paper with soft grey surfaces in light mode. Both are designed, not inverted from each other. Dark is first-class.
- **One accent, and it is ink.** Used only for what the user can act on now and for the agent's live state. It has no hue, like the logo: graphite ink in light mode, silver in dark mode. Primary buttons, focus rings and selected states all use it. No purple, violet or blue anywhere.
- **State colours,** quiet and consistent everywhere: working (the ink accent, carried by a pulsing dot and the shimmer on the current step), needs you (amber), done (green), stopped or failed (red). Each also has an icon and words, so colour is never the only signal.
- Colours are defined once, as tokens, in one shared stylesheet that every page uses: panel, side panel, options, welcome, popup.

## Type and space

- One sans family (the system UI font: SF Pro on Mac, Segoe on Windows), with tabular numbers for times and counts. A mono only for addresses and code.
- A small, fixed scale: 12, 13, 14, 16, 20, 28. Body at 14 in the panel.
- A 4-pixel spacing grid. Generous padding inside cards, tight rhythm inside lists.
- Corners: 10 for cards, 8 for controls, full round for pills. Borders are hairlines at low contrast; elevation comes from soft, layered shadows, used sparingly.

## Motion

Motion explains change; it never decorates.
- Things that appear slide 4 to 8 pixels and fade in, 180 to 220 ms, ease-out. Things that leave fade out faster, about 120 ms.
- Height changes (a step expanding, a card opening) animate their height, never jump.
- Live work shows as a slow, soft shimmer on the current step and a pulsing dot, not a spinner.
- The answer streams in as it is written, with a soft caret.
- Respect "reduce motion": every animation becomes an instant change.
- Nothing animates on a timer for its own sake.

## The run, which is the product

The run view replaces the raw log. It reads top to bottom as a story:

1. **The request,** as the user wrote it.
2. **A live header** while it works: the current goal in plain words, the site it is on with its favicon, elapsed time, and Stop. One line, always visible.
3. **Steps** as a quiet timeline: each a single line (an icon for the kind of action, a short description, the site), with what it found or changed underneath in muted text. The current step shimmers. Detail (what the model saw, timings, the raw result) is behind a disclosure, closed by default.
4. **Moments that need the user** (approval, sign-in, human check, check-in after a while, a pause for a rate limit) appear as a distinct card with the accent or amber edge, the decision in one sentence, and two clear buttons. Nothing else on screen competes with it.
5. **The answer** as a clean document: headings, lists and tables rendered well, sources as small chips linking to the pages, and a quiet line when part of it could not be confirmed.
6. **After the run:** what it learned (if anything), offered for the user to keep or discard, in one line each.

The side panel and the full-page panel are the same view at two widths. The narrow one hides the history list behind a button; nothing else changes.

## Surfaces

- **Composer:** one field that grows with the text, the send button inside it, the model and provider as a small pill the user can change from there. Suggestions appear as chips above it on an empty state.
- **History:** recent tasks with their outcome dot and when they ran. Running again is one click.
- **Settings:** grouped cards, as now, with the same tokens; plain explanations under each control.
- **Welcome:** three steps at most, with the agent's value shown, not described.

## Quality bar

- Every state has been drawn: empty, working, needs you, paused, done, unconfirmed, failed, offline, no key.
- Keyboard first: everything reachable and visible focus rings.
- Contrast meets WCAG AA in both themes.
- No layout shift while the agent works.
- It looks right at 360 px wide and at 1440.
