/**
 * Select to AI - what the agent may do without asking.
 *
 * One question, one place: given an action the model chose, the page it is
 * on and what the run has been allowed so far, the answer is allow, confirm
 * (the user approves it in the panel), hand over (only the user can do it,
 * in the page), or refuse (told to the model as the result of its action).
 *
 * This is the part of the agent that stays rule-based on purpose. It reads
 * the page's structure and where an address came from, never the model's
 * reasons, so nothing a page says can talk it round. A press the page's
 * structure does not settle is decided by what a check that is shown only
 * the control's markup names said of it (run.opinions, by press entry);
 * until it has said, the verdict carries a `check` and the run waits for
 * the page's batch or asks it alone. A form of one box is held as a send
 * unless its own check says plainly that it asks. The step's own word
 * that a press commits (commits: true) holds it; its word that a press
 * does not commit grants nothing.
 *
 * Pure functions: no DOM, no chrome.* calls.
 */
(function initPolicy(root) {
  "use strict";

  const need = (name, file) => root[name] || (typeof require === "function" ? require(file) : null);
  const TOOLS = need("SELECT_TO_AI_TOOLS", "../agentTools.js");
  const SECURITY = need("SELECT_TO_AI_SECURITY", "../security.js");

  const ALLOW = Object.freeze({ verdict: "allow" });

  /**
   * What stands between the agent and the page, from the page's structure:
   * a human check, a sign-in form, a one-time code, card fields.
   */
  function blockersOf(page) {
    if (!page) return [];
    // The content script reads these from the page's structure; the listed
    // controls say the same for a page it could not look at that way.
    // A page is a sign-in wall when the form is most of what is on it.
    const wall = String(page.innerText || "").length < 1500 && (page.elements || []).length <= 12;
    const out = (page.blockers || []).map((b) => ({ kind: b.kind, whole: b.kind === "sign_in" ? wall : !!b.whole }));
    const has = (kind) => out.some((b) => b.kind === kind);
    if (!has("human_check") && TOOLS.isChallengePage(page)) out.push({ kind: "human_check", whole: true });
    const kinds = new Set((page.elements || []).map((el) => el.sensitive).filter(Boolean));
    if (kinds.has("password") && !has("sign_in")) out.push({ kind: "sign_in", whole: wall });
    if (kinds.has("code") && !has("code")) out.push({ kind: "code", whole: false });
    if (kinds.has("payment") && !has("payment")) out.push({ kind: "payment", whole: false });
    return out;
  }

  // What the user is asked to do when the agent reaches something only they can.
  const HANDOVER = Object.freeze({
    human_check: "This site wants to check that you're human. Please complete the check on the page.",
    sign_in: "This page needs you to sign in. Please sign in on the page; I can't see what you type.",
    code: "This page is asking for a code that was sent to you. Please enter it on the page.",
    payment: "This page is asking for payment details. Please enter them yourself on the page.",
    id: "This field asks for an identity number. Please enter it yourself on the page.",
  });

  /**
   * The site of a page the run went to by itself and the task does not
   * need, or "". The task's own sites are the ones the request names, the
   * one the run began on and the first web page it worked on. A page on
   * another site, opened by an address the agent wrote (a search engine,
   * say), is a detour: a human check there is no reason to stop and ask the
   * user, since the run can go back and answer from what it has read. A
   * page reached by a link or a redirect from the task's site is not, so a
   * check the task leads to is still the user's to pass. Whether the check
   * is left also depends on what the run has (run.js detourToLeave).
   */
  function detourSite(page, run) {
    const site = TOOLS.siteOf(String((page && page.url) || ""));
    if (!site || !run || !(run.wentTo || []).includes(site)) return "";
    // run.trust.sites holds the sites the request names (by domain or by a
    // well-known name), the start site, the tabs open at the start and any
    // site the user approved.
    const own = new Set([...TOOLS.sitesNamedIn(requestOf(run)), ...((run.trust && run.trust.sites) || [])]);
    if (run.startSite) own.add(run.startSite);
    const first = (run.history || []).find((h) => /^https?:/i.test(String(h.url || "")));
    if (first) own.add(TOOLS.siteOf(first.url));
    own.delete("");
    return own.size && !own.has(site) ? site : "";
  }

  // What the model is told when it would hand a detour's check to the user.
  const detourMessage = (site) => `Not handed to the user: this human check is on ${site}, a site you opened yourself that the request does not need. Leave it. Go back, or open a page on the site the task is about, and finish from what you have already read. Say in your answer what you could not confirm.`;

  // Keys that press what they land on: Enter (or Return) and Space, alone
  // or with modifiers held.
  // A key is judged as the page will be sent it: "Ctrl-Enter", "Mod-Enter"
  // and "ctrl+Return" are all Enter held with Control (agentTools.js
  // parseKeyCombo, which the content script presses keys through).
  const ENTER_KEY = /(^|\+)\s*(enter|return|numpadenter)$/i;
  const SPACE_KEY = /(^|\+)\s*(space|spacebar| )$/i;
  const comboOf = (key) => {
    try { return TOOLS.parseKeyCombo(String(key == null ? "" : key), false); } catch (_e) { return { key: String(key || ""), mods: {} }; }
  };
  const isEnter = (key) => ENTER_KEY.test(String(key || "")) || /^(enter|return|numpadenter)$/i.test(comboOf(key).key);
  const isSpace = (key) => SPACE_KEY.test(String(key || "")) || comboOf(key).key === " ";
  const activatingKey = (key) => isEnter(key) || isSpace(key);

  /**
   * True when a key, pressed in a text box the page leaves it to, puts
   * text into the box or takes text out of it: a character, Backspace or
   * Delete, or a paste or cut shortcut. On a Mac or elsewhere alike, so a
   * shortcut written for the other computer is judged too.
   */
  function writesText(key) {
    const c = comboOf(key);
    if (/^(enter|return|numpadenter)$/i.test(c.key)) return false;
    const m = c.mods || {};
    if ((m.ctrlKey || m.metaKey) && /^[vx]$/i.test(c.key)) return true;
    if (m.shiftKey && /^insert$/i.test(c.key)) return true;
    return [false, true].some((mac) => {
      const d = TOOLS.keyDefault(c.key, m, mac);
      return !!d && (d.kind === "text" || d.kind === "delete");
    });
  }

  /**
   * True when a key pressed on this control does what a click on it does:
   * Enter or Space on a button, a link, a box to tick, a submit input or a
   * control the page gives a pressable role. A text box is not one: Enter
   * there submits its form, and Space types a space.
   */
  function pressesControl(el, key) {
    if (!el || !activatingKey(key)) return false;
    const tag = String(el.tagName || "").toLowerCase();
    const type = String(el.inputType || "").toLowerCase();
    if (tag === "input") return /^(submit|button|image|reset|checkbox|radio)$/.test(type);
    if (tag === "textarea" || tag === "select") return false;
    return tag === "button" || tag === "a" || tag === "summary" || el.submits === true
      || /^(button|link|menuitem|menuitemcheckbox|menuitemradio|option|tab|checkbox|radio|switch)$/.test(String(el.role || ""));
  }

  /**
   * The listed controls a key press with no ref may land on: the one the
   * page reported as focused when it was read, and the control this step
   * last clicked, filled or pressed (focus stays where the agent put it, and
   * the page was not read again in between). Both are judged, and the
   * strongest answer holds. The content script presses the key only while
   * the focus is on one of these, or on nothing.
   */
  function pressLandsOn(a, page, run) {
    if (!a || a.do !== "press" || a.ref !== undefined || !(activatingKey(a.key) || writesText(a.key))) return [];
    const els = (page && page.elements) || [];
    const ids = els.filter((e) => e.focused).map((e) => e.id);
    const last = run && run.focusRef;
    if (last !== undefined && last !== null && els.some((e) => e.id === last) && !ids.includes(last)) ids.push(last);
    return ids;
  }

  // The actions that press the control they are given with the pointer.
  // Every rule for a click holds for each of them, here and nowhere else:
  // a new way to press a control goes in this list and inherits them all.
  const POINTER_PRESSES = Object.freeze(["click", "double_click", "right_click", "hold"]);

  /**
   * True when the action presses the control `el`: one of the pointer
   * presses, or a key that does what a click on it does.
   */
  function pressesOn(a, el) {
    if (!a) return false;
    if (POINTER_PRESSES.includes(a.do)) return true;
    return a.do === "press" && pressesControl(el, a.key);
  }

  /** The same action in the shape the risk checks in agentTools.js read. */
  function asRiskAction(a, el) {
    // A double click, a right click and a long press are presses on the control.
    if (POINTER_PRESSES.includes(a.do)) return { action: "click", id: a.ref };
    if (a.do === "fill" || a.do === "type") return { action: "type", id: a.ref, text: a.value };
    // A key that presses the control it lands on is a click on it.
    if (a.do === "press" && pressesControl(el, a.key)) return { action: "click", id: el.id };
    if (a.do === "press" && isEnter(a.key)) return { action: "keypress", id: a.ref, text: "Enter" };
    if (a.do === "navigate") return { action: "navigate", url: a.url };
    if (a.do === "tabs" && a.op === "open") return { action: "open_tab", url: a.url };
    return null;
  }

  /**
   * The listed control drawn at a point of the page (CSS pixels from the
   * page's top left corner), from where the scan saw each control: the
   * smallest whose box holds the point. `frame` is true when the point is
   * on a frame of the page whose inside the agent could not read, and
   * `check` when that frame is a human check.
   * @returns {el, frame, check}
   */
  function pointTarget(page, x, y) {
    const sx = Number(page && page.scrollX) || 0;
    const sy = Number(page && page.scrollY) || 0;
    let best = null;
    for (const el of (page && page.elements) || []) {
      const r = el.rect;
      if (!r || !(r.w > 0) || !(r.h > 0)) continue;
      const left = r.x + sx;
      const top = r.y + sy;
      if (x < left || x > left + r.w || y < top || y > top + r.h) continue;
      if (!best || r.w * r.h < best.rect.w * best.rect.h) best = el;
    }
    if (best) return { el: best, frame: false, check: false };
    const on = ((page && page.frameAreas) || []).filter((f) => x >= f.x && x <= f.x + f.w && y >= f.y && y <= f.y + f.h);
    return { el: null, frame: on.some((f) => !f.read), check: on.some((f) => f.check) };
  }

  /** Where a drag lets go, in page pixels: on its target, or its distance away from where it starts. */
  function dropPoint(a, page) {
    const els = (page && page.elements) || [];
    const sx = Number(page && page.scrollX) || 0;
    const sy = Number(page && page.scrollY) || 0;
    const middle = (el) => (el && el.rect ? { x: el.rect.x + sx + el.rect.w / 2, y: el.rect.y + sy + el.rect.h / 2 } : null);
    if (a.to_ref !== undefined) return middle(els.find((e) => e.id === a.to_ref));
    const from = middle(els.find((e) => e.id === a.ref));
    if (!from) return null;
    const d = Number(a.distance) || 0;
    const way = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[a.direction] || [0, 0];
    return { x: from.x + way[0] * d, y: from.y + way[1] * d };
  }

  // How strongly a verdict holds an action back, weakest first.
  const STRENGTH = (v) => (v.verdict === "refuse" ? 4 : v.verdict === "handoff" ? 3 : v.verdict === "confirm" ? 2 : v.check ? 1 : 0);

  /**
   * A drag or a press at a point carries the risk of a press on what it
   * lands on. Each control it presses or lets go on is decided as a click
   * on that control, and the strongest answer holds: a drop on a delete
   * box is a delete, a press at a point on a pay button is a payment, a
   * knob that says it pays when slid across is a payment. A point on a
   * frame the agent cannot read could be anything there, so it is the
   * user's to allow.
   */
  function decidePointer(a, page0, run, settings, store) {
    const refs = [];
    let blind = false;
    let page = page0;
    if (a.do === "drag") refs.push(a.ref);
    // A place to let go named by its words is decided as a press on a
    // control with those words: a bin that says "Delete forever" is a delete.
    if (a.do === "drag" && a.to_text !== undefined) {
      const named = { id: -1, tagName: "div", text: String(a.to_text), accName: String(a.to_text) };
      page = { ...(page0 || {}), elements: [...((page0 && page0.elements) || []), named] };
      refs.push(named.id);
    }
    const at = a.do === "click_at" ? { x: a.x, y: a.y } : a.to_ref !== undefined || a.to_text !== undefined ? null : dropPoint(a, page);
    if (a.do === "drag" && a.to_ref !== undefined) refs.push(a.to_ref);
    if (at) {
      const hit = pointTarget(page, at.x, at.y);
      // A check that a person is visiting is the person's to pass.
      if (hit.check) return { verdict: "handoff", kind: "human_check", question: HANDOVER.human_check };
      if (hit.el) refs.push(hit.el.id);
      else if (hit.frame) blind = true;
    }
    if (blind && !(settings && settings.riskConfirmation === false)) {
      return { verdict: "confirm", kind: "frame", why: "This presses a spot inside a frame another site draws on this page. The agent cannot read what is there, so it could pay, send or delete something.", detail: [] };
    }
    let strongest = ALLOW;
    for (const ref of [...new Set(refs)]) {
      const v = decide({ do: "click", ref }, page, run, settings, store);
      if (STRENGTH(v) > STRENGTH(strongest)) strongest = v;
    }
    return strongest;
  }

  /**
   * A drop on a place named by its words was judged by those words. The
   * place the page found holds `found`, all the words written on it: when
   * a drop there is judged more strongly than on the words given ("forever"
   * on a bin that says "Delete forever"), the drop is refused, and the model
   * is told to name the place by all its words, which is then decided, and
   * approved or not, the usual way. Null when the place is no riskier.
   */
  function placeRiskier(a, found, page, run, settings, store) {
    if (!a || a.do !== "drag" || a.to_text === undefined) return null;
    const words = String(found || "").replace(/\s+/g, " ").trim().slice(0, 200);
    if (!words) return null;
    const given = decidePointer(a, page, run, settings || {}, store);
    const there = decidePointer({ ...a, to_text: words }, page, run, settings || {}, store);
    const level = (v) => (v.verdict === "refuse" ? 4 : v.verdict === "handoff" ? 3 : v.verdict === "confirm" ? 2 : 0);
    if (level(there) <= level(given)) return null;
    return { verdict: "refuse", message: `The place with "${String(a.to_text).slice(0, 60)}" on it says "${words.slice(0, 120)}" in full, and a drop there is judged by all of it. Nothing was dragged. Drag again with to_text set to all of its words, or with to_ref.` };
  }

  /**
   * @param a        a checked action (step.js)
   * @param page     the current observation
   * @param run      the run: task, trust {sites, urls}, openedTabs,
   *                 opinions (second opinions by key), typed (text put in boxes this step, by ref)
   * @param settings {riskConfirmation, allowlist}
   * @param store    the user's memory (saved details, consents)
   * @param tabs     the tab list the run is shown: [{id, url, current}]
   */
  /**
   * The user's own words for the run. A sub-task's instruction was written
   * by the model that handed it out, so it is held to the request the user
   * made: what that request names, allows and forbids.
   */
  const requestOf = (run) => String((run && (run.request || run.task)) || "");

  // Actions that only look: they change nothing, so a declined control may still be read.
  const LOOKS = new Set(["hover", "scroll", "read", "look", "find", "wait", "recall"]);
  const addressOf = (url) => String(url || "").split("#")[0];
  // A control as the user saw it: its words and the row they sit in, since
  // refs are renumbered when the page is redrawn and two rows may each have a "Remove".
  const controlKey = (el) => (el ? `${TOOLS.elementLabel(el)}\u0001${el.group || ""}` : "");
  const opensUrl = (a) => (a.do === "navigate" || (a.do === "tabs" && a.op === "open") ? addressOf(a.url) : "");

  /**
   * What an action the user declined touched: the controls it pressed,
   * typed into, dragged or let go on, a key's landing place and a point's
   * control, and the address it would open. Kept by the run (run.declined)
   * until the user says something new.
   */
  function declinedMark(a, page, run) {
    const els = (page && page.elements) || [];
    const refs = [a.ref, a.to_ref, ...(a.landsOn || [])].filter((r) => r !== undefined && r !== null);
    if (a.do === "click_at" || (a.do === "drag" && a.to_ref === undefined)) {
      const at = a.do === "click_at" ? { x: a.x, y: a.y } : dropPoint(a, page);
      const hit = at ? pointTarget(page, at.x, at.y) : null;
      if (hit && hit.el) refs.push(hit.el.id);
    }
    const found = refs.map((r) => els.find((e) => e.id === r)).filter(Boolean);
    const labels = (run && run.labels) || {};
    const names = [...new Set([...found.map(TOOLS.elementLabel), ...refs.map((r) => labels[r]).filter(Boolean)])];
    const rows = [...new Set(found.map((e) => e.group).filter(Boolean))];
    // A link pressed is its address opened, so opening that address another way is the same step.
    const links = found.filter((e) => TOOLS.pressKind(e) === "link").map((e) => { try { return addressOf(new URL(String(e.url || e.href), (page && page.url) || undefined).href); } catch (_e) { return ""; } });
    const urls = [...new Set([opensUrl(a), ...links].filter(Boolean))];
    return { page: addressOf(page && page.url), keys: [...new Set(found.map(controlKey))], names, rows, urls };
  }

  /**
   * The declined step an action would reach again, or null: its control
   * (by its words and row, so a redraw's new ref is the same control) on
   * the same page, or its address.
   */
  function declinedAgain(a, el, page, run) {
    const gone = (run && run.declined) || [];
    if (!gone.length || LOOKS.has(a.do)) return null;
    const here = addressOf(page && page.url);
    const key = controlKey(el);
    const url = opensUrl(a);
    return gone.find((d) => (key && d.page === here && d.keys.includes(key)) || (url && d.urls.includes(url))) || null;
  }

  /**
   * Every action is decided here. The user has just declined a step: until
   * they say something new, any action that reaches what they declined is
   * theirs to allow again, however the rules would judge it alone. "No" is
   * to the result, so a key pressed on the same control (Delete, Enter), a
   * press at its spot, a drag onto it or the same address opened another
   * way does not get round it. Actions decided by parts (a drag, a press at
   * a point, a key with no ref) come back through here for each part, and
   * a new action is held to this as well.
   */
  function decide(a, page, run, settings, store, tabs) {
    let v = judge(a, page, run, settings, store, tabs);
    // With confirmations off nothing is held for approval, so no press is
    // looked up or waited on either.
    if ((settings || {}).riskConfirmation === false) return v;
    // Opening a link's own address is pressing that link another way: it
    // is decided as a press on it too, and the stronger answer holds. A
    // link the check said commits is held however it is opened.
    const link = STRENGTH(v) < 2 ? linkOpened(a, page, run) : null;
    if (link) {
      const asPress = link.ref !== undefined ? decide({ do: "click", ref: link.ref }, page, run, settings, store, tabs) : entryVerdict(link.entry, run, link.entry.names[0] || a.url);
      if (STRENGTH(asPress) > STRENGTH(v)) v = asPress;
    }
    if (STRENGTH(v) > 2) return v;
    // The step said this press commits the user to something: it is held,
    // whatever the check said. Saying it does not commits grants nothing.
    if (a.commits === true && v.verdict === "allow" && pressing(a)) {
      v = { verdict: "confirm", kind: "decide", why: TOOLS.RISK_TEXT.declared, detail: [] };
    }
    // A key with no ref lands where the focus is: on the control the page
    // shows focused, or the one this step last used.
    const els = (page && page.elements) || [];
    const on = a.ref !== undefined ? els.filter((e) => e.id === a.ref)
      : a.do === "press" ? els.filter((e) => e.focused || (run && e.id === run.focusRef)) : [];
    const hit = [...on, null].map((el) => declinedAgain(a, el, page, run)).find(Boolean);
    if (!hit) return v;
    const what = hit.names[0] || hit.urls[0] || "that step";
    const said = `You declined "${String(what).slice(0, 80)}" a moment ago. This would do it again${a.do === "click" ? "" : " another way"}.`;
    if (v.verdict === "confirm") return { ...v, detail: [said, ...(v.detail || [])] };
    return { verdict: "confirm", kind: hit.risk || "send", why: said, detail: [], declined: true };
  }

  /** True for an action that presses something: the pointer on a control or a point, a drag, or a key that presses or submits. */
  function pressing(a) {
    if (!a) return false;
    if (POINTER_PRESSES.includes(a.do) || a.do === "click_at" || a.do === "drag") return true;
    return a.do === "press" && activatingKey(a.key);
  }

  /**
   * The link whose address a navigate or a new tab opens: one on this page
   * with that exact address ({ref}), or one on a page read earlier whose
   * check said it commits ({entry}, from run.linkIndex, which run.js keeps
   * and a sub-task hands back). Null for any other address, which is
   * judged by where it came from as before.
   */
  function linkOpened(a, page, run) {
    if (!opensUrl(a)) return null;
    const exact = TOOLS.exactUrl(String(a.url || ""));
    if (!exact) return null;
    const here = ((page && page.elements) || []).find((e) => TOOLS.pressKind(e) === "link" && TOOLS.linkAddress(e, page) === exact);
    if (here) return { ref: here.id };
    const seen = run && run.linkIndex && run.linkIndex[exact];
    return seen && seen.key ? { entry: seen } : null;
  }

  /**
   * What the run's checks said of a press entry, as a press risk: null for
   * one that commits nothing, the risk for one that does, and {check} for
   * one not yet judged. A press the check could not answer for, a button
   * or a link, is held with the run's one card about the check being down
   * (kind "unchecked"), never let through on the hope that it is harmless.
   * Once the user has chosen on that card to carry on without the check
   * (run.uncheckedOk, cleared when the check answers again), such a press
   * is {unchecked}: it is decided as with confirmations off for it alone,
   * so what the page's structure holds, the step's own word that it
   * commits and the user's declines still hold it.
   */
  function entryRisk(entry, run, target) {
    const said = ((run && run.opinions) || {})[entry.key];
    if (!said) return { check: true };
    if (said.unanswered) return run && run.uncheckedOk ? { unchecked: true } : { risk: { kind: "unchecked", why: TOOLS.RISK_TEXT.unchecked, target } };
    if (said.does === "unsure") return { risk: { kind: "decide", why: TOOLS.RISK_TEXT.unsure, target } };
    if (["pay", "send", "delete", "decide"].includes(said.does)) return { risk: { kind: said.does, why: TOOLS.RISK_TEXT[said.does], target }, opinion: VERB[said.does] };
    return {};
  }
  const UNCHECKED = Object.freeze({ verdict: "allow", note: "The safety check was not answering, and you chose to carry on without it for this task, so this was not checked." });
  const VERB = Object.freeze({ pay: "it spends money", send: "it sends something", delete: "it deletes something", decide: "it decides something for you" });

  /** A verdict on pressing an entry alone, for a link opened by its address. */
  function entryVerdict(entry, run, target) {
    const r = entryRisk(entry, run, String(target || "").slice(0, 80));
    if (r.check) return { verdict: "allow", check: { kind: "press", key: entry.key, entry } };
    if (!r.risk) return r.unchecked ? UNCHECKED : ALLOW;
    return { verdict: "confirm", kind: r.risk.kind, why: r.risk.why, detail: [`On: ${r.risk.target}`, ...(r.opinion ? [`Second check, from the link's names alone: ${r.opinion}.`] : []), ...(r.risk.kind === "unchecked" ? [TOOLS.RISK_TEXT.uncheckedChoice] : [])] };
  }

  function judge(a, page, run, settings, store, tabs) {
    const s = settings || {};
    const els = (page && page.elements) || [];
    const el = a.ref !== undefined ? els.find((e) => e.id === a.ref) : null;

    // Where the agent may go at all.
    if ((a.do === "navigate" || (a.do === "tabs" && a.op === "open")) && s.allowlist && !SECURITY.isUrlAllowedByDomains(a.url, s.allowlist)) {
      return { verdict: "refuse", message: `That address is outside the sites the user allows the agent to use (${String(s.allowlist).slice(0, 120)}).` };
    }
    // The user's own tabs are theirs.
    if (a.do === "tabs" && a.op === "close" && !(run.openedTabs || []).includes(a.tab)) {
      return { verdict: "refuse", message: "That tab was not opened in this run, so it stays open. To leave a page, use back or navigate." };
    }
    if (a.do === "tabs" && a.op === "switch") return decideSwitch(a, run, s, tabs);
    // The user's own details go into a site's form only with their say-so:
    // once per site, or once and for all for that site.
    if (a.do === "drag" || a.do === "click_at") return decidePointer(a, page, run, s, store);
    const shares = (a.do === "fill" && a.from) || a.do === "fill_details";
    if (shares) {
      const target = a.do === "fill" ? el : null;
      if (target && target.sensitive) return { verdict: "refuse", message: "That field is the user's to fill in." };
      const site = TOOLS.siteOf((page && page.url) || "");
      const agreed = (store && store.consents && store.consents.fill && store.consents.fill[site]) || ((run.trust && run.trust.shared) || []).includes(site);
      if (!agreed) {
        const KNOWN = need("SELECT_TO_AI_KNOWN", "./memory.js");
        const items = a.do === "fill" ? [{ label: KNOWN.FIELD_LABEL[a.from] || a.from, key: a.from }] : (a.plan || []);
        const detail = items.map((f) => `${f.label}: ${store ? KNOWN.fieldValue(store, f.key) : ""}`);
        return { verdict: "confirm", kind: "share", why: `This puts your details into a form on ${site || "this site"}.`, detail, site };
      }
      return ALLOW;
    }
    // A key with no ref goes where the focus is: it is judged as pressed there.
    const lands = pressLandsOn(a, page, run);
    if (lands.length) {
      let strongest = ALLOW;
      for (const ref of lands) {
        const v = decide({ ...a, ref }, page, run, settings, store);
        if (STRENGTH(v) > STRENGTH(strongest)) strongest = v;
      }
      return strongest;
    }
    const risky = asRiskAction(a, el);

    // A check that a person is visiting is the person's to pass.
    if (risky && TOOLS.guardHumanCheck(risky, page)) return { verdict: "handoff", kind: "human_check", question: HANDOVER.human_check };
    // Secrets are typed by the user, never by the agent, by any action.
    const secret = secretField(a, el);
    if (secret) return secret;
    if (!risky) return ALLOW;
    // The user asked for the form to be filled and left for them to send.
    const held = keptFromSending(a, el, page, run);
    if (held) return held;
    if (s.riskConfirmation === false) return ALLOW;
    // An address that carries one of the user's saved details, wherever the
    // address came from: a link on a page can be made to carry them too.
    const targetUrl = a.do === "navigate" || (a.do === "tabs" && a.op === "open") ? a.url : "";
    if (targetUrl && TOOLS.carriesDetail(targetUrl, storedDetails(store), requestOf(run))) {
      return { verdict: "confirm", kind: "address", why: "This address carries one of your saved details, which your request did not mention.", detail: [`Address: ${String(targetUrl).slice(0, 200)}`], url: targetUrl };
    }
    const fromNothing = firstAddress(a, run, store);
    if (fromNothing) return fromNothing;

    const trust = run.trust || {};
    const KNOWN = need("SELECT_TO_AI_KNOWN", "./memory.js");
    const contextSites = store && !store.paused && KNOWN && KNOWN.knownSites && (!targetUrl || !TOOLS.carriesDetail(targetUrl, storedDetails(store), requestOf(run)))
      ? KNOWN.knownSites(store).flatMap((h) => [h, TOOLS.siteOf(`https://${h}/`)].filter(Boolean))
      : [];
    let risk = TOOLS.actionRisk(risky, page, {
      task: requestOf(run),
      seenUrls: new Set(trust.urls || []),
      seenSearches: new Set(trust.searches || []),
      trustedSites: new Set([...(trust.sites || []), ...contextSites]),
      details: storedDetails(store),
    });
    // What the run's second opinions said, by site and control or form.
    const opinions = run.opinions || {};
    let check = null;
    let opinion = "";
    if (!risk) {
      // A press the page's structure does not settle: allowed, unless the
      // page-blind check on its entry says it commits. Until the check has
      // answered, the run waits for it or asks it (run.js). A control the
      // site's markup lets pass, or one with no name, presses free.
      const press = TOOLS.pressFor(risky, page);
      if (!press || !press.entry) return ALLOW;
      const entry = press.entry;
      const r = entryRisk(entry, run, (el && TOOLS.elementLabel(el)) || entry.names[0] || "");
      if (r.check) return { verdict: "allow", check: { kind: "press", key: entry.key, entry } };
      if (!r.risk) return r.unchecked ? UNCHECKED : ALLOW;
      risk = r.risk;
      opinion = r.opinion ? `from the control's names alone, ${r.opinion}` : "";
    } else if (risk.unsure && !(page && page.injection)) {
      // A form of one box: held as a send, unless a second opinion says it
      // asks the site something. On a page that hides text written to an
      // AI it is held without asking. Until it has been asked, the run asks it
      // first, and holds the send if the answer is not a clear "asks".
      const u = risk.unsure;
      const key = `form|${u.key}`;
      const said = opinions[key];
      if (said && said.sends === false) {
        return { verdict: "allow", note: `Not held for approval: a check shown only the site, the names of the box and its button, and the text judged that this asks ${u.to || u.host || "the site"} for something and sends nothing to other people${said.why ? ` (${said.why.replace(/[.\s]+$/, "")})` : ""}.` };
      }
      if (!said) {
        // Only text the agent typed is shown to the check. Text the page put
        // in the box could argue for its own submission, so it is not shown.
        const flat = (t) => String(t || "").replace(/\s+/g, " ").trim().slice(0, 290);
        const now = run.typed && u.boxRef !== undefined ? run.typed[u.boxRef] : undefined;
        const mine = now !== undefined ? now : (run.typedTexts || []).find((t) => flat(t) && flat(t) === flat(u.text));
        check = { kind: "form", key, host: u.host, to: u.to, box: u.box, button: u.button, text: mine || "", prefilled: !mine && !!flat(u.text), task: requestOf(run) };
      }
    }
    // The button that pays is pressed by the user: the agent fills the form,
    // points at the button and waits. Other spending steps (to the basket,
    // to checkout) are approved in the panel.
    // The submit of a form that holds card fields pays, whatever it is called.
    const cardForm = !!el && els.some((e) => e.sensitive === "payment" && e.formId !== undefined && e.formId === el.formId);
    const paysNow = pressesOn(a, el) && el
      && ((risk.kind === "pay" && ((page.blockers || []).some((b) => b.kind === "payment") || cardForm)) || (el.submits === true && cardForm));
    if (paysNow) {
      return { verdict: "handoff", kind: "payment", press: a.ref, question: `Everything is filled in. Please check it and press "${TOOLS.elementLabel(el) || "the button"}" yourself; I'll carry on after.` };
    }
    // A double click presses the control twice. One the user must approve
    // is pressed once, by click, so an approval never becomes two orders,
    // two payments or two messages.
    if (a.do === "double_click") {
      return { verdict: "refuse", message: `A double click presses ${risk.target ? `"${String(risk.target).slice(0, 80)}"` : "that control"} twice, and a press there needs the user's approval for one press. Use click instead.` };
    }
    const detail = [];
    if (risk.target) detail.push(`On: ${risk.target}`);
    if ((a.do === "fill" || a.do === "type") && risk.kind !== "secret") detail.push(`Text: ${String(a.value).slice(0, 160)}`);
    if (opinion) detail.push(`Second check: ${opinion}`);
    if (risk.kind === "unchecked") detail.push(TOOLS.RISK_TEXT.uncheckedChoice);
    return { verdict: "confirm", kind: risk.kind, why: risk.why, detail, site: risk.site || "", url: risk.url || "", ...(check ? { check } : {}) };
  }

  /**
   * A password, payment, one-time-code or identity field is the user's: an
   * action that would put text in it or take text out of it (fill, type,
   * a key that types, deletes, pastes or cuts) is handed to the user, and
   * one that would read its text back (select_text) is refused. Every
   * action that works on a field's text is judged here, so a new one is
   * judged by what it does to the field, not by its name.
   */
  function secretField(a, el) {
    if (!el || !el.sensitive) return null;
    if (a.do === "select_text") return { verdict: "refuse", message: "That field holds something only the user types (a password, card number or code), so its text is not selected or read." };
    const writes = a.do === "fill" || a.do === "type" || (a.do === "press" && writesText(a.key));
    if (!writes) return null;
    const kind = el.sensitive === "password" ? "sign_in" : el.sensitive === "payment" ? "payment" : el.sensitive === "code" ? "code" : "question";
    return { verdict: "handoff", kind, question: HANDOVER[kind] || HANDOVER.id };
  }

  /**
   * A refusal when the user's request says to fill in but not send ("fill
   * it in but don't submit", "I'll send it myself") and the action would
   * submit: a click on a form's send button, or Enter in a form. A search
   * form reads and is left alone: "find flights but don't book" still
   * searches.
   */
  function keptFromSending(a, el, page, run) {
    if (!el || !TOOLS.saysNotToSubmit(requestOf(run))) return null;
    const form = el.formId !== undefined ? ((page && page.forms) || []).find((f) => f.id === el.formId) : null;
    if (form && form.search) return null;
    const clicks = pressesOn(a, el) && !!TOOLS.guardNoSubmit({ action: "click", id: el.id }, requestOf(run), page);
    // Enter in a message box with no form sends it as surely as in a form.
    const enters = a.do === "press" && !pressesControl(el, a.key) && isEnter(a.key)
      && ((!!form && form.fields > 0) || (!form && TOOLS.isMessageBox(el)));
    if (!clicks && !enters) return null;
    const what = clicks ? `"${TOOLS.elementLabel(el) || "that button"}"` : "Enter";
    return { verdict: "refuse", message: `The user asked for this to be filled in but not sent, so ${what} was not pressed: it would submit the form. Finish now and tell the user it is ready for them to check and send.` };
  }

  /**
   * True when Enter and Space on the control of an allowed click are each
   * allowed outright too, judged as presses of those keys there. The page
   * may then press it with those keys when it shows no answer to the
   * click. On a button or a link a key is the click again; on anything
   * else Enter is Enter in its form, and is held, refused or asked about
   * as that.
   */
  function keysToo(a, page, run, settings, store, tabs) {
    if (!a || a.do !== "click" || a.ref === undefined || a.approved !== undefined) return false;
    return ["Enter", "Space"].every((key) => {
      const v = decide({ do: "press", key, ref: a.ref }, page, run, settings, store, tabs);
      return v.verdict === "allow" && !v.check;
    });
  }

  /**
   * Moving the run into another tab. The tab's page is read and sent to the
   * model once the run is there, so a tab the run did not open, on a site
   * that is not part of the request, is the user's to allow: once per site.
   * When the user limits the agent to some sites, a tab elsewhere is
   * refused. A tab not in the list the run was shown is refused, unless the
   * run opened it.
   */
  function decideSwitch(a, run, s, tabs) {
    const tab = (tabs || []).find((t) => t && t.id === a.tab);
    // A tab the run was not shown (another window, or opened since the
    // last look) is not one it can name: the engine would find it anyway.
    // A tab the run opened itself was already judged when it was opened.
    if (!tab) return (run.openedTabs || []).includes(a.tab) ? ALLOW : { verdict: "refuse", message: `There is no tab ${a.tab} in the tab list. Use a number from the list.` };
    if (tab.current) return ALLOW;
    const url = String(tab.url || "");
    if (s.allowlist && !SECURITY.isUrlAllowedByDomains(url, s.allowlist)) {
      return { verdict: "refuse", message: `That tab is on a site outside the sites the user allows the agent to use (${String(s.allowlist).slice(0, 120)}).` };
    }
    if ((run.openedTabs || []).includes(a.tab) || s.riskConfirmation === false) return ALLOW;
    const site = TOOLS.siteOf(url);
    if (!/^https?:/i.test(url) || !site) {
      // An empty tab or the browser's new-tab page holds nothing to read.
      // Anything else that is not a web page (a local file, a tab still
      // loading with no address yet) is the user's to allow.
      const kind = url ? TOOLS.startPageKind(url) : "";
      if (kind === "blank" || kind === "newtab") return ALLOW;
      return { verdict: "confirm", kind: "site", why: "This moves the agent into one of your own tabs that is not a web page it can name. What is in that tab would be read and sent to the model.", detail: [`Tab: ${String(tab.title || url || "a tab with no address yet").slice(0, 120)}`], site: "" };
    }
    if (((run.trust && run.trust.sites) || []).includes(site)) return ALLOW;
    return { verdict: "confirm", kind: "site", why: `This moves the agent into one of your own tabs, on ${site}. What is on that page would be read and sent to the model.`, detail: [`Tab: ${String(tab.title || url).slice(0, 120)}`], site };
  }

  /**
   * The way to the first site of a run that began with no site open. Until
   * the run has read a web page, nothing it could carry off exists except
   * what the user said and what they keep on file, so an address is judged
   * the way a person typing into the address bar would be: a search engine's
   * results for the request's own words opens without asking, as do the
   * addresses the usual rule already lets through (the site the user named,
   * a site's front page). An address that holds one of the user's stored
   * details the request does not hold is theirs to allow. Returns a verdict,
   * or null to leave the action to the usual rules.
   */
  function firstAddress(a, run, store) {
    const from = run && run.fromNothing;
    if (!from || from.left) return null;
    const url = a.do === "navigate" ? a.url : a.do === "tabs" && a.op === "open" ? a.url : null;
    if (!url) return null;
    if (TOOLS.carriesDetail(url, storedDetails(store), requestOf(run))) {
      return { verdict: "confirm", kind: "address", why: "This address carries one of your saved details, which your request did not mention.", detail: [`Address: ${String(url).slice(0, 200)}`], url };
    }
    return TOOLS.searchOfRequest(url, requestOf(run)) ? ALLOW : null;
  }

  /** The values the user keeps on file, for checking that an address does not carry them. */
  function storedDetails(store) {
    if (!store) return [];
    const KNOWN = need("SELECT_TO_AI_KNOWN", "./memory.js");
    if (!KNOWN) return [];
    return KNOWN.FIELDS.map(([key]) => KNOWN.fieldValue(store, key)).filter(Boolean);
  }

  /** What an approval also settles for the rest of the run. */
  function remember(trust, confirm) {
    const t = { ...trust, sites: [...(trust.sites || [])], urls: [...(trust.urls || [])], ...(trust.searches ? { searches: [...trust.searches] } : {}) };
    if (confirm.kind === "site" && confirm.site && !t.sites.includes(confirm.site)) t.sites.push(confirm.site);
    if (confirm.kind === "address" && confirm.url && !t.urls.includes(confirm.url)) t.urls.push(confirm.url);
    return t;
  }

  const api = Object.freeze({ decide, decideSwitch, placeRiskier, pressesOn, POINTER_PRESSES, keysToo, blockersOf, detourSite, detourMessage, remember, asRiskAction, keptFromSending, pressesControl, pressLandsOn, writesText, secretField, firstAddress, pointTarget, dropPoint, declinedMark, declinedAgain, HANDOVER });
  root.SELECT_TO_AI_POLICY = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
