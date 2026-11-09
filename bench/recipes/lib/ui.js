// Shared page chrome and client script for the fixture apps.
import { h, raw } from "./h.js";

const CSS = `
*{box-sizing:border-box}body{font:14px/1.45 system-ui,sans-serif;margin:0;color:#1d2433;background:#f6f7f9}
header{background:#22314f;color:#fff;padding:10px 20px;display:flex;gap:18px;align-items:center}
header a{color:#cfe0ff;text-decoration:none}header .brand{font-weight:700;color:#fff}
main{max-width:980px;margin:20px auto;padding:0 16px}
table{border-collapse:collapse;width:100%;background:#fff}td,th{border-bottom:1px solid #e3e6eb;padding:7px 9px;text-align:left}
button,.btn{font:inherit;padding:6px 12px;border:1px solid #9aa6b8;border-radius:5px;background:#fff;cursor:pointer;color:#1d2433;text-decoration:none;display:inline-block}
button.primary,.btn.primary{background:#2d64d8;color:#fff;border-color:#2d64d8}button.danger,.btn.danger{background:#fff;color:#b3261e;border-color:#b3261e}
label{display:block;margin:8px 0 3px;font-weight:600}input,select,textarea{font:inherit;padding:6px;border:1px solid #9aa6b8;border-radius:4px;min-width:240px}
input[type=checkbox],input[type=radio]{min-width:0}
.card{background:#fff;border:1px solid #e3e6eb;border-radius:8px;padding:16px;margin:12px 0}
.row-actions{display:flex;gap:6px}.muted{color:#69758a}.flash{background:#e7f6ea;border:1px solid #9fd3aa;padding:8px 12px;border-radius:6px}
.error{background:#fdecea;border:1px solid #f1a9a3;padding:8px 12px;border-radius:6px}
[data-overlay]{position:fixed;inset:0;background:rgba(10,20,40,.45);display:flex;align-items:center;justify-content:center;z-index:50}
[data-overlay][hidden]{display:none}[data-overlay] .dlg{background:#fff;border-radius:10px;padding:20px;min-width:340px;max-width:520px}
.dlg .actions{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}
[data-overlay].bar{align-items:flex-end}[data-overlay].bar .dlg{max-width:none;width:100%;border-radius:0}
.pager{display:flex;gap:6px;margin:10px 0}.tabs{display:flex;gap:10px;margin-bottom:10px}
`;

export const UI_JS = `
(function(){
  function ck(n){return document.cookie.split('; ').some(function(c){return c.indexOf(n+'=')===0})}
  function setck(n,v){document.cookie=n+'='+v+'; path=/; max-age=31536000'}
  function hide(o){o.hidden=true}
  function init(root){
    root.querySelectorAll('[data-overlay][data-once]').forEach(function(o){
      if(ck('seen_'+o.getAttribute('data-once'))){hide(o);return}
      var d=+o.getAttribute('data-delay')||0;
      if(d){hide(o);setTimeout(function(){o.hidden=false},d)}else{o.hidden=false}
    });
  }
  document.addEventListener('click',function(e){
    var t=e.target.closest('[data-open],[data-dismiss],a[data-link]');
    if(!t)return;
    if(t.hasAttribute('data-open')){e.preventDefault();var d=document.querySelector('[data-dialog="'+t.getAttribute('data-open')+'"]');if(d)d.hidden=false;return}
    if(t.hasAttribute('data-dismiss')){e.preventDefault();var o=t.closest('[data-overlay]');if(!o)return;
      if(o.hasAttribute('data-once'))setck('seen_'+o.getAttribute('data-once'),t.getAttribute('data-dismiss')||'1');
      hide(o);return}
    if(t.matches('a[data-link]')){e.preventDefault();go(t.getAttribute('href'),true)}
  });
  var root=document.querySelector('[data-spa-root]');
  function swap(html){root.innerHTML=html;init(root)}
  function go(href,push){
    fetch(href+(href.indexOf('?')<0?'?':'&')+'fragment=1',{credentials:'same-origin'}).then(function(r){
      var u=r.headers.get('x-spa-url');return r.text().then(function(html){swap(html);if(push)history.pushState({},'',u||href)})});
  }
  if(root){
    window.addEventListener('popstate',function(){go(location.pathname+location.search,false)});
    document.addEventListener('submit',function(e){
      var f=e.target;if(!f.hasAttribute('data-spa-form'))return;e.preventDefault();
      var body=new URLSearchParams(new FormData(f,e.submitter));
      var act=(e.submitter&&e.submitter.getAttribute('formaction'))||f.getAttribute('action');
      fetch(act+'?fragment=1',{method:'POST',body:body,credentials:'same-origin'}).then(function(r){
        var u=r.headers.get('x-spa-url');return r.text().then(function(t){swap(t);if(u)history.pushState({},'',u)})});
    });
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',function(){init(document)});else init(document);
})();
`;

export function page({ title, brand, nav = [], body, lang = "en", spa = false }) {
  return h(
    "html",
    { lang },
    h("head", {}, h("meta", { charset: "utf-8" }), h("title", {}, title), h("style", {}, raw(CSS))),
    h(
      "body",
      {},
      h("header", { _k: "header" }, h("span", { class: "brand" }, brand), ...nav.map(([href, label, k]) => h("a", { href, _k: k, ...(spa ? { "data-link": "" } : {}) }, label))),
      h("main", { _k: "main", ...(spa ? { "data-spa-root": "" } : {}) }, body),
      h("script", { src: "/assets/ui.js" }),
    ),
  );
}

// A confirm dialog: Cancel just closes it, Confirm submits `formId`.
export function confirmDialog({ name, title, text, confirmLabel, formId, k = name }) {
  return h(
    "div",
    { "data-overlay": "", "data-dialog": name, hidden: true, role: "dialog", "aria-modal": "true", "aria-label": title, _k: `${k}-dialog` },
    h(
      "div",
      { class: "dlg" },
      h("h3", {}, title),
      h("p", {}, text),
      h(
        "div",
        { class: "actions", _k: `${k}-actions` },
        h("button", { type: "button", "data-dismiss": "", class: "btn", id: `${k}-cancel`, _k: `${k}-cancel`, "data-testid": `${k}-cancel` }, "Cancel"),
        h("button", { type: "submit", form: formId, class: "btn primary", id: `${k}-confirm`, _k: `${k}-confirm`, "data-testid": `${k}-confirm` }, confirmLabel),
      ),
    ),
  );
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
export const int = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
export const money = (n) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
