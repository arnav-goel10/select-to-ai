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
 * reasons, so nothing a page says can talk it round. Where the rules
 * cannot settle a press (a button in words they cannot read, a form of one
 * box), the verdict carries a `check`: the run asks a second opinion that
 * is never shown the page, and decides again with its answer in
 * run.opinions. An opinion can hold a press the rules let through, and can
 * let a one-box form go without a prompt only by saying plainly that it asks.
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
  const ENTER_KEY = /(^|\+)\s*(enter|return|numpadenter)$/i;
  const SPACE_KEY = /(^|\+)\s*(space|spacebar| )$/i;
  const activatingKey = (key) => ENTER_KEY.test(String(key || "")) || SPACE_KEY.test(String(key || ""));

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
    if (!a || a.do !== "press" || a.ref !== undefined || !activatingKey(a.key)) return [];
    const els = (page && page.elements) || [];
    const ids = els.filter((e) => e.focused).map((e) => e.id);
    const last = run && run.focusRef;
    if (last !== undefined && last !== null && els.some((e) => e.id === last) && !ids.includes(last)) ids.push(last);
    return ids;
  }

  /** The same action in the shape the risk checks in agentTools.js read. */
  function asRiskAction(a, el) {
    // A double click, a right click and a long press are presses on the control.
    if (["click", "double_click", "right_click", "hold"].includes(a.do)) return { action: "click", id: a.ref };
    if (a.do === "fill") return { action: "type", id: a.ref, text: a.value };
    // A key that presses the control it lands on is a click on it.
    if (a.do === "press" && pressesControl(el, a.key)) return { action: "click", id: el.id };
    if (a.do === "press" && ENTER_KEY.test(String(a.key || ""))) return { action: "keypress", id: a.ref, text: "Enter" };
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

  function decide(a, page, run, settings, store, tabs) {
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
    if (!risky) return ALLOW;

    // A check that a person is visiting is the person's to pass.
    if (TOOLS.guardHumanCheck(risky, page)) return { verdict: "handoff", kind: "human_check", question: HANDOVER.human_check };
    // Secrets are typed by the user, never by the agent.
    if (a.do === "fill" && el && el.sensitive) {
      const kind = el.sensitive === "password" ? "sign_in" : el.sensitive === "payment" ? "payment" : el.sensitive === "code" ? "code" : "question";
      return { verdict: "handoff", kind, question: HANDOVER[kind] || HANDOVER.id };
    }
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
      // A button the rules found harmless but cannot read, or one that
      // sends a form: allowed, unless a second opinion says it pays, sends
      // or deletes. Until it has been asked, the run asks it first.
      const press = TOOLS.pressCheckOf(risky, page);
      if (!press) return ALLOW;
      const said = opinions[press.key];
      if (!said) return { verdict: "allow", check: { ...press, task: requestOf(run) } };
      // The check could not be had: a button nothing could read is the
      // user's to allow, not pressed in the hope that it is harmless.
      if (said.unanswered) {
        risk = { kind: "send", why: "What this button does could not be checked, so pressing it is yours to allow.", target: press.label };
      } else {
        if (!["pay", "send", "delete"].includes(said.does)) return ALLOW;
        risk = { kind: said.does, why: TOOLS.RISK_TEXT[said.does], target: press.label };
        opinion = said.why;
      }
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
    const paysNow = risk.kind === "pay" && (a.do === "click" || a.do === "press") && el
      && ((page.blockers || []).some((b) => b.kind === "payment") || els.some((e) => e.sensitive === "payment" && e.formId !== undefined && e.formId === el.formId));
    if (paysNow) {
      return { verdict: "handoff", kind: "payment", press: a.ref, question: `Everything is filled in. Please check it and press "${TOOLS.elementLabel(el) || "the button"}" yourself; I'll carry on after.` };
    }
    const detail = [];
    if (risk.target) detail.push(`On: ${risk.target}`);
    if (a.do === "fill" && risk.kind !== "secret") detail.push(`Text: ${String(a.value).slice(0, 160)}`);
    if (opinion) detail.push(`Second check: ${opinion}`);
    return { verdict: "confirm", kind: risk.kind, why: risk.why, detail, site: risk.site || "", url: risk.url || "", ...(check ? { check } : {}) };
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
    const clicks = (a.do === "click" || (a.do === "press" && pressesControl(el, a.key))) && !!TOOLS.guardNoSubmit({ action: "click", id: el.id }, requestOf(run), page);
    // Enter in a message box with no form sends it as surely as in a form.
    const enters = a.do === "press" && !pressesControl(el, a.key) && ENTER_KEY.test(String(a.key || ""))
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

  const api = Object.freeze({ decide, decideSwitch, keysToo, blockersOf, detourSite, detourMessage, remember, asRiskAction, keptFromSending, pressesControl, pressLandsOn, firstAddress, pointTarget, dropPoint, HANDOVER });
  root.SELECT_TO_AI_POLICY = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
