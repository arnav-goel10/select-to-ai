/**
 * Select to AI - what the assistant knows about its user.
 *
 * One store, held only in this browser:
 *
 *   profile      typed details for forms (name, email, phone, address...),
 *                keyed the way the HTML standard names form fields
 *   entries      short notes of five kinds: a preference ("prices in SGD"),
 *                a site note ("the price filter is under More filters"),
 *                a lesson (something the user corrected), a routine, and
 *                context: a lasting fact about the user's life, from their
 *                own words ("Works at Fernhill; team chat is on Slack")
 *   consents     sites where the user said their details may be filled in
 *   contextSites hosts a checked run was done on that were already put to
 *                the context learning call (core/learn.js), so a site
 *                alone asks for that call once
 *
 * Every entry says where it came from, when it was last used and whether it
 * helped. Two rules are enforced here and nowhere else:
 *
 *   - what is known about the user comes from the user: their own words,
 *     something they confirmed, or something they typed into a page. Text
 *     read from a web page can never become a profile field or preference.
 *   - secrets are never stored: passwords, card numbers, one-time codes,
 *     identity numbers, API keys, or anything that would loosen the
 *     agent's safety rules.
 *
 * Pure functions: the store goes in and a new store comes out.
 */
(function initMemory(root) {
  "use strict";

  const clean = (t, n) => String(t == null ? "" : t).replace(/\s+/g, " ").trim().slice(0, n);

  // Scripts written without spaces between words: there a "word" found by
  // spaces is a whole phrase, so their text is compared by pairs of
  // characters instead.
  const SCRIPTS = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Thai}\\p{Script=Lao}\\p{Script=Khmer}\\p{Script=Myanmar}";
  const UNSPACED = new RegExp(`[${SCRIPTS}]`, "u");
  // A run of letters split into its unspaced parts (each letter with its marks) and the rest.
  const PARTS = new RegExp(`(?:[${SCRIPTS}]\\p{M}*)+|[^${SCRIPTS}]+`, "gu");

  /**
   * The words of a text, for comparing two texts: lower-cased runs of
   * letters, digits and marks (the vowel signs of Hindi or Thai are marks,
   * and a word must not be split at them) of at least `min` letters; runs
   * in a script without spaces become pairs of characters. `extra` is a few
   * more characters that count as part of a word.
   */
  function wordsOf(text, min = 3, extra = "") {
    const out = [];
    const re = new RegExp(`[\\p{L}\\p{N}\\p{M}${extra}]+`, "gu");
    for (const run of String(text || "").toLowerCase().match(re) || []) {
      // A run may mix scripts ("iphone15の価格"): each part is taken its own way.
      for (const part of run.match(PARTS) || []) {
        const chars = [...part.replace(/\p{M}/gu, "")];
        if (UNSPACED.test(part)) {
          if (chars.length === 1) out.push(chars[0]);
          for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1]);
        } else if (chars.length >= min) out.push(part);
      }
    }
    return out;
  }

  /** The share of `earlier`'s words that are also in `now`, from 0 to 1. */
  function overlap(earlier, now) {
    const want = [...new Set(wordsOf(earlier))];
    if (!want.length) return 0;
    const have = new Set(wordsOf(now));
    return want.filter((w) => have.has(w)).length / want.length;
  }

  const newId = (prefix, now) => `${prefix}_${Number(now || 0).toString(36)}${Math.random().toString(36).slice(2, 7)}`;

  // ------------------------------------------------------------------ fields
  // The profile's fields, by the names the HTML standard gives form fields
  // (autocomplete tokens), with what a person calls them.
  const FIELDS = Object.freeze([
    ["given-name", "First name"], ["family-name", "Last name"], ["name", "Full name"], ["email", "Email"], ["tel", "Phone"],
    ["street-address", "Street address"], ["address-line2", "Apartment or unit"], ["address-level2", "City"], ["address-level1", "State or region"],
    ["postal-code", "Postal code"], ["country", "Country"], ["bday", "Date of birth"], ["organization", "Company or school"], ["job-title", "Job title"], ["url", "Website"],
  ]);
  const FIELD_LABEL = Object.freeze(Object.fromEntries(FIELDS));
  // Other standard names for the same thing.
  const TOKEN_ALIAS = Object.freeze({ "address-line1": "street-address", "country-name": "country", "organization-title": "job-title", "tel-national": "tel", "additional-name": "", nickname: "", username: "" });
  // What a field asks for, read from its label when it does not say so itself.
  const LABEL_HINTS = Object.freeze([
    ["given-name", /\b(first|given)[\s_-]*name\b|\bforename\b|\bfname\b/i],
    ["family-name", /\b(last|family)[\s_-]*name\b|\bsurname\b|\blname\b/i],
    ["email", /\be-?mail\b/i],
    ["tel", /\b(phone|mobile|telephone|tel|contact number|cell)\b/i],
    ["address-line2", /\b(address[\s_-]*(line)?[\s_-]*2|apartment|apt|suite|unit|floor)\b/i],
    ["postal-code", /\b(zip|postal|post)[\s_-]*(code)?\b|\bpostcode\b/i],
    ["address-level2", /\b(city|town|suburb)\b/i],
    ["address-level1", /\b(state|province|region|county)\b/i],
    ["country", /\bcountry\b/i],
    ["street-address", /\b(street|address)\b/i],
    ["bday", /\b(date of birth|birth ?date|birthday|dob)\b/i],
    ["job-title", /\b(job[\s_-]*title|position|role)\b/i],
    ["organization", /\b(company|organi[sz]ation|employer|school|university)\b/i],
    ["url", /\b(website|homepage|url)\b/i],
    ["name", /\b(full[\s_-]*name|your name|name)\b/i],
  ]);

  /**
   * Which profile field a control on a page asks for, or "". The control's
   * own declaration (its autocomplete attribute, its type) is believed
   * first; its label is read only when it declares nothing.
   */
  function fieldKindOf(el) {
    if (!el || el.sensitive) return "";
    const tag = String(el.tagName || "").toLowerCase();
    const type = String(el.inputType || "").toLowerCase();
    if (!["input", "select", "textarea"].includes(tag)) return "";
    if (/^(checkbox|radio|file|submit|button|reset|image|hidden|range|color|search|password)$/.test(type) || el.role === "searchbox") return "";
    const tokens = String(el.autocomplete || "").toLowerCase().split(/\s+/).filter(Boolean);
    for (const t of tokens.reverse()) {
      if (t === "off" || t === "on" || /^section-/.test(t) || /^(shipping|billing|home|work|mobile|fax|pager)$/.test(t)) continue;
      if (/^(cc-|current-password|new-password|one-time-code|transaction-)/.test(t)) return "";
      const key = Object.prototype.hasOwnProperty.call(TOKEN_ALIAS, t) ? TOKEN_ALIAS[t] : t;
      if (key && FIELD_LABEL[key]) return key;
    }
    if (type === "email") return "email";
    if (type === "tel") return "tel";
    if (type === "url") return "url";
    const words = [el.accName, el.label, el.placeholder, el.name, el.htmlId].filter(Boolean).join(" ").replace(/([a-z])([A-Z])/g, "$1 $2");
    for (const [key, re] of LABEL_HINTS) if (re.test(words)) return key;
    return "";
  }

  // ----------------------------------------------------------------- secrets

  const SECRET = [
    /\b(?:\d[ -]?){13,19}\b/, // card-like numbers
    /\b\d{3}-\d{2}-\d{4}\b/, // a social security number's shape
    /\b(password|passcode|passwd|pin code|cvv|cvc|security code|one[- ]time|otp|2fa code|verification code|passport (?:no|number)|social security|national id|nric)\b/i,
    /\b(sk-[a-z0-9-]{8,}|AIza[0-9A-Za-z_-]{10,}|gsk_[0-9A-Za-z]{10,}|xai-[0-9A-Za-z]{10,}|oc_sk_[0-9A-Za-z]{6,}|csk-[0-9a-z]{10,}|mstrl_[0-9A-Za-z_]{10,}|nvapi-[0-9A-Za-z_-]{10,})|\bAQ\.[0-9A-Za-z_-]{20,}/,
    /\b(api[_ -]?key|access token|secret key|private key)\b/i,
  ];
  // Remembered text must never loosen the agent's safety rules.
  const UNSAFE = /\b(skip|bypass|disable|ignore|don'?t ask|without asking|no need to (?:ask|confirm))\b[^.]{0,40}\b(confirm|confirmation|approval|permission|captcha|verification|safety|rules?)\b/i;

  function isStorable(text) {
    const t = String(text || "");
    return !!t.trim() && !SECRET.some((re) => re.test(t)) && !UNSAFE.test(t);
  }

  // ------------------------------------------------------------------- store

  const KINDS = Object.freeze(["preference", "site_note", "lesson", "routine", "context"]);
  // You said it, you confirmed it, you typed it into a page, you mentioned
  // it in a task (a context fact, checked against your words); learned from
  // a run that was verified; learned from your correction.
  const SOURCES = Object.freeze(["you_said", "you_confirmed", "you_filled", "you_mentioned", "run", "correction"]);
  const USER_SOURCES = new Set(["you_said", "you_confirmed", "you_filled", "you_mentioned"]);
  // How much of an earlier request's words a new one must share for its
  // routine to be shown (ROUTINE_NEAR), and to be called alike (ROUTINE_LIKE).
  const ROUTINE_NEAR = 1 / 3;
  const ROUTINE_LIKE = 0.6;
  // context: what limits facts about the user's life is what a step is
  // shown, not what is stored. A step sees all of them when there are 10 or
  // fewer, else the 10 that share most words with the request
  // (contextShown; 10 short lines keep the block under about 300 tokens).
  // The stored list is bounded by size only: 300 live facts (about 70 KB),
  // beyond which the least useful makes room. Retired facts are kept for
  // undo, 25 at most (contextRetired). All are judgment, not measurements.
  const LIMITS = Object.freeze({ preference: 200, site_note: 300, lesson: 100, routine: 50, context: 300, contextShown: 10, contextRetired: 25, contextSites: 200, perSite: 10, chars: 240 });
  // A new context fact that shares this much of its words with one already
  // kept, and names nothing the kept one does not, is the same fact said
  // again (CONTEXT_SAME). A guess.
  const CONTEXT_SAME = 0.6;

  function empty() {
    return { v: 2, profiles: [{ id: "personal", name: "Personal", fields: {} }], active: "personal", entries: [], consents: { fill: {} }, contextSites: [], paused: false };
  }

  const profileOf = (store) => store.profiles.find((p) => p.id === store.active) || store.profiles[0];

  /** A profile field's value, or one worked out from the fields that are there. */
  function fieldValue(store, key) {
    const f = profileOf(store).fields;
    if (f[key] && f[key].value) return f[key].value;
    if (key === "name" && f["given-name"] && f["family-name"]) return `${f["given-name"].value} ${f["family-name"].value}`;
    // A two-word name splits one way; anything longer is the user's to say.
    const parts = f.name ? String(f.name.value).trim().split(/\s+/) : [];
    if (key === "given-name" && parts.length === 2) return parts[0];
    if (key === "family-name" && parts.length === 2) return parts[1];
    return "";
  }

  /** Sets a profile field. Only the user is a source for these. */
  function setField(store, key, value, source, now) {
    const v = clean(value, 300);
    if (!FIELD_LABEL[key] && !/^custom:/.test(key)) return { store, saved: false, why: "not a profile field" };
    if (!USER_SOURCES.has(source)) return { store, saved: false, why: "only the user can set their details" };
    if (v && !isStorable(v)) return { store, saved: false, why: "that looks like a secret, and secrets are not stored" };
    const profiles = store.profiles.map((p) => {
      if (p.id !== profileOf(store).id) return p;
      const fields = { ...p.fields };
      if (!v) delete fields[key];
      else fields[key] = { value: v, source, created: (fields[key] && fields[key].created) || now, updated: now, lastUsed: (fields[key] && fields[key].lastUsed) || 0 };
      return { ...p, fields };
    });
    return { store: { ...store, profiles }, saved: true };
  }

  const same = (a, b) => clean(a, 400).toLowerCase() === clean(b, 400).toLowerCase();
  // A fact that a later one replaced is kept for a while, to undo and to
  // see, but takes no room and is never shown to the model.
  const live = (e) => e.status !== "retired";

  /**
   * Adds a note. A preference has to come from the user; a site note or a
   * lesson belongs to a site unless the user said it.
   */
  function addEntry(store, entry, now) {
    const kind = KINDS.includes(entry.kind) ? entry.kind : "";
    const text = clean(entry.text, entry.kind === "routine" ? LIMITS.chars * 2 : LIMITS.chars);
    const source = SOURCES.includes(entry.source) ? entry.source : "";
    const scope = clean(entry.scope || "global", 80).toLowerCase() || "global";
    if (!kind || !source) return { store, added: null, why: "unknown kind or source" };
    if (!isStorable(text)) return { store, added: null, why: "that cannot be stored (it is empty, a secret, or would loosen a safety rule)" };
    if (kind === "preference" && !USER_SOURCES.has(source)) return { store, added: null, why: "a preference has to come from the user" };
    // What the user's life is like is theirs to say, and holds everywhere.
    if (kind === "context" && (!USER_SOURCES.has(source) || scope !== "global")) return { store, added: null, why: "a fact about the user has to come from the user" };
    if (!USER_SOURCES.has(source) && scope === "global") return { store, added: null, why: "what was learned on a site stays with that site" };
    const twin = store.entries.find((e) => e.kind === kind && e.scope === scope && live(e) && same(e.text, text));
    if (twin) return { store, added: null, why: "already known", existing: twin };
    // What a fact rests on: the user's words it came from, the run it came
    // from, and whether a site the run used is part of it.
    const facts = kind === "context" || entry.quote
      ? {
        times: 1, lastSeen: now, validFrom: now, status: "active",
        from: (entry.from || ["said"]).filter((f) => f === "said" || f === "site"),
        ...(entry.quote ? { quote: clean(entry.quote, 300) } : {}),
        ...(entry.origin ? { origin: { runId: clean(entry.origin.runId, 80), at: now } } : {}),
        ...(entry.supersedes ? { supersedes: entry.supersedes } : {}),
      }
      : {};
    const steps = Array.isArray(entry.steps) && entry.steps.length ? entry.steps.slice(0, 8).map((s) => clean(s, 120)).filter(Boolean) : null;
    const added = { id: newId(kind[0], now), kind, text, scope, source, created: now, lastUsed: 0, helped: 0, hurt: 0, ...facts, ...(entry.candidate ? { candidate: true } : {}), ...(entry.task ? { task: clean(entry.task, 200) } : {}), ...(steps ? { steps } : {}) };
    let entries = [added, ...store.entries];
    // The least recently useful of a kind makes room for a new one. For
    // context, what the user wrote in Memory goes last, then the facts that
    // helped least and were said fewest times, the oldest first. A retired
    // fact takes no room.
    const recent = (e) => Math.max(e.lastUsed || 0, e.lastSeen || 0, e.created || 0);
    const worth = (e) => (e.helped || 0) - (e.hurt || 0) + (e.times || 1);
    const netHelp = (e) => (e.helped || 0) - (e.hurt || 0);
    const order = kind === "context"
      ? (a, b) => (a.source === "you_said") - (b.source === "you_said") || worth(a) - worth(b) || recent(a) - recent(b)
      : (a, b) => netHelp(a) - netHelp(b) || (a.lastUsed || a.created) - (b.lastUsed || b.created);
    const cap = (list, limit) => {
      const others = list.filter((e) => e.id !== added.id && live(e));
      if (others.length < limit) return new Set();
      return new Set([...others].sort(order).slice(0, others.length - limit + 1).map((e) => e.id));
    };
    const drop = new Set([...cap(entries.filter((e) => e.kind === kind), LIMITS[kind])]);
    if (scope !== "global") for (const id of cap(entries.filter((e) => e.scope === scope && e.kind !== "preference"), LIMITS.perSite)) drop.add(id);
    entries = entries.filter((e) => !drop.has(e.id));
    return { store: { ...store, entries }, added };
  }

  const removeEntry = (store, id) => ({ ...store, entries: store.entries.filter((e) => e.id !== id) });

  function updateEntry(store, id, text, now) {
    const t = clean(text, LIMITS.chars);
    if (!isStorable(t)) return store;
    return { ...store, entries: store.entries.map((e) => (e.id === id ? { ...e, text: t, updated: now } : e)) };
  }

  /** Marks entries as used now, and as having helped or hurt the run they were used in. */
  function mark(store, ids, how, now) {
    const set = new Set(ids || []);
    if (!set.size) return store;
    const entries = store.entries.map((e) => {
      if (!set.has(e.id)) return e;
      const next = { ...e, lastUsed: now };
      if (how === "helped") next.helped = (e.helped || 0) + 1;
      if (how === "hurt") next.hurt = (e.hurt || 0) + 1;
      return next;
    })
      // What was learned from a run and keeps misleading is dropped; what
      // the user said themselves stays until they remove it.
      .filter((e) => USER_SOURCES.has(e.source) || !((e.hurt || 0) >= 2 && (e.hurt || 0) > (e.helped || 0)));
    return { ...store, entries };
  }

  // ------------------------------------------------------------- in the loop

  const siteMatches = (scope, site) => !!site && (scope === site || site.endsWith(`.${scope}`) || scope.endsWith(`.${site}`));

  /**
   * What the model is told it knows, for a page on `site`: the user's
   * preferences, which details are on file (by name, never the values), and
   * the notes for this site. Returns the text and the ids of what is in it.
   */
  function knownBlock(store, site, task, opts) {
    if (!store || store.paused) return { text: "", site: "", ids: [], shown: [] };
    const startSite = opts && opts.startSite ? String(opts.startSite) : "";
    const page = opts && opts.page ? opts.page : null;
    const lines = [];
    const ids = [];
    const use = (e) => !e.candidate;
    const prefs = prefsFor(store, task);
    if (prefs.length) { lines.push("Preferences they told you:"); for (const e of prefs) { lines.push(`- ${e.text}`); ids.push(e.id); } }
    // Lasting facts about the user's life, from their own words in earlier
    // tasks: each with where it came from, how often and since when, so
    // the model can judge whether to rely on it or check first. All of them
    // when there are few; otherwise those that share the most words with
    // this request, then the most recently said.
    // A fact's text may add common knowledge to what the user said (the
    // country of their city); when it does, their own short words are shown
    // beside it, so the model knows which part they said.
    const facts = contextFor(store, task);
    if (facts.length) {
      lines.push("About their life, from earlier tasks (each as it stood when last said; it may have changed):");
      for (const e of facts) { lines.push(`- ${e.text} (${provenance(e)})`); ids.push(e.id); }
    }
    const fields = FIELDS.map(([k]) => k).filter((k) => fieldValue(store, k));
    if (fields.length) lines.push(`Their details on file (fill a field from them with fill and from: "profile.<name>", or a whole form with fill_details; you are not shown the values): ${fields.map((k) => `profile.${k}`).join(", ")}`);
    // What was learned on a site came, in part, from that site's pages. It
    // is given back with the page's own text, as something to weigh, never
    // beside the user's words.
    // A routine is how an earlier request was done here. The two closest to
    // this request are shown, with the earlier request in quotes, when they
    // share at least ROUTINE_NEAR of that request's words: whether it fits
    // is the model's to judge. Matching by words alone needs most of them
    // (a paraphrase shares few), and two at a time keeps the cost to a few
    // lines. ROUTINE_NEAR is a guess, not a measurement.
    const routineMatchesSite = (scope) => (site ? siteMatches(scope, site) || (startSite && siteMatches(scope, startSite)) : true);
    const routines = store.entries.filter((e) => e.kind === "routine" && e.scope !== "global" && routineMatchesSite(e.scope) && use(e))
      .map((e) => ({ e, share: overlap(e.task, task) }))
      .filter((r) => r.share >= (site ? ROUTINE_NEAR : ROUTINE_LIKE))
      .sort((a, b) => b.share - a.share)
      .slice(0, 2);
    const close = new Map(routines.map((r) => [r.e.id, r.share]));
    const siteEntries = site
      ? store.entries.filter((e) => e.scope !== "global" && siteMatches(e.scope, site) && use(e) && (e.kind !== "routine" || close.has(e.id))).slice(0, LIMITS.perSite)
      : routines.map((r) => r.e);
    const extraRoutines = site && startSite && !siteMatches(startSite, site)
      ? routines.map((r) => r.e).filter((e) => !siteEntries.some((x) => x.id === e.id))
      : [];
    const here = [...siteEntries, ...extraRoutines].slice(0, LIMITS.perSite);
    const notes = [];
    const shown = [];
    const label = (e) => e.kind === "lesson" ? "The user corrected you here before: "
      : e.kind === "routine" ? (!site || (site && !siteMatches(e.scope, site)) ? `A request like this one was done on ${e.scope} before by: ` : close.get(e.id) >= ROUTINE_LIKE ? "A request like this one was done here before by: " : "An earlier, different request here was done by: ")
        : "";
    const annotateRoutineText = (e) => {
      if (e.kind !== "routine" || !page || !Array.isArray(page.elements) || !page.elements.length) return e.text;
      const els = page.elements;
      const tools = root.SELECT_TO_AI_TOOLS || (typeof require === "function" ? require("../agentTools.js") : null);
      const labelOf = (el) => String((tools && tools.elementLabel ? tools.elementLabel(el) : (el.accName || el.label || el.text || "")) || "").replace(/\s+/g, " ").trim().toLowerCase();
      return String(e.text || "").replace(/(press|in) "([^"]+)"/g, (full, verb, target) => {
        const t = target.replace(/\s+/g, " ").trim().toLowerCase();
        const hits = els.filter((el) => labelOf(el) === t);
        return hits.length === 1 ? `${verb} "${target}" ([${hits[0].id}])` : full;
      });
    };
    for (const e of here) { notes.push(`- ${label(e)}${annotateRoutineText(e)}`); ids.push(e.id); shown.push({ id: e.id, kind: e.kind }); }
    for (const e of prefs) shown.push({ id: e.id, kind: e.kind });
    for (const e of facts) shown.push({ id: e.id, kind: e.kind });
    return { text: lines.join("\n"), site: notes.join("\n"), ids, shown };
  }

  // ----------------------------------------------------------------- context

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dayOf = (t) => { const d = new Date(t); return Number.isFinite(d.getTime()) && t > 0 ? `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}` : ""; };

  /** The global preferences to show a step for `task`: all when <= 20, else the closest and most helpful. */
  function prefsFor(store, task) {
    const prefs = (store.entries || []).filter((e) => e.kind === "preference" && e.scope === "global" && live(e) && !e.candidate);
    if (prefs.length <= 20) return prefs;
    const recent = (e) => Math.max(e.lastUsed || 0, e.created || 0);
    const help = (e) => (e.helped || 0) - (e.hurt || 0);
    return prefs.map((e) => ({ e, share: overlap(task, e.text) }))
      .sort((a, b) => b.share - a.share || help(b.e) - help(a.e) || recent(b.e) - recent(a.e))
      .slice(0, 20).map((x) => x.e);
  }

  /** The context facts to show a step for `task`: all when few, else the closest. */
  function contextFor(store, task) {
    const facts = (store.entries || []).filter((e) => e.kind === "context" && live(e) && !e.candidate);
    if (facts.length <= LIMITS.contextShown) return facts;
    const recent = (e) => Math.max(e.lastSeen || 0, e.lastUsed || 0, e.created || 0);
    return facts.map((e) => ({ e, share: overlap(task, e.text) }))
      .sort((a, b) => b.share - a.share || recent(b.e) - recent(a.e))
      .slice(0, LIMITS.contextShown).map((x) => x.e);
  }

  // The user's words are shown beside a fact when they fit on a short line.
  const QUOTE_SHOWN = 80;

  /**
   * 'the user said "I live in Lyon so euros"; since 2 Oct 2026; from their
   * words in 3 tasks, last 4 Oct 2026'. "Said" is only ever the quote: the
   * fact's text may add what the user did not say.
   */
  function provenance(e) {
    const since = dayOf(e.validFrom || e.created);
    if (e.source === "you_said") return `written by the user in their memory${since ? `, ${since}` : ""}`;
    const from = e.from || ["said"];
    const q = clean(e.quote, 400).replace(/"/g, "'");
    const quoted = q && q.length <= QUOTE_SHOWN && plain(q) !== plain(e.text) && from.includes("said") ? `the user said "${q}"; ` : "";
    const basis = from.includes("site") ? (from.includes("said") ? "from their words and the site a checked task used" : "from the site a checked task for the user used") : "from their words";
    const n = e.times || 1;
    const last = dayOf(e.lastSeen || e.created);
    return `${quoted}${since ? `since ${since}; ` : ""}${basis} in ${n === 1 ? "1 task" : `${n} tasks`}${last && n > 1 ? `, last ${last}` : ""}`;
  }

  const plain = (t) => String(t || "").toLowerCase().normalize("NFKC").replace(/\s+/g, " ").trim();
  const hostOf = (v) => plain(v).replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "").replace(/\.$/, "");

  /**
   * Whether a proposed context fact rests on the user's own words, or on a
   * site a checked run of theirs used. The call that proposes it never sees
   * a page, so what is not in those words can only be the model's inference
   * (Lyon is in France) or its invention: the check is that the user is not
   * made to say what they did not, not a defence against pages (the meaning
   * check in the engine is that). The model says which of the user's words
   * it came from (`quote`) and which names, places, services and sites it
   * rests on (`values`); the code checks, in any language:
   *
   *   - each value is in what the user typed, in the fact it replaces, or is
   *     a host a checked run used (or its parent); a value that is none of
   *     these is dropped, and the fact is refused only when none is left;
   *   - the quote is the user's words as they typed them; when it is not
   *     (a model may quote the assistant's question), and the values the
   *     user typed are all in one thing they typed, that is the quote.
   *
   * The fact's text may add common knowledge to what they said (a city's
   * country, a service's site); knownBlock shows the quote beside it.
   *
   * `basis` is {said: [texts the user typed], sites: [hosts], prior: text}.
   * Returns {ok, why, from: ["said"] | ["site"] | ["said", "site"], quote,
   * values, dropped}.
   */
  function groundContext(item, basis) {
    const no = (why) => ({ ok: false, why, from: [], quote: "", values: [], dropped: [] });
    const text = clean(item && item.text, LIMITS.chars);
    if (!isStorable(text)) return no("it cannot be stored");
    const typed = [...new Set(((basis && basis.said) || []).map((t) => clean(t, 2000)).filter(Boolean))];
    const saidList = typed.map(plain);
    const said = saidList.join("\n");
    const prior = plain(basis && basis.prior);
    const sites = ((basis && basis.sites) || []).map(hostOf).filter(Boolean);
    const onSite = (v) => { const h = hostOf(v); return /\./.test(h) && sites.some((s) => s === h || s.endsWith(`.${h}`)); };
    let bySaid = false;
    let bySite = false;
    const values = [];
    const dropped = [];
    const typedValues = [];
    for (const v of new Set(((item && item.values) || []).map((x) => clean(x, 120)).filter((x) => plain(x).length >= 2))) {
      const pv = plain(v);
      if (said.includes(pv)) { bySaid = true; values.push(v); typedValues.push(pv); } else if (onSite(v)) { bySite = true; values.push(v); } else if (prior.includes(pv)) values.push(v);
      else dropped.push(v);
    }
    if (!values.length) return no(dropped.length ? `none of ${dropped.map((v) => `"${v}"`).join(", ")} is something the user said or a site the task used` : "it names nothing the user said");
    let quote = clean(item.quote, 300);
    const pq = plain(item.quote);
    if (!pq || !saidList.some((t) => t.includes(pq))) {
      const holding = saidList.map((t, i) => (typedValues.some((pv) => t.includes(pv)) ? i : -1)).filter((i) => i >= 0);
      if (holding.length !== 1) return no("the quote is not the user's words");
      quote = clean(typed[holding[0]], 200);
    }
    return { ok: true, why: "", from: [...(bySaid || (!bySite && prior) ? ["said"] : []), ...(bySite ? ["site"] : [])], quote, values, dropped };
  }

  /** Retired facts older than 90 days, or beyond the newest contextRetired, are let go. */
  function pruneRetired(entries, now) {
    const old = entries.filter((e) => e.status === "retired").sort((a, b) => (b.validTo || 0) - (a.validTo || 0));
    const gone = new Set(old.filter((e, i) => i >= LIMITS.contextRetired || now - (e.validTo || 0) > 90 * 864e5).map((e) => e.id));
    return gone.size ? entries.filter((e) => !gone.has(e.id)) : entries;
  }

  /**
   * One decision of the context learning call, already grounded
   * (groundContext): `op` is {action: add|update|supersede, kind:
   * context|preference, id, text, quote, from, runId}.
   *
   *   add        a new fact; when one kept already shares CONTEXT_SAME of
   *              its words it is that fact said again (confirmed), or a
   *              fuller wording of it (updated)
   *   update     the same fact, said again or said better: reworded in
   *              place, one more time said
   *   supersede  no longer true: the old fact is retired (kept, not shown)
   *              and the new one, if any, takes its place from now
   *
   * Returns {store, change: {how, entry, was} | null, why}.
   */
  function putFact(store, op, now) {
    const kind = op.kind === "preference" ? "preference" : "context";
    const text = clean(op.text, LIMITS.chars);
    const kept = (store.entries || []).filter((e) => e.kind === kind && e.scope === "global" && live(e) && USER_SOURCES.has(e.source));
    let target = op.id ? kept.find((e) => e.id === op.id) || null : null;
    if ((op.action === "update" || op.action === "supersede") && !target) return { store, change: null, why: "no such fact" };
    const from = (prev) => [...new Set([...((prev && prev.from) || []), ...(op.from || ["said"])])];
    const bump = (e, how) => {
      const next = { ...e, ...(how === "updated" ? { text, updated: now } : {}), quote: clean(op.quote || e.quote, 300), times: (e.times || 1) + 1, lastSeen: now, from: from(e) };
      return { store: { ...store, entries: store.entries.map((x) => (x.id === e.id ? next : x)) }, change: { how, entry: next, was: e.text }, why: "" };
    };
    if (op.action === "supersede") {
      const retired = { ...target, status: "retired", validTo: now };
      let next = { ...store, entries: store.entries.map((x) => (x.id === target.id ? retired : x)) };
      if (!text) return { store: { ...next, entries: pruneRetired(next.entries, now) }, change: { how: "retired", entry: retired, was: target.text }, why: "" };
      const res = addEntry(next, { kind, text, scope: "global", source: "you_mentioned", quote: op.quote, from: op.from, origin: { runId: op.runId }, supersedes: target.id }, now);
      if (!res.added) return { store, change: null, why: res.why };
      next = { ...res.store, entries: pruneRetired(res.store.entries.map((x) => (x.id === target.id ? { ...x, supersededBy: res.added.id } : x)), now) };
      return { store: next, change: { how: "superseded", entry: res.added, was: target.text }, why: "" };
    }
    if (!text) return { store, change: null, why: "empty" };
    if (target) return bump(target, same(target.text, text) ? "confirmed" : "updated");
    // Said again, in other words: the same fact, not a second one. It is
    // the same only when it names nothing the kept one does not ("Uses
    // Outlook for work" is not "Uses Gmail for email" said again, however
    // many words they share); it is a fuller wording only when it keeps
    // every word of the kept one, so nothing kept is lost without the
    // user's words saying so.
    const named = (op.values || []).map(plain).filter((v) => v && plain(text).includes(v));
    const twin = kept.map((e) => ({ e, into: overlap(text, e.text), outOf: overlap(e.text, text) }))
      .map((x) => ({ ...x, said: x.into >= CONTEXT_SAME && named.every((v) => plain(x.e.text).includes(v)), fuller: x.outOf === 1 }))
      .filter((x) => x.said || x.fuller)
      .sort((a, b) => Math.max(b.into, b.outOf) - Math.max(a.into, a.outOf))[0];
    if (twin) return bump(twin.e, twin.said ? "confirmed" : "updated");
    const res = addEntry(store, { kind, text, scope: "global", source: "you_mentioned", quote: op.quote, from: op.from, origin: { runId: op.runId } }, now);
    return res.added ? { store: res.store, change: { how: "added", entry: res.added, was: "" }, why: "" } : { store, change: null, why: res.why };
  }

  /** Notes that a host was put to the context learning call. */
  function noteContextSite(store, host) {
    const h = hostOf(host);
    if (!h) return store;
    const list = (store.contextSites || []).filter((x) => x !== h);
    return { ...store, contextSites: [h, ...list].slice(0, LIMITS.contextSites) };
  }

  /** Adds to each control what it asks for and whether the profile has it. */
  function annotate(elements, store) {
    for (const el of elements || []) {
      const kind = fieldKindOf(el);
      if (!kind) continue;
      el.fieldKind = kind;
      const value = store && !store.paused ? fieldValue(store, kind) : "";
      if (!value) continue;
      el.have = `profile.${kind}`;
      // Already holding the user's detail: the model is told which, not what.
      if (same(el.value || "", value)) el.mask = `(their ${FIELD_LABEL[kind].toLowerCase()}, from profile.${kind})`;
    }
    return elements;
  }

  /**
   * What filling a form from the profile would do: which fields get which
   * detail, which are left because nothing is on file, and which are never
   * filled from memory. `formId` limits it to one form.
   */
  function planFill(elements, store, formId) {
    const out = { fills: [], missing: [], skipped: [] };
    for (const el of elements || []) {
      if (formId !== undefined && formId !== null && el.formId !== formId) continue;
      const tag = String(el.tagName || "").toLowerCase();
      if (!["input", "select", "textarea"].includes(tag) || el.disabled) continue;
      const label = el.accName || el.label || el.placeholder || el.name || tag;
      if (el.sensitive) { out.skipped.push({ ref: el.id, label, why: `${el.sensitive === "password" ? "a password" : el.sensitive === "payment" ? "card details" : el.sensitive === "code" ? "a one-time code" : "an identity number"} is the user's to enter` }); continue; }
      const kind = fieldKindOf(el);
      if (!kind) continue;
      const value = fieldValue(store, kind);
      if (!value) { out.missing.push({ ref: el.id, kind, label }); continue; }
      // A field that already says the right thing is left alone.
      if (same(el.value || el.selected || "", value)) continue;
      out.fills.push({ ref: el.id, key: kind, label, value });
    }
    return out;
  }

  /**
   * Details the user typed into a page themselves that the profile does not
   * have, or has differently: `before` and `after` are two scans of the
   * same page around a wait. Sensitive fields never appear here: the scan
   * does not read them.
   */
  function userFilled(before, after, store) {
    const was = new Map(((before && before.elements) || []).map((el) => [el.id, el.value || ""]));
    const found = [];
    for (const el of (after && after.elements) || []) {
      if (el.sensitive || !el.value) continue;
      const kind = fieldKindOf(el);
      if (!kind || !was.has(el.id) || same(was.get(el.id), el.value)) continue;
      if (!isStorable(el.value) || same(fieldValue(store, kind), el.value)) continue;
      if (!found.some((f) => f.key === kind)) found.push({ key: kind, label: FIELD_LABEL[kind], value: clean(el.value, 300), had: fieldValue(store, kind) });
    }
    return found;
  }

  /**
   * Whether something the model wants remembered is the user's own words:
   * most of its words are in what the user typed in this conversation.
   * Anything else is offered to the user, never saved silently.
   */
  function saidByUser(text, userTexts) {
    const words = (t) => wordsOf(t, 3, "$");
    const saidList = (userTexts || []).flatMap(words);
    const said = new Set(saidList);
    // Same language-neutral prefix stem used by context.js nearestWords.
    const stem = (w) => w.slice(0, Math.max(4, Math.min(5, w.length - 1)));
    const matches = (w) => said.has(w) || (w.length >= 4 && saidList.some((s) => s.length >= 4 && (w.startsWith(stem(s)) || s.startsWith(stem(w)))));
    const want = [...new Set(words(text))].filter((w) => !/^(the|user|they|their|them|that|this|with|from|have|has|and|for|are|was|prefers?|likes?|wants?|always|usually)$/.test(w));
    if (!want.length) return false;
    return want.filter(matches).length / want.length >= 0.7;
  }

  // --------------------------------------------------------------- migration

  /** The store from what versions before 4 kept: free-text facts and site skills. */
  function migrate(legacy, now) {
    let store = empty();
    for (const fact of (legacy && legacy.user) || []) {
      // What the old learning call wrote was the model's wording of what it
      // saw; it is kept, marked as the user's because they could see and
      // delete it there.
      const r = addEntry(store, { kind: "preference", text: fact.text, scope: "global", source: fact.source === "you" ? "you_said" : "you_confirmed" }, fact.createdAt || now);
      store = r.store;
    }
    for (const skill of (legacy && legacy.skills) || []) {
      if (!skill.domain || !(skill.steps || []).length) continue;
      const r = addEntry(store, { kind: "site_note", text: `${skill.title}: ${skill.steps.join("; ")}`, scope: skill.domain, source: "run" }, skill.createdAt || now);
      store = r.store;
    }
    return store;
  }

  /**
   * Validates and cleans an imported store object so secrets, unsafe rules,
   * and malformed entries cannot bypass `isStorable`, `setField`, or `addEntry`.
   */
  function sanitizeStore(raw, now) {
    const t = now || Date.now();
    if (!raw || typeof raw !== "object") return empty();
    let store = empty();
    store.paused = !!raw.paused;
    if (raw.consents && raw.consents.fill && typeof raw.consents.fill === "object") {
      const fill = {};
      for (const [k, v] of Object.entries(raw.consents.fill)) {
        const h = hostOf(`https://${k}/`);
        if (h && typeof v === "boolean") fill[h] = v;
      }
      store.consents = { fill };
    }
    if (Array.isArray(raw.contextSites)) {
      store.contextSites = raw.contextSites.map((s) => hostOf(`https://${s}/`)).filter(Boolean).slice(-200);
    }
    const fields = raw.profiles && raw.profiles[0] && raw.profiles[0].fields;
    if (fields && typeof fields === "object") {
      for (const [k] of FIELDS) {
        const f = fields[k];
        if (f && typeof f.value === "string" && f.value.trim()) {
          const src = USER_SOURCES.has(f.source) ? f.source : "you_said";
          store = setField(store, k, f.value, src, Number(f.updated) || t).store;
        }
      }
    }
    for (const e of Array.isArray(raw.entries) ? raw.entries : []) {
      if (!e || typeof e !== "object") continue;
      if (e.kind === "context") {
        const text = clean(e.text, LIMITS.chars);
        const quote = clean(e.quote || "", 400);
        if (!text || !isStorable(text) || (quote && !isStorable(quote))) continue;
        store = putFact(store, {
          op: "add",
          text,
          quote: quote || text,
          from: Array.isArray(e.from) ? e.from.filter((x) => x === "said" || x === "site") : ["said"],
          source: USER_SOURCES.has(e.source) ? e.source : "run",
          runId: clean(e.runId || "", 80),
        }, Number(e.created) || t).store;
        continue;
      }
      const r = addEntry(store, {
        kind: e.kind,
        text: e.text,
        task: e.task,
        scope: e.scope,
        source: SOURCES.includes(e.source) ? e.source : "you_said",
        candidate: !!e.candidate,
      }, Number(e.created) || t);
      store = r.store;
    }
    return store;
  }

  /**
   * Domains named in active, user-sourced context facts, so deep links to
   * the user's own known services (such as their coursework portal or work
   * mail) are recognized as trusted sites when they carry no profile details.
   */
  function knownSites(store) {
    if (!store || store.paused) return [];
    const out = new Set();
    const re = /\b((?:[a-z0-9-]+\.)+[a-z]{2,}|\d{1,3}(?:\.\d{1,3}){3})\b/gi;
    for (const e of store.entries || []) {
      if (e.kind !== "context" || !live(e) || !USER_SOURCES.has(e.source)) continue;
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(String(e.text || "")))) {
        const h = hostOf(m[1]);
        if (h && /\./.test(h)) out.add(h);
      }
    }
    return [...out];
  }

  /**
   * Searches all live, non-candidate entries in the memory store by word
   * overlap and substring match, ordered by relevance, net utility, and recency.
   */
  function searchMemory(store, query, limit = 5) {
    if (!store || store.paused) return [];
    const q = plain(query);
    if (!q) return [];
    const recent = (e) => Math.max(e.lastUsed || 0, e.lastSeen || 0, e.created || 0);
    const help = (e) => (e.helped || 0) - (e.hurt || 0);
    return (store.entries || [])
      .filter((e) => live(e) && !e.candidate)
      .map((e) => {
        const hay = `${e.text || ""} ${e.task || ""} ${e.scope || ""} ${e.quote || ""}`;
        const share = Math.max(overlap(query, hay), overlap(hay, query));
        const sub = plain(hay).includes(q) ? 0.5 : 0;
        return { e, score: share + sub };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || help(b.e) - help(a.e) || recent(b.e) - recent(a.e))
      .slice(0, Math.max(1, limit || 5))
      .map((x) => x.e);
  }

  const api = Object.freeze({ wordsOf, overlap, FIELDS, FIELD_LABEL, KINDS, SOURCES, LIMITS, CONTEXT_SAME, prefsFor, contextFor, searchMemory, provenance, groundContext, putFact, noteContextSite, hostOf, empty, fieldKindOf, isStorable, fieldValue, setField, addEntry, removeEntry, updateEntry, mark, knownBlock, knownSites, annotate, planFill, userFilled, saidByUser, migrate, sanitizeStore, profileOf });
  root.SELECT_TO_AI_KNOWN = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
