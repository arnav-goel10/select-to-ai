/**
 * URL patterns (design §1.4). The origin must be equal. Path segments that
 * look like ids become "*", and segments equal to a bound value become
 * "{var}". Query keys are kept; values equal to a bound value become "{var}",
 * secret-looking or opaque values are dropped, and tracking keys are ignored.
 * Pure functions.
 */
import { templatize, fill, norm } from "./text.js";

const TRACKING = /^(utm_.*|gclid|fbclid|ref|spm|_ga|mc_.*)$/i;
const SECRET_KEY = /(token|secret|password|passwd|session|sid|auth|key|code|signature|sig|nonce|state)$/i;

/** Whether a path segment looks like a record id. */
export function idLike(seg) {
  const s = decodeSafe(seg);
  if (/^\d{3,}$/.test(s)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return true;
  if (/^[0-9a-f]{12,}$/i.test(s)) return true;
  if (/^\d+$/.test(s)) return true; // short numeric ids too: /items/42
  // A segment with a digit in it names a record ("u104", "INV-CL17-2602"),
  // not a place in the site.
  if (/\d/.test(s)) return true;
  return false;
}

function decodeSafe(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** An opaque token: long, mixed, no spaces. */
function opaque(v) {
  return typeof v === "string" && v.length >= 24 && /^[A-Za-z0-9_\-.~+/=%]+$/.test(v) && /\d/.test(v) && /[A-Za-z]/.test(v);
}

/**
 * @param {string} href
 * @param {Record<string,string>} [bindings]
 * @returns {{origin:string, path:string, query:Record<string,string>}|null}
 */
export function urlPattern(href, bindings) {
  let u;
  try { u = new URL(href); } catch { return null; }
  const segs = u.pathname.split("/").map((seg) => {
    if (!seg) return seg;
    const t = templatize(decodeSafe(seg), bindings);
    if (t !== decodeSafe(seg)) return t;
    return idLike(seg) ? "*" : seg;
  });
  const query = {};
  for (const [k, v] of u.searchParams) {
    if (TRACKING.test(k)) continue;
    if (SECRET_KEY.test(k) || opaque(v)) continue;
    const t = templatize(v, bindings);
    query[k] = t !== v ? t : (idLike(v) ? "*" : v);
  }
  return { origin: u.origin, path: segs.join("/") || "/", query };
}

/**
 * Whether a live URL matches a pattern with bindings applied.
 * Query keys in the pattern must be present with matching values ("*"
 * matches anything); extra live keys are ignored.
 */
export function urlMatches(pattern, href, bindings) {
  if (!pattern) return true;
  let u;
  try { u = new URL(href); } catch { return false; }
  if (pattern.origin && u.origin !== pattern.origin) return false;
  const want = String(pattern.path || "/").split("/");
  const have = u.pathname.split("/");
  if (want.length !== have.length) {
    // tolerate a trailing slash difference
    const trim = (a) => (a.length > 1 && a[a.length - 1] === "" ? a.slice(0, -1) : a);
    if (trim(want).length !== trim(have).length) return false;
    return segsMatch(trim(want), trim(have), bindings) && queryMatches(pattern.query, u, bindings);
  }
  return segsMatch(want, have, bindings) && queryMatches(pattern.query, u, bindings);
}

function segsMatch(want, have, bindings) {
  for (let i = 0; i < want.length; i++) {
    const w = want[i], h = decodeSafe(have[i]);
    if (w === "*") { if (!h) return false; continue; }
    if (norm(fill(w, bindings)) !== norm(h)) return false;
  }
  return true;
}

function queryMatches(q, u, bindings) {
  for (const [k, v] of Object.entries(q || {})) {
    if (!u.searchParams.has(k)) return false;
    if (v === "*") continue;
    if (norm(fill(v, bindings)) !== norm(u.searchParams.get(k))) return false;
  }
  return true;
}

/** A pattern written for people: origin + path + ?k=v. */
export function patternText(p) {
  if (!p) return "";
  const q = Object.entries(p.query || {}).map(([k, v]) => `${k}=${v}`).join("&");
  return `${p.origin}${p.path}${q ? `?${q}` : ""}`;
}

/** Registrable-ish site of a URL: the host without a leading "www.". */
export function siteOf(href) {
  try { return new URL(href).hostname.replace(/^www\./, ""); } catch { return ""; }
}
