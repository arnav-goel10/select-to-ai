# @recipes/core

**Playwright automations that prove they finished, and stop instead of guessing when a site changes what a step means.**

> Working name. The final package name is not decided yet.

Record a Playwright run once. Replay it with no model. When the site changes, Recipes repairs the broken step under a contract, re-checks the rest of the run before it saves the repair, and ends every run with a receipt. When a step's meaning has changed, it stops and tells you why.

Browser automations break in two ways. The loud way is a selector that stops matching, so the script throws. Self-healing locators fix that. The quiet way is worse: the selector still matches, but the control now does something else. "Save draft" was removed and **Discard** took its id. The confirm dialog now publishes to every customer. The amount column is now in thousands. The script clicks through, reports success, and nobody finds out until a customer does. Recipes is built for the quiet way.

## Quickstart (30 seconds, no API key)

```bash
mkdir try-recipes && cd try-recipes && npm init -y && npm pkg set type=module
npm install @recipes/core playwright
npx playwright install chromium
```

Save this as `quickstart.js`. It uses a small app that ships with the package, so you can change the site under the recipe.

```js
import { chromium } from "playwright";
import { record, replay } from "@recipes/core";
import { startApp } from "@recipes/core/demo-app";

const app = await startApp();               // a small local app that we can change
const browser = await chromium.launch();
const page = await browser.newPage();

// 1. Record your Playwright steps once. "first note" becomes the variable {note}.
const recipe = await record(page, async (r) => {
  await r.page.goto(`${app.url}/draft`);
  await r.page.fill("#note", "first note");
  await r.page.click("#save");
  await r.page.click("#confirm");
}, { vars: { note: "first note" } });

// 2. Replay with a new value. No model is called.
let receipt = await replay(page, recipe, { vars: { note: "Ship it Friday" } });
console.log(receipt.end.state);             // done_proven

// 3. The site changes: the same dialog, same ids, now publishes to every customer.
await app.setSite("publish");
receipt = await replay(page, recipe, { vars: { note: "Ship it Friday" } });
console.log(receipt.end.state);             // needs_you
console.log((await app.truth()).events);    // [] : nothing was published
console.log(receipt.end.why);

await browser.close();
await app.close();
```

```console
$ node quickstart.js
done_proven
needs_you
[]
step s4 (click the control "Save draft"): the words around it changed (section heading: "Save this draft?" is now "Publish this draft?"; dialog: ... notes and headings near it: ... "Publishing sends this note to every customer on your mailing list. It cannot be undone." ...); with no model to check the meaning, a person should look
```

Plain Playwright runs the same four lines on that page and publishes the note. A recipe is plain JSON: save it with `JSON.stringify(recipe)` and commit it next to your code.

To repair cosmetic changes as well, give `replay` a model:

```js
import { anthropicModel } from "@recipes/core/anthropic";   // npm install @anthropic-ai/sdk
await replay(page, recipe, { vars, repair: { model: anthropicModel() } });   // reads ANTHROPIC_API_KEY
```

## What happens when the site changes

Every row below was run, and the server's own record decides what really happened. The first four are `npm run demo` (about 30 seconds). The last two are the example portal in `examples/fixtures/`.

| Change to the site | Plain Playwright | Self-healing locator (healwright) | Recipes |
|---|---|---|---|
| Nothing changed | saved | saved | **Done**, 0 model calls |
| Every id renamed, labels reworded | timed out | saved | **Done**, 2 model calls |
| "Save draft" removed, **Discard** took its id | discarded the draft | discarded the draft | **Stopped**, nothing changed |
| Same buttons and ids, the dialog now publishes to every customer | published | published | **Needs you**, nothing changed |
| "Submit claim" became "Submit and pay", same id, and now pays out | paid it out | paid it out | **Needs you**, nothing submitted |
| Amount column now "Amount (USD thousands)" | returned "5.01" for 5,007.50 | returned "5.01" | **Needs you**, no value returned |

One case goes the other way on purpose. When a submit, send, pay or delete button is reworded ("Sign in" to "Log in"), Recipes stops for your approval every time. healwright repairs those, and scores higher than Recipes on them in the benchmark.

## How it works

**1. Record.** Run your existing Playwright script through `r.page`. Each step is stored with a contract:

| Part of the contract | Example |
|---|---|
| Intent | `click the control "Save draft"` |
| Class | `read`, `edit` or `commit` (submits a form, or sends a POST, PUT or DELETE) |
| Fingerprint | role, name, label, test id, container, heading, table column, neighbours, position, plus your own locator as evidence |
| Success check | what changed when you recorded it: the URL, a field's value, a dialog that appeared, a confirmation message. A check that was already true before the step is dropped. |
| Meaning | the words around the control: headings, the dialog it sits in, its column header, help text and warnings nearby, and for a value you read, its label and unit |

**2. Replay with no model.** Each control is found by fingerprint. A match counts only above a score threshold *and* with a clear margin over the runner-up, so two equal candidates are never guessed between. If the words around the control are unchanged, the step runs and its success check must hold. That is every step of a normal run, so a normal run makes zero model calls.

**3. Repair or stop.** If the words around a step changed, one small model call asks whether the step still means the same thing. Anything but a clear "same" stops the run as `needs_you`. If a control can't be found or its check fails, the model may retarget that one step, insert one step (such as closing a banner) or page through a list. It can't change what the step does, its values or its success check. The repair is kept only if that step's check passes **and every later step passes too**. Commit steps (submit, send, pay, delete) need their exact recorded label and are never retargeted without your `approve()`.

## The receipt

Every `replay()` returns a receipt. `done_proven` means every step's check and the end check held, and the receipt says what was seen as proof.

```console
$ npx recipes receipt receipt.json
NEEDS YOU  open http://127.0.0.1:56166/draft, put "Ship it Friday" in the control "Note", click the control "Save draft"
receipt rpl_73e868a953173eaf · recipe rcp_ab15e291c49753ec v1
values: note = "Ship it Friday"

  ok    1. open http://127.0.0.1:56166/draft
             held: page (http://127.0.0.1:56166/draft)
  ok    2. put "{note}" in the control "Note" [exact 0.947]
             held: value (Ship it Friday)
  ok    3. click the control "Save draft" [exact 1]
             held: appears (Keep editing (0.90))

Why it stopped
  step s4 (click the control "Save draft"): the words around it changed (section heading: "Save
  this draft?" is now "Publish this draft?"; ...); with no model to check the meaning, a person
  should look

0 model calls, $0 · meaning checks: 1
```

`npx recipes receipt receipt.json --md` prints the same receipt as Markdown, for a CI job summary or a pull request.

| Field | What it holds |
|---|---|
| `end.state` | `done_proven`, `needs_you`, `stopped`, `done_unproven` or `failed` |
| `end.why`, `end.proof` | why the run ended, or what was observed as proof: text, URL, values read, files downloaded with their sha256 |
| `steps[]` | how each control was found (`exact`, `fingerprint`, `repair`), its score and margin, each check and what it saw |
| `repairs[]` | each repair tried, its outcome, and the change written out in words |
| `extracts`, `downloads` | values read with `r.read()`, files saved with `r.download()` |
| `cost` | model calls, tokens and dollars (zero on an unchanged run) |
| `healed`, `recipe` | after a verified repair, `healed` is true and `recipe` is the new version to save |

`needs_you` is a normal outcome, not an exception. It means a person should look at one step before anything else happens.

## Numbers

We measure on a benchmark built for this: 8 fixture web apps, 24 tasks, about 100 site changes. Success is judged only by each app's own server record, never by what a tool reports. Each held-out set was written separately from the engine, run once on frozen code, then retired. Repairs and meaning checks use Claude Haiku 5.5.

Held-out v3, the latest (192 runs per system):

| | Recipes | healwright (default) | Plain Playwright (fixed selectors) |
|---|---|---|---|
| Stopped when the meaning changed | **30 of 30** | 2 of 30 | 2 of 30 |
| Reported "done" when it wasn't | **0%** | 18.8% | 18.8% |
| Wrong actions (discarded, published, wrong record) | **0%** | 13.5% | 13.5% |
| Repairable changes handled | **77%** | 70% | 53% |
| Repair coverage of breaking changes | **56%** [42–68] | 37% | 0% |
| Model cost per run | $0.00014 | $0.00014 | 0 |

**False-heal rate:** 0 of 46 Recipes repairs across the three held-out sets went to the wrong element (0/23, 0/3, 0/20). healwright's default setting: 19 of 131 (13/63, 6/43, 0/25).

Across all three sets:

| | v1 | v2 | v3 |
|---|---|---|---|
| Repair coverage, Recipes / healwright | 53% / 42% | 51% / 50% | 56% / 37% |
| Reported "done" when it wasn't | 0.5% / 11% | 7.1% / 18.8% | 0% / 18.8% |
| Wrong actions | 1.0% / 8.6% | 3.5% / 10.6% | 0% / 13.5% |
| Stopped when the meaning changed | 92% / 15% | 54% / 15% | 100% / 7% |

What these numbers don't show:

- **They are fixture apps, not real sites.** Real-site drift, measured across real version upgrades, is next.
- **v2 had real failures.** 7.1% false "done" and 3.5% wrong actions, all from subtle changes of meaning. The meaning check was built after v2 and has been measured on v3 only.
- **healwright handled more repairable changes on v1 and v2** (59% vs 54%, 62% vs 50%). Recipes leads on v3.
- **Small denominators.** The coverage interval on v3 is 42–68%, and 0 of 46 is not a guarantee.
- **One model.** Other models are untested.

Full reports: [held-out v1](https://github.com/OWNER/REPO/blob/main/docs/results-heldout-v1.md), [v2](https://github.com/OWNER/REPO/blob/main/docs/results-heldout-v2.md), [v3](https://github.com/OWNER/REPO/blob/main/docs/results-heldout-v3.md).

## Compared with

| | Recipes | Self-healing locators (healwright and others) | Browser agents (Browser Use, Stagehand and others) |
|---|---|---|---|
| Model calls on a normal run | 0 | 0 | one or more per step, unless cached |
| When a selector breaks | repairs that step, checks it, re-checks the rest of the run | finds the element you probably meant | re-plans from the description |
| When the selector still matches but the meaning changed | stops (`needs_you`) | acts | depends on the model noticing |
| How "done" is decided | every step's recorded check, plus an end check | the script didn't throw | the model says so |
| Submit, send, pay, delete | exact label, or your approval | healed like any other step | the model decides |
| Output | a receipt, and a new recipe version after a verified repair | a cached locator | a transcript |

Self-healing locators answer "which element did you mean?". Recipes also asks "does this step still do what it did when you recorded it?", and checks the answer against the page. Agents are the right tool for a task you have never done. Recipes is for the task you run every day and need to trust.

## Limits

- Recipes is a Node library for Playwright. Python and Puppeteer are not supported.
- Drag and drop, file uploads, coordinate clicks and closed shadow roots are not supported.
- A recipe is a fixed sequence of steps. Loops and branches stay in your code: call `replay()` once per item.
- A recipe is tied to the site it was recorded on. A run that leaves those sites fails.
- Reworded commit buttons always stop for your approval. That is deliberate, and it costs coverage.
- Repairs and meaning checks have been measured with Claude Haiku 5.5 only.

## FAQ

**Do I need an API key?**
No. Without a model, unchanged runs pass, and any step whose control or surroundings changed stops as `needs_you`. With a model, cosmetic changes are repaired and meaning changes still stop.

**How much does the model cost?**
Nothing on an unchanged run. On a changed page, a meaning check or a repair is one Haiku call, usually a fraction of a cent. The demo's four scenes cost under $0.001 in total.

**Where do passwords go?**
Not in the recipe. Pass `secrets: {}` to `record()`, and any password, card number or one-time code typed during recording is moved there instead. Give them back in `vars` at replay. Receipts show them as `(secret)`.

**Can I use another model?**
Yes. A model is any object with `complete({ system, user, schema })` that returns `{ json, usage }`. `examples/custom-model.js` has an OpenAI-compatible client. Published numbers use Haiku 5.5 only, so measure on your own pages first.

**What does a repair change in my recipe?**
Only the step that broke: a new target, one inserted step, or a page-through. The repaired recipe comes back in `receipt.recipe` as a new version, with the change written out in `receipt.repairs`. Your saved file changes only if you save it.

**Does it work inside Playwright Test?**
Yes. See `examples/playwright-test/`. The test fails with the receipt's reason, and the receipt is attached to the report.

**Why does it stop when a person would have clicked through?**
Because a wrong click on submit, send or delete costs more than a stopped run. The receipt tells you exactly which words changed, so the review takes seconds.

## Reference

`record(page, script, { vars, secrets, title })` runs `script(r)` once and returns a recipe. Use `r.page` like a normal Playwright Page, or the recorder's own verbs. `t` is a Locator or a selector.

- `r.goto(url)`, `r.back()`
- `r.click(t)`, `r.hover(t)`
- `r.fill(t, value)`, `r.select(t, value)`, `r.check(t)`, `r.uncheck(t)`
- `r.press(t, key)` or `r.press(key)`
- `r.read(t, name)` reads a value into `receipt.extracts[name]`
- `r.download(t)` saves a file and records its sha256
- `r.expectText(text)` adds an end check

A literal equal to one of `vars` becomes that variable, or write `"{name}"` yourself.

`replay(page, recipe, { vars, repair: { model, approve, maxRepairs } })` returns a receipt. Repair is off unless you pass a model. `approve(proposal)` is called before a commit step is retargeted.

CLI:

```bash
npx recipes receipt receipt.json [--md]   # print a receipt
npx recipes validate my.recipe.json       # check a recipe file
```

The core reaches the browser only through the `RecipeDriver` interface in `index.d.ts`, so other drivers can be added. The Select to AI Chrome extension uses the same core to save its own agent runs as recipes.

## Examples

Run them from `packages/recipes` after `npm install`. They need no API key; set `ANTHROPIC_API_KEY` to see repairs.

| Example | What it shows |
|---|---|
| [`examples/login-form.js`](examples/login-form.js) | sign in and submit a form; the password stays out of the recipe; a form that now pays out on submit stops |
| [`examples/scrape-paginated.js`](examples/scrape-paginated.js) | read values from a row on any page of a list; a column that changed its unit stops instead of returning a wrong number |
| [`examples/ci/`](examples/ci) | a GitHub Actions workflow that replays a saved recipe every hour, uploads the receipt, and fails unless it is `done_proven` |
| [`examples/playwright-test/`](examples/playwright-test) | replay inside Playwright Test, with the receipt attached to the report |
| [`examples/standalone.js`](examples/standalone.js) | record to a file, replay later, keep the receipt and any verified repair |
| [`examples/custom-model.js`](examples/custom-model.js) | an OpenAI-compatible model client |
| [`examples/demo/`](examples/demo) | the side-by-side demo: plain Playwright, healwright and Recipes on four versions of one site (needs `ANTHROPIC_API_KEY` and `npm install healwright`) |

## Tests

```bash
npm test                     # unit and real-browser integration tests
RECIPES_LIVE=1 npm test      # adds live calls to the Anthropic API
```

## License

MIT
