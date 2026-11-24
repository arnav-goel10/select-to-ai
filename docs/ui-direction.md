# How Select to AI looks and moves

The agent does work for the user while they watch or look away. The interface has one job: make it obvious, at a glance, what the agent is doing, what it found, and when it needs them. Everything else stays quiet.

## Character

Calm, precise, quick. A well-made instrument, not a chat toy. Think of the restraint of a good code editor or a native macOS app: few colours, real type, nothing that moves without a reason.

The logo is a silver mark on graphite. It is never replaced or redrawn; the interface takes its palette from it.

## Colour

The palette is taken from the logo: a silver knot on a graphite tile. There is no hue in it except the four state colours, and no purple, violet or blue anywhere.

- **Dark is the logo tile.** Graphite surfaces with the tile's slight cool cast, and silver for what the user acts on.
- **Light is neutral paper.** Near-white and soft neutral greys, no warm or cool cast, with graphite ink for what the user acts on. Both themes are designed, not inverted from each other.
- **One accent, and it is ink.** Graphite in light, silver in dark. Primary buttons, the focus ring, selected chips and the agent's live state use it.
- **State colours,** quiet and the same everywhere: working (the accent, carried by a ringed dot that pulses and a soft shimmer on the current step), needs you (amber), done (green), stopped or failed (red). Each also has an icon and words, so colour is never the only signal.
- Colours are tokens in `extension/tokens.css`, one `light-dark()` pair each. Every page uses them; the quick box keeps a copy for the page it runs on.

| Token | Light | Dark | Used for |
|---|---|---|---|
| `--bg` | `#fafafa` | `#161719` | the page |
| `--surface` | `#ffffff` | `#1d1e21` | cards, the composer |
| `--surface-2` | `#f2f2f3` | `#2a2b2f` | boxes inside cards, the user's message |
| `--border-strong` | `#d3d3d8` | `#404146` | the composer at rest, neutral cards |
| `--control-edge` | `#86878c` | `#75777c` | a field's edge (3:1), the composer on hover |
| `--text` | `#17181b` | `#e9eaec` | body text, the current step |
| `--text-muted` | `#595a61` | `#b0b2b6` | what a step found |
| `--accent-fill` | `#25262a` | `#e6e7ea` | the primary button |
| `--needs` | `#a35a00` | `#eeb563` | needs-you text |
| `--needs-mark` | `#c77a12` | `#eeb563` | needs-you dot, stripe and icon only |
| `--done` | `#187a3b` | `#68cd8f` | done |
| `--failed` | `#c22826` | `#f17871` | failed |

Rules that come with it:

- A card that needs the user stands apart: an amber edge all round, an amber wash behind its heading and a stripe down the left. A neutral card (what to keep after a run) has none of these, only a stronger hairline.
- The composer and the popup's task box have one line: a hairline and a shadow at rest, the field edge on hover, and on focus that edge becomes the 2 px accent ring. Lines never stack.
- Keyboard focus is a solid 2 px accent line with a 2 px gap.
- Small actions in a line of text (View, Undo, Not now, Show the tab) are in the text colour and underlined or outlined, so they look pressable without a hue.
- A chosen chip has a real fill and the field edge, not only a tick.
- An empty composer's send button is greyed, so empty and ready look different.
- `scripts/contrast.mjs` checks every text and control pair against WCAG AA in both themes, and `tests/unit/contrast.test.js` runs it.

## Type and space

- One sans family (the system UI font: SF Pro on Mac, Segoe on Windows), with tabular numbers for times and counts. A mono only for addresses and code.
- A small, fixed scale: 12, 13, 14, 16, 20, 28. Body at 14 in the panel.
- A 4-pixel spacing grid. Generous padding inside cards, tight rhythm inside lists.
- Corners: 10 for cards, 8 for controls, full round for pills. Borders are hairlines at low contrast; elevation comes from soft, layered shadows, used sparingly.

## Motion

Motion explains change and answers a press. It never decorates, and nothing moves on a timer for its own sake except the live dot and the shimmer, which say the agent is working.

One small system, as tokens in `tokens.css`, used by every page:

| Token | Value | For |
|---|---|---|
| `--dur-1` | 120 ms | a press, anything leaving, a card that needs the user arriving |
| `--dur-2` | 180 ms | things arriving: steps, the answer, cards, menus |
| `--dur-3` | 240 ms | height changes, the drawer, the page arriving |
| `--ease-out` | `cubic-bezier(0.22, 1, 0.36, 1)` | everything that arrives or eases |
| `--ease-spring` | `cubic-bezier(0.34, 1.32, 0.64, 1)` | a press letting go, a switch, send turning into stop |

- **Press.** Every button, chip and pill sinks to 96% at once on press and springs back on release. Primary buttons and suggestion chips lift 1 px on hover.
- **Arrive and leave.** Steps, cards and the answer rise 6 px and fade in. Things that leave fade and lift 4 px on the shortest duration (`leave()` in the page scripts).
- **Height.** A step's details, the run's steps and a sub-task's row open by animating their height (`interpolate-size` and `::details-content`, Chrome 129 and later; older Chrome opens them at once). The composer's height eases as it grows.
- **Views.** The task drawer on a wide page, a new task clearing the conversation and a Settings panel opening run as view transitions where Chrome has them, and as a plain change elsewhere. The popup slides toward the side panel as it hands a task over, and the agent page arrives with a short slide.
- **Live work.** The current step's words stay in full text colour with a soft band of light crossing them; the band is its own layer moved by transform. The live dot has a still ring, so a screenshot reads as working, and a pulse.
- **The answer** streams in with a soft caret after its last block.
- **Send and stop.** The send button turns into Stop: the arrow lifts away as the square grows in.
- **Only transform and opacity move.** No width, top or shadow is animated on anything large, so the compositor does the work.
- **Reduce motion** turns every animation, transition and view transition into an instant change.

The page also keeps its work per update small, so streaming stays smooth: finished blocks of the answer are rendered once and kept, only the block being written is drawn again, streamed text is drawn at most once a frame, the composer's button is not rebuilt on each update, the tab's address is asked for only when it may have changed, and reopening the panel redraws a run in one go with no animation and one scroll.

## The run, which is the product

The run view replaces the raw log. It reads top to bottom as a story:

1. **The request,** as the user wrote it.
2. **A live header** while it works: the current goal in plain words, the site it is on with its favicon, elapsed time, and Stop. One line, always visible.
3. **Steps** as a quiet timeline: each a single line (an icon for the kind of action, a short description, the site on a wide page), with what it found or changed underneath in muted text, in plain words: the control by its name and the site by its host, never an element number or a tracking address. The current step has a sub-line saying what it is doing now, and shimmers. Detail (the raw actions and results, with times) is behind one chevron at the end of the step's line, closed by default.
4. **Moments that need the user** (approval, sign-in, human check, check-in after a while, a pause for a rate limit) appear as a distinct card with the amber edge, the decision in one sentence, and two clear buttons. It says each thing once: the second check's own row gives way to the card, and the card leaves out a button name or step aim already on screen. Its first button takes focus. Nothing else on screen competes with it.
5. **The answer** as a clean document: headings, lists and tables rendered well, sources as small chips linking to the pages, and a quiet line when part of it could not be confirmed.
6. **After the run:** one row under the answer (the pages it used, what it knew from memory, the user's thumbs up or down, Save as recipe) and at most one card (what it remembered or learned, and what it offers to keep).

The side panel and the full-page panel are the same view at two widths. The narrow one hides the history list behind a button; nothing else changes.

## Surfaces

- **Composer:** one field that grows with the text, the send button inside it, the model and provider as a small pill the user can change from there. Suggestions appear as chips above it on an empty state.
- **History:** recent tasks with their outcome dot and when they ran. Running again is one click.
- **Settings:** grouped cards, as now, with the same tokens; plain explanations under each control.
- **Welcome:** three steps at most, with the agent's value shown, not described.

## Quality bar

- Every state has been drawn: empty, working, needs you, paused, done, unconfirmed, failed, offline, no key.
- Keyboard first: everything reachable and visible focus rings. Escape backs out (a menu, the drawer, the typed text) and stops a run only on a second press. Dialogs keep focus inside them.
- A screen reader hears a step when it starts, a wait when it begins and the end of the run, never a half-written goal.
- A reopened panel never flashes the empty state before the run it is showing.
- Contrast meets WCAG AA in both themes.
- No layout shift while the agent works.
- It looks right at 360 px wide and at 1440.
