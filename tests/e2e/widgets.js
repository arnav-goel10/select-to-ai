/**
 * Select to AI - what `fill` and the whole-page scan do on real widgets.
 *
 *   node tests/e2e/widgets.js
 *
 * No model. A page of controls of every common kind is loaded in Chromium
 * with the real content script, each is given a value with one `fill`, and
 * the page's own state says whether it took. This is where "one action is
 * one user intent" is held to account: the model says what value a control
 * should have, and how that kind of control is operated is this code's job.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const EXT = path.resolve(__dirname, "../../extension");
const TOOLS = require(path.join(EXT, "agentTools.js"));

const ZOO = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Widgets</title>
<style>body{font-family:system-ui;margin:16px} section{margin:10px 0;padding:8px;border:1px solid #ccc}
[role=listbox],[role=menu]{border:1px solid #888;margin:0;padding:0;list-style:none;width:220px} [role=option],[role=menuitem]{padding:4px;cursor:pointer}
.switch{display:inline-block;width:40px;height:20px;background:#ccc} .switch[aria-checked=true]{background:#2a2}
.slider{display:inline-block;width:200px;height:16px;background:#ddd}</style></head><body>
<section><label>Full name <input id="name" value="OLD"></label>
<label>Notes <textarea id="notes">old notes</textarea></label>
<div id="rich" contenteditable="true" aria-label="Message" style="border:1px solid #888;min-height:24px">old</div></section>

<section><label>Country <select id="country"><option value="">Choose</option><option value="sg">Singapore</option><option value="se">Sweden</option><option value="us">United States</option></select></label>
<label>Size <select id="size"><optgroup label="Adult"><option value="m">Medium</option><option value="l">Large</option></optgroup><optgroup label="Kids"><option value="k">Kids 8-10</option></optgroup></select></label></section>

<section><label><input type="checkbox" id="news"> Send me news</label>
<label><input type="checkbox" id="terms" checked> I agree</label>
<label><input type="radio" name="plan" id="plan-basic" value="basic" checked> Basic</label>
<label><input type="radio" name="plan" id="plan-pro" value="pro"> Pro</label>
<div id="dark" class="switch" role="switch" aria-checked="false" aria-label="Dark mode" tabindex="0"></div>
<div id="gift" role="checkbox" aria-checked="false" aria-label="Gift wrap" tabindex="0" style="display:inline-block;width:18px;height:18px;border:1px solid #333"></div></section>

<section><label>Start <input type="date" id="start" min="2026-01-01"></label>
<label>At <input type="time" id="at"></label>
<label>Volume <input type="range" id="vol" min="0" max="10" value="3"></label>
<label>Guests <input type="number" id="guests" min="1" max="12" value="2"></label>
<label>Min price <input type="number" id="pmin"></label><label>Max price <input type="number" id="pmax"></label></section>

<section><label for="city">City</label><input id="city" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="city-list"><ul id="city-list" role="listbox" hidden></ul>
<label for="airport">Airport</label><input id="airport"><ul id="airport-list" hidden></ul>
<ul id="tabs"><li role="tab" id="tab-a" style="display:inline-block;padding:6px"><a href="#" id="tab-a-link">Tab A</a></li></ul>
<span id="icon-star" class="star" style="display:inline-block;width:14px;height:14px;cursor:pointer"></span>
<div id="termsbox" style="height:60px;overflow-y:auto;border:1px solid #999"><div style="height:400px">Terms</div><button id="terms-ok">Accept terms</button></div>
<div>Tacos <span id="qty">0</span> <span id="plus">+</span></div>
<style>.acts{cursor:pointer}.hov span:hover{cursor:pointer}</style>
<div class="acts" id="acts"><span id="act-reply">Reply</span> <span id="act-fwd">Forward</span></div>
<div class="hov"><span id="hov-like">Like</span></div>
<div id="spin" tabindex="0" style="display:inline-block;width:30px">0</div><div id="shut"><span style="display:none">secret menu words</span></div>
<label for="q">Search</label><input id="q" type="search" role="combobox" aria-label="Search the site"><ul id="q-list" role="listbox" hidden></ul></section>

<section><span id="sort-label">Sort by</span>
<button id="sort" type="button" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="sort-label sort">Featured</button>
<ul id="sort-list" role="listbox" hidden><li role="option" tabindex="-1">Featured</li><li role="option" tabindex="-1">Price: low to high</li><li role="option" tabindex="-1">Price: high to low</li><li role="option" tabindex="-1">Newest</li></ul>
<div id="lang" role="combobox" aria-label="Language" aria-expanded="false" tabindex="0">English</div>
<div id="lang-menu" role="listbox" hidden><div role="option">English</div><div role="option">Deutsch</div><div role="option">Svenska</div></div></section>

<section role="search" aria-label="Find a trip"><div id="trip" role="combobox" aria-label="Trip type" aria-expanded="false" tabindex="0">Round trip</div>
<div id="trip-menu" role="listbox" hidden><div role="option">Round trip</div><div role="option">One way</div><div role="option">Multi-city</div></div>
<label for="from">From</label><input id="from" role="combobox" aria-autocomplete="list" aria-expanded="false"><ul id="from-list" role="listbox" hidden></ul>
<label for="to">To</label><input id="to" role="combobox" aria-autocomplete="list" aria-expanded="false"><ul id="to-list" role="listbox" hidden></ul></section>

<section><a id="ext" href="https://zoo.example/other" target="_blank">Course page</a> <a id="spa" href="https://zoo.example/in-page" target="_blank" onclick="event.preventDefault(); this.dataset.handled='1'">Handled by the page</a></section>

<section><div style="position:relative;width:200px;height:40px"><label for="adults">Adults</label> <span id="adults-shown">2</span>
<input type="range" id="adults" min="1" max="30" value="2" style="position:absolute;left:0;top:0;width:124px;height:40px;opacity:0" oninput="document.getElementById('adults-shown').textContent=this.value">
<button type="button" aria-hidden="true" tabindex="-1">-</button><button type="button" aria-hidden="true" tabindex="-1">+</button></div>
<input type="checkbox" id="pets" role="switch" style="position:absolute;width:1px;height:1px;opacity:0"><label for="pets">Traveling with pets?</label></section>

<section><label for="depart">Departure</label><input id="depart" placeholder="Departure" onblur="document.getElementById('depart-set').textContent = this.value"> <span id="depart-set"></span></section>

<section><h3 id="reviews">Reviews</h3><a id="tab-closed" href="#" onclick="this.dataset.pressed='1'; return false;">Closed 30</a> <a id="toc" href="#reviews">Jump to reviews</a> <a id="tab-hash" href="#/settings">Settings</a></section>

<section><nav aria-label="Pages"><a href="/list?p=1">1</a> <a href="/list?p=2">2</a> <a href="/list?p=3">3</a></nav><p>Water boils at 100 C<sup><a href="#note-7">7</a></sup>.</p><p id="note-7">7. At sea level.</p><table><tr><td><a href="#" class="day">14</a></td><td><a href="#" class="day">15</a></td></tr></table></section>

<section><button id="order" type="button" aria-expanded="false" onclick="const m = document.getElementById('order-menu'); m.hidden = !m.hidden; this.setAttribute('aria-expanded', String(!m.hidden))">Sort: Trending</button>
<div id="order-menu" hidden><button type="button" onclick="document.getElementById('order').textContent = 'Sort: ' + this.textContent; this.parentElement.hidden = true">Most likes</button><button type="button" onclick="document.getElementById('order').textContent = 'Sort: ' + this.textContent; this.parentElement.hidden = true">Recently updated</button></div></section>

<section><label for="dest">Destination</label><input id="dest" placeholder="Where to?"><div id="dest-layer" hidden><input id="dest-big" aria-label="Where else?"></div></section>

<section><div id="rating" class="slider" role="slider" aria-label="Minimum rating" aria-valuemin="1" aria-valuemax="5" aria-valuenow="1" tabindex="0"></div>
<label>Pickup date <input id="pickup" readonly placeholder="Pick a date" onclick="this.dataset.opened='1'"></label>
<label>Controlled <input id="ctl" value="start"></label>
<button id="plain" type="button">Just a button</button></section>

<script>
  // A switch and a checkbox built from divs: a click toggles them.
  for (const id of ['dark', 'gift']) document.getElementById(id).addEventListener('click', (e) => { const el = e.currentTarget; el.setAttribute('aria-checked', el.getAttribute('aria-checked') === 'true' ? 'false' : 'true'); });
  // A field that offers choices and only keeps a chosen one.
  const cities = ['Singapore (SIN)', 'Sindelfingen', 'Sint Maarten (SXM)', 'Stockholm (ARN)'];
  const city = document.getElementById('city'), cityList = document.getElementById('city-list');
  window.cityChosen = '';
  city.addEventListener('input', () => { window.cityChosen = ''; cityList.hidden = false; cityList.innerHTML = cities.filter((c) => c.toLowerCase().includes(city.value.toLowerCase())).map((c) => '<li role="option" tabindex="-1">' + c + '</li>').join(''); });
  cityList.addEventListener('click', (e) => { const li = e.target.closest('[role=option]'); if (!li) return; city.value = li.textContent; window.cityChosen = li.textContent; cityList.hidden = true; cityList.innerHTML = ''; });
  // The same kind of field with nothing saying so: the list comes up a
  // moment after typing and goes when the field is left.
  const airports = ['Cincinnati, OH (CVG)', 'Columbus, OH (CMH)', 'Columbia, SC (CAE)'];
  const airport = document.getElementById('airport'), airportList = document.getElementById('airport-list');
  window.airportChosen = '';
  let airportTimer = 0;
  airport.addEventListener('input', () => { window.airportChosen = ''; clearTimeout(airportTimer); airportTimer = setTimeout(() => { airportList.hidden = false; airportList.innerHTML = airports.filter((c) => c.toLowerCase().includes(airport.value.toLowerCase())).map((c) => '<li><div>' + c + '</div></li>').join(''); }, 300); });
  airport.addEventListener('blur', () => { clearTimeout(airportTimer); airportList.hidden = true; });
  airportList.addEventListener('mousedown', (e) => e.preventDefault());
  airportList.addEventListener('click', (e) => { const li = e.target.closest('li'); if (!li) return; airport.value = li.textContent; window.airportChosen = li.textContent; airportList.hidden = true; airportList.innerHTML = ''; });
  // A tab that listens on the link inside it, not on itself.
  window.tabPressed = 0;
  document.getElementById('tab-a-link').addEventListener('click', (e) => { e.preventDefault(); window.tabPressed++; });
  // A thing to press that nothing marks as one: no role, no cursor, a listener only.
  document.getElementById('plus').addEventListener('click', () => { const n = document.getElementById('qty'); n.textContent = String(Number(n.textContent) + 1); });
  document.getElementById('spin').addEventListener('keydown', (e) => { if (e.key === 'ArrowUp') e.currentTarget.textContent = String(Number(e.currentTarget.textContent) + 1); });
  const q = document.getElementById('q'), qList = document.getElementById('q-list');
  q.addEventListener('input', () => { qList.hidden = false; qList.innerHTML = ['widgets on sale', 'widget parts'].map((c) => '<li role="option">' + c + '</li>').join(''); });
  // A dropdown built from a button and a list.
  const sort = document.getElementById('sort'), sortList = document.getElementById('sort-list');
  sort.addEventListener('click', () => { const open = sort.getAttribute('aria-expanded') === 'true'; sort.setAttribute('aria-expanded', String(!open)); sortList.hidden = open; });
  sortList.addEventListener('click', (e) => { const li = e.target.closest('[role=option]'); if (!li) return; sort.textContent = li.textContent; sort.setAttribute('aria-expanded', 'false'); sortList.hidden = true; });
  const lang = document.getElementById('lang'), langMenu = document.getElementById('lang-menu');
  lang.addEventListener('click', () => { const open = lang.getAttribute('aria-expanded') === 'true'; lang.setAttribute('aria-expanded', String(!open)); langMenu.hidden = open; });
  langMenu.addEventListener('click', (e) => { const o = e.target.closest('[role=option]'); if (!o) return; lang.textContent = o.textContent; lang.setAttribute('aria-expanded', 'false'); langMenu.hidden = true; });
  // A search made of several fields, each of which only keeps a chosen place.
  const trip = document.getElementById('trip'), tripMenu = document.getElementById('trip-menu');
  trip.addEventListener('click', () => { const open = trip.getAttribute('aria-expanded') === 'true'; trip.setAttribute('aria-expanded', String(!open)); tripMenu.hidden = open; });
  tripMenu.addEventListener('click', (e) => { const o = e.target.closest('[role=option]'); if (!o) return; trip.textContent = o.textContent; trip.setAttribute('aria-expanded', 'false'); tripMenu.hidden = true; });
  window.placeChosen = {};
  for (const id of ['from', 'to']) {
    const box = document.getElementById(id), list = document.getElementById(id + '-list');
    box.addEventListener('input', () => { window.placeChosen[id] = ''; list.hidden = false; list.innerHTML = ['London, United Kingdom', 'London Stansted Airport', 'London Gatwick Airport', 'New York, USA', 'Newark (EWR)'].filter((c) => c.toLowerCase().includes(box.value.toLowerCase())).map((c) => '<li role="option" tabindex="-1">' + c + '</li>').join(''); });
    list.addEventListener('click', (e) => { const li = e.target.closest('[role=option]'); if (!li) return; box.value = li.textContent; window.placeChosen[id] = li.textContent; list.hidden = true; list.innerHTML = ''; });
  }
  // A box that opens a larger one as typing starts and moves the cursor into it.
  const dest = document.getElementById('dest'), destLayer = document.getElementById('dest-layer'), destBig = document.getElementById('dest-big');
  dest.addEventListener('input', () => { dest.value = ''; destLayer.hidden = false; setTimeout(() => destBig.focus(), 30); });
  // A slider that only listens to the keyboard.
  const rating = document.getElementById('rating');
  rating.addEventListener('keydown', (e) => { let v = Number(rating.getAttribute('aria-valuenow')); if (e.key === 'ArrowRight' || e.key === 'ArrowUp') v++; else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') v--; else if (e.key === 'Home') v = 1; else if (e.key === 'End') v = 5; else return; rating.setAttribute('aria-valuenow', String(Math.max(1, Math.min(5, v)))); });
  // A field a framework owns: it keeps its own copy and writes it back.
  const ctl = document.getElementById('ctl'); window.ctlState = 'start';
  ctl.addEventListener('input', () => { window.ctlState = ctl.value; });
  setInterval(() => { if (ctl.value !== window.ctlState) ctl.value = window.ctlState; }, 30);
</script></body></html>`;

// Fields named only by the words beside them, rows that say the same
// thing, wordless shapes, a calendar, a menu that opens on the pointer, and
// controls that hold a number without a value of their own.
const MORE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>More widgets</title>
<style>body{font-family:system-ui;margin:16px} .sw{display:inline-block;width:30px;height:30px;margin:4px} #menu-bar ul{list-style:none;margin:0;padding:0}</style></head><body>
<section><div>Gender: <input id="gender"></div>
<table><tr><td>Last name</td><td><input id="last"></td></tr><tr><td>Plan</td><td><select id="plan-pick"><option>Basic</option><option>Pro</option></select></td></tr></table>
<div><input type="checkbox" id="offers"> Email me offers</div>
<div><span>Phone</span> <input id="phone-a"> <input id="phone-b"></div></section>

<section class="bets">${["-3", "7", "12", "0"].map((n) => `<div class="bet"><button type="button">Odd</button> <span>${n}</span> <button type="button">Even</button></div>`).join("")}</section>
<section class="tools">${["Copy", "Paste", "Cut"].map((w) => `<div class="tool"><button type="button">${w}</button> <span>2</span></div>`).join("")}</section>

<section><div class="sw" role="button" tabindex="0" style="background:rgb(229,57,53)"></div><div class="sw" role="button" tabindex="0" style="background:rgb(229,57,53)"></div>
<div class="sw" id="box-3" role="button" tabindex="0" style="background:#43a047"></div>
<svg role="button" tabindex="0" width="30" height="30"><circle cx="15" cy="15" r="12" fill="#1e88e5"></circle></svg>
<button id="menu-btn" class="menu-toggle" type="button" style="width:30px;height:20px"><span style="display:none">Open the folded entries</span></button></section>

<section><table id="cal"><tr>${Array.from({ length: 31 }, (_, i) => `<td><a href="#" class="cal-day">${i + 1}</a></td>`).join("")}</tr></table></section>

<section id="menu-bar"><ul><li id="products-item"><a id="products" href="/products" onclick="window.parentClicked = true; return false;">Products</a><ul id="products-menu" hidden><li><a href="/pricing">Pricing</a></li><li><a href="/docs">Docs</a></li></ul></li></ul></section>

<section><div style="display:flex;gap:8px;align-items:center"><span>Volume</span><div class="track" id="track" style="width:120px;height:6px;background:#ccc;cursor:pointer"><div id="knob" class="knob" tabindex="0" style="width:14px;height:14px;background:#333"></div></div><span id="knob-shown">3</span></div>
<div id="inert" tabindex="0" style="width:40px">Box</div>
<div id="spinb" role="spinbutton" aria-label="Rooms" aria-valuenow="2" aria-valuemin="0" aria-valuemax="9" tabindex="0">2</div>
<div id="tall" role="slider" aria-label="Height" aria-valuenow="1" aria-valuemin="0" aria-valuemax="9" tabindex="0" style="width:10px;height:60px;background:#ddd"></div></section>
<script>
  document.getElementById('products-item').addEventListener('mouseover', () => { document.getElementById('products-menu').hidden = false; });
  const shown = document.getElementById('knob-shown');
  document.getElementById('knob').addEventListener('keydown', (e) => { let v = Number(shown.textContent); if (e.key === 'ArrowRight') v++; else if (e.key === 'ArrowLeft') v--; else return; e.preventDefault(); shown.textContent = String(Math.max(0, Math.min(10, v))); });
  for (const id of ['spinb', 'tall']) document.getElementById(id).addEventListener('keydown', (e) => { const el = e.currentTarget; let v = Number(el.getAttribute('aria-valuenow')); if (e.key === 'ArrowUp') v++; else if (e.key === 'ArrowDown') v--; else return; e.preventDefault(); v = Math.max(0, Math.min(9, v)); el.setAttribute('aria-valuenow', String(v)); if (id === 'spinb') el.textContent = String(v); });
</script></body></html>`;

// A page that is never still by itself (a clock, a panel that rotates),
// whose buttons show something at once, after a progress bar, or after a
// request that takes three seconds with a spinner showing. There is no
// network view here (no extension), so this is the fallback's wait.
const SETTLE_PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Settle</title>
<style>@keyframes turn { to { transform: rotate(360deg); } } .spinner { width: 24px; height: 24px; border: 3px solid #ccc; border-top-color: #333; border-radius: 50%; animation: turn 0.8s linear infinite; }
@keyframes glow { 50% { opacity: .6; } } .ad { animation: glow 2s infinite; }</style></head><body>
<p>Now: <span id="clock">0</span></p><div id="ad" class="ad"><b>Offer 0</b></div>
<button id="quick" type="button">Show the note</button> <button id="report" type="button">Make the report</button> <button id="search" type="button">Search</button>
<div id="out"></div><div id="bar"></div><div id="wait"></div><ul id="results"></ul>
<script>
  let n = 0;
  setInterval(() => { document.getElementById('clock').textContent = String(++n); }, 1000);
  setInterval(() => { document.getElementById('ad').innerHTML = '<b>Offer ' + n + '</b>'; }, 700);
  document.getElementById('quick').onclick = () => { document.getElementById('out').innerHTML = '<a href="#note">Read the note</a>'; };
  document.getElementById('report').onclick = () => {
    const bar = document.getElementById('bar');
    bar.innerHTML = '<div role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" style="width:200px;height:8px;background:#ddd"></div>';
    let v = 0;
    const t = setInterval(() => { v += 10; bar.firstChild.setAttribute('aria-valuenow', String(v)); }, 300);
    setTimeout(() => { clearInterval(t); bar.innerHTML = ''; document.getElementById('out').innerHTML = '<button type="button">Open the report</button>'; }, 3000);
  };
  document.getElementById('search').onclick = async () => {
    document.getElementById('wait').innerHTML = '<div class="spinner"></div>';
    const list = await fetch('/api/slow').then((r) => r.json());
    document.getElementById('wait').innerHTML = '';
    document.getElementById('results').innerHTML = list.map((x) => '<li><a href="#' + x + '">' + x + '</a></li>').join('');
  };
</script></body></html>`;

// The real pointer, on a page of its own: CSS hover, a slider that holds
// the pointer, a list reordered by dragging, a drop zone, a drawing that
// takes a press at a point, a button something covers, and a box the page
// hides to draw its own.
const POINTER_PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Pointer</title>
<style>body{font-family:system-ui;margin:16px} .menu{display:inline-block;position:relative;padding:4px}
.menu > .sub{display:none;position:absolute;top:100%;left:0;background:#fff;border:1px solid #888;padding:6px}
.menu:hover > .sub{display:block}
#track{position:relative;width:300px;height:24px;background:#ddd;margin:24px 0}
#thumb{position:absolute;left:0;top:0;width:24px;height:24px;background:#36c;touch-action:none}
#sortable{padding:0;margin:0} #sortable li{padding:8px;margin:4px 0;background:#eef;list-style:none;width:200px;user-select:none;cursor:grab}
#zone{width:220px;height:80px;border:2px dashed #888;margin-top:16px}
#chip{display:inline-block;padding:6px;background:#fc9}
#spot{margin-top:1100px;border:1px solid #000;display:block}
.cover-wrap{position:relative;display:inline-block;margin-top:16px}
#veil{position:absolute;inset:-4px;background:rgba(255,255,255,.6)}</style></head><body>
<div class="menu" id="products-menu"><a href="#" id="products">Products</a><div class="sub"><a href="#" id="pricing" onclick="document.getElementById('chosen').textContent='Pricing chosen';return false;">Pricing</a></div></div>
<p id="chosen">Nothing chosen</p>
<div id="track"><div id="thumb" role="slider" aria-label="Volume" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" tabindex="0"></div></div>
<ul id="sortable"><li>Apples</li><li>Bananas</li><li>Cherries</li><li>Dates</li></ul>
<span id="chip" draggable="true">Invoice.pdf</span>
<div id="zone" tabindex="0" aria-label="Drop files here">Drop files here</div>
<div class="cover-wrap"><button id="under" type="button" onclick="window.underPressed=true">Hidden button</button><div id="veil"></div></div>
<div id="feed" style="height:60px;width:220px;overflow-y:auto;border:1px solid #888"><p style="height:140px;margin:0">Posts</p><button id="deep" type="button" onclick="window.deepPressed=(window.deepPressed||0)+1">Like</button></div>
<div id="ktrack" style="position:relative;width:200px;height:20px;background:#eee;margin-top:8px"><span id="knob2" tabindex="0" aria-label="Level knob" style="position:absolute;left:0;top:0;width:20px;height:20px;background:#963"></span></div><p>Level <b id="level">0</b></p>
<label id="remember-label"><input type="checkbox" id="remember" style="position:absolute;opacity:0;width:1px;height:1px;margin:0"> <span>Remember me</span></label>
<canvas id="spot" width="300" height="150"></canvas>
<script>
  // A knob that follows the pointer only while it holds it: a scripted
  // press has no pointer to hold, so setPointerCapture throws.
  const thumb = document.getElementById('thumb'), track = document.getElementById('track');
  let holding = false;
  thumb.addEventListener('pointerdown', (e) => { thumb.setPointerCapture(e.pointerId); holding = true; });
  thumb.addEventListener('pointermove', (e) => {
    if (!holding) return;
    const r = track.getBoundingClientRect();
    const left = Math.max(0, Math.min(276, e.clientX - r.left - 12));
    thumb.style.left = left + 'px';
    thumb.setAttribute('aria-valuenow', String(Math.round(left / 276 * 100)));
  });
  thumb.addEventListener('pointerup', (e) => { holding = false; thumb.releasePointerCapture(e.pointerId); });
  // A list reordered by pressing a row and moving it over the others.
  let lifted = null;
  const list = document.getElementById('sortable');
  list.addEventListener('mousedown', (e) => { const li = e.target.closest('li'); if (li) { lifted = li; e.preventDefault(); } });
  document.addEventListener('mousemove', (e) => {
    if (!lifted) return;
    const over = document.elementFromPoint(e.clientX, e.clientY);
    const li = over && over.closest('#sortable li');
    if (!li || li === lifted) return;
    const r = li.getBoundingClientRect();
    list.insertBefore(lifted, e.clientY >= r.top + r.height / 2 ? li.nextSibling : li);
  });
  document.addEventListener('mouseup', () => { lifted = null; });
  // A drop zone of the browser's own drag and drop.
  const chip = document.getElementById('chip'), zone = document.getElementById('zone');
  chip.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', 'invoice'));
  zone.addEventListener('dragover', (e) => e.preventDefault());
  zone.addEventListener('drop', (e) => { e.preventDefault(); window.dropped = e.dataTransfer.getData('text/plain'); zone.appendChild(chip); });
  // A knob with no value of its own, like a jQuery UI slider: the number it
  // moves is shown beside it.
  const knob2 = document.getElementById('knob2'), ktrack = document.getElementById('ktrack');
  let turning = false;
  knob2.addEventListener('mousedown', (e) => { turning = true; e.preventDefault(); });
  document.addEventListener('mousemove', (e) => {
    if (!turning) return;
    const left = Math.max(0, Math.min(180, e.clientX - ktrack.getBoundingClientRect().left - 10));
    knob2.style.left = left + 'px';
    document.getElementById('level').textContent = String(Math.round(left / 18));
  });
  document.addEventListener('mouseup', () => { turning = false; });
  // A drawing that records where it was pressed.
  const spot = document.getElementById('spot');
  window.spots = [];
  spot.addEventListener('click', (e) => window.spots.push([e.offsetX, e.offsetY, e.isTrusted]));
</script></body></html>`;

/**
 * The content script's request for the real pointer, answered as the
 * engine answers it: the gesture is run through the page's own debugger
 * session (puppeteer's), with no frame to place it in.
 */
async function bridgePointer(page) {
  const cdp = await page.createCDPSession();
  let caught = null;
  cdp.on("Input.dragIntercepted", (e) => { caught = e.data; });
  await page.exposeFunction("__s2aPointer", async (m) => {
    caught = null;
    const steps = (m.steps || []).map((s) => (s.t === "wait" ? s : { ...s, ...TOOLS.toViewport({ x: s.x, y: s.y }, null) }));
    const r = await TOOLS.runGesture(steps, { drag: !!m.drag, send: (method, params) => cdp.send(method, params), dragData: () => caught });
    return { ok: !r.error, sent: r.sent, dropped: r.dropped, error: r.error };
  });
}

async function open(browser, url, html, opts) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    if (req.url() === url) return req.respond({ status: 200, contentType: "text/html", body: html });
    // A request the server answers three seconds later.
    if (req.url() === new URL("/api/slow", url).href) return void setTimeout(() => req.respond({ status: 200, contentType: "application/json", body: JSON.stringify(["Flight 101", "Flight 202"]) }), 3000);
    return req.respond({ status: 404, body: "" });
  });
  await page.evaluateOnNewDocument(() => {
    window.chrome = window.chrome || {};
    // No engine answers, except for the pointer where the page has the bridge.
    window.chrome.runtime = {
      onMessage: { addListener: (fn) => { window.__s2aListener = fn; } },
      sendMessage: (m, cb) => {
        if (m && m.action === "agentPointer" && window.__s2aPointer) { window.__s2aPointer(m).then(cb, () => cb(undefined)); return; }
        if (typeof cb === "function") setTimeout(() => cb(undefined), 0);
      },
      getURL: (p) => p,
    };
  });
  if (opts && opts.realPointer) await bridgePointer(page);
  await page.goto(url, { waitUntil: "load" });
  for (const file of ["agentTools.js", "agentContentScript.js"]) await page.addScriptTag({ content: fs.readFileSync(path.join(EXT, file), "utf8") });
  const send = (msg) => page.evaluate((m) => new Promise((resolve) => window.__s2aListener(m, {}, resolve)), msg);
  return { page, send };
}

(async () => {
  const puppeteer = require("puppeteer");
  const browser = await puppeteer.launch({ headless: true, args: ["--no-first-run"] });
  const results = [];
  const settleTimes = [];
  try {
    const zoo = await open(browser, "https://zoo.example/", ZOO);
    const scan = await zoo.send({ action: "scan", limit: 500, task: "", whole: true });
    const refOf = (id) => zoo.page.evaluate((i) => Number(window.__selectToAiIdOf(document.getElementById(i))), id);
    const fill = async (id, value) => zoo.send({ action: "interact", data: { action: "fill", id: await refOf(id), value } });
    const get = (fn) => zoo.page.evaluate(fn);
    const check = async (name, fn) => {
      try { await fn(); results.push([name, null]); } catch (e) { results.push([name, String(e.message).split("\n").slice(0, 4).join(" | ")]); }
    };

    await check("every control on the page is listed, on screen or not", async () => {
      const ids = await get(() => [...document.querySelectorAll("input, select, textarea, button, [role=switch], [role=checkbox], [role=slider], [role=combobox], [contenteditable=true]")].filter((el) => !el.hidden && el.getBoundingClientRect().width > 0).map((el) => el.id).filter(Boolean));
      const listed = await get(() => window.__selectToAiListedElements().map((el) => el.id));
      const missing = ids.filter((i) => !listed.includes(i));
      assert.deepEqual(missing, [], `not listed: ${missing.join(", ")}`);
      assert.equal(await get(() => document.querySelectorAll("[data-select-to-ai-id]").length), 0, "no id attributes stamped on the DOM");
      assert.equal(await get(() => document.querySelectorAll(".select-to-ai-badge").length), 0, "nothing is drawn on the page");
      assert.equal(scan.whole, true);
    });
    await check("text box: replaces what was there", async () => {
      const r = await fill("name", "Ada Lovelace");
      assert.equal(await get(() => document.getElementById("name").value), "Ada Lovelace");
      assert.match(r.message, /now shows "Ada Lovelace"/);
    });
    await check("text area and rich text box", async () => {
      await fill("notes", "line one");
      await fill("rich", "Hello there");
      assert.equal(await get(() => document.getElementById("notes").value), "line one");
      assert.equal(await get(() => document.getElementById("rich").innerText.trim()), "Hello there");
    });
    await check("dropdown: by its label, by part of it, by its value; a wrong option lists the right ones", async () => {
      assert.equal((await fill("country", "Sweden")).shows, "Sweden");
      assert.equal(await get(() => document.getElementById("country").value), "se");
      await fill("country", "united");
      assert.equal(await get(() => document.getElementById("country").value), "us");
      await fill("country", "sg");
      assert.equal(await get(() => document.getElementById("country").value), "sg");
      const bad = await fill("country", "Norway");
      assert.equal(bad.success, false);
      assert.match(bad.error, /no option "Norway".*"Singapore", "Sweden", "United States"/);
      await fill("size", "Kids 8-10");
      assert.equal(await get(() => document.getElementById("size").value), "k");
    });
    await check("checkbox: on and off, and already-on stays on", async () => {
      assert.match((await fill("news", "on")).message, /is now on/);
      assert.equal(await get(() => document.getElementById("news").checked), true);
      await fill("terms", "on");
      assert.equal(await get(() => document.getElementById("terms").checked), true, "on stays on");
      await fill("terms", "off");
      assert.equal(await get(() => document.getElementById("terms").checked), false);
    });
    await check("radio: choosing one; it cannot be turned off by itself", async () => {
      await fill("plan-pro", "on");
      assert.equal(await get(() => document.querySelector("[name=plan]:checked").value), "pro");
      const off = await fill("plan-pro", "off");
      assert.equal(off.success, false);
    });
    await check("switch and checkbox built from other elements", async () => {
      await fill("dark", "on");
      await fill("gift", "true");
      assert.equal(await get(() => document.getElementById("dark").getAttribute("aria-checked")), "true");
      assert.equal(await get(() => document.getElementById("gift").getAttribute("aria-checked")), "true");
      await fill("dark", "on");
      assert.equal(await get(() => document.getElementById("dark").getAttribute("aria-checked")), "true", "on stays on");
    });
    await check("date and time: taken in their own form, and a wrong form says what is needed", async () => {
      assert.equal((await fill("start", "2026-12-18")).shows, "2026-12-18");
      const bad = await fill("start", "18 December");
      assert.equal(bad.success, false);
      assert.match(bad.error, /needs YYYY-MM-DD, from 2026-01-01/);
      await fill("at", "14:30");
      assert.equal(await get(() => document.getElementById("at").value), "14:30");
    });
    await check("slider and number boxes", async () => {
      await fill("vol", "8");
      assert.equal(await get(() => document.getElementById("vol").value), "8");
      await fill("guests", "4");
      await fill("pmin", "40");
      await fill("pmax", "60");
      assert.deepEqual(await get(() => ["guests", "pmin", "pmax"].map((i) => document.getElementById(i).value)), ["4", "40", "60"]);
    });
    await check("a field that offers choices: an exact or only match is chosen, an unclear one lists the choices", async () => {
      const r = await fill("city", "Stockholm");
      assert.equal(await get(() => window.cityChosen), "Stockholm (ARN)", r.message);
      const many = await fill("city", "Sin");
      assert.equal(await get(() => window.cityChosen), "", "nothing is chosen for the user when several match");
      assert.match(many.message, /\[\d+\] "Singapore \(SIN\)", \[\d+\] "Sindelfingen", \[\d+\] "Sint Maarten \(SXM\)"\. Nothing is chosen yet/);
      // The numbers are the ones the listing gives, so the choice is one click away.
      const ref = Number(many.message.match(/\[(\d+)\] "Sindelfingen/)[1]);
      await zoo.send({ action: "interact", data: { action: "click", id: ref } });
      assert.equal(await get(() => window.cityChosen), "Sindelfingen");
      await fill("city", "Singapore (SIN)");
      assert.equal(await get(() => window.cityChosen), "Singapore (SIN)");
    });
    await check("a list of suggestions with nothing marking it: found by what typing brings up", async () => {
      const r = await fill("airport", "CVG");
      assert.equal(await get(() => window.airportChosen), "Cincinnati, OH (CVG)", r.message);
      const many = await fill("airport", "Colum");
      assert.equal(await get(() => window.airportChosen), "");
      assert.match(many.message, /\[\d+\] "Columbus, OH \(CMH\)", \[\d+\] "Columbia, SC \(CAE\)"\. Nothing is chosen yet/);
      const ref = Number(many.message.match(/\[(\d+)\] "Columbia/)[1]);
      await zoo.send({ action: "interact", data: { action: "click", id: ref } });
      assert.equal(await get(() => window.airportChosen), "Columbia, SC (CAE)");
      // A plain box with no list is typed into and left, as before.
      const plain = await fill("pmin", "45");
      assert.match(plain.message, /now shows "45"/);
    });
    await check("a click starts at the innermost thing drawn at the control's middle", async () => {
      const id = await get(() => Number(window.__selectToAiIdOf(document.getElementById("tab-a"))));
      assert.ok(id, "the tab is listed");
      await zoo.send({ action: "interact", data: { action: "click", id } });
      assert.equal(await get(() => window.tabPressed), 1);
    });
    await check("an icon with no words is listed by what the page's markup calls it", async () => {
      const seen = await zoo.send({ action: "scan", limit: 500, task: "", whole: true });
      const line = seen.elements.map((e) => TOOLS.formatElementLine(e)).find((l) => /marked/.test(l)) || "";
      assert.match(line, /^\*?\[\d+\] span no name, marked "star icon-star" at \d+,\d+$/);
    });
    await check("a search box keeps what was typed, whatever it suggests", async () => {
      await fill("q", "widget");
      assert.equal(await get(() => document.getElementById("q").value), "widget");
    });
    await check("a dropdown built from a button and a list: chosen by its label", async () => {
      const r = await fill("sort", "Price: low to high");
      assert.equal(await get(() => document.getElementById("sort").textContent), "Price: low to high", r.message || r.error);
      await fill("lang", "Svenska");
      assert.equal(await get(() => document.getElementById("lang").textContent), "Svenska");
      const bad = await fill("sort", "Cheapest");
      assert.match(bad.message, /none is "Cheapest": \[\d+\] "Featured", \[\d+\] "Price: low to high"/);
    });
    await check("an option is matched by its words, whatever the punctuation", async () => {
      const r = await fill("trip", "One-way");
      assert.equal(await get(() => document.getElementById("trip").textContent), "One way", r.message || r.error);
      await fill("sort", "price (high to low)");
      assert.equal(await get(() => document.getElementById("sort").textContent), "Price: high to low");
    });
    await check("a search made of several fields: each takes its value from the choices it offers", async () => {
      // Three entries begin with "London"; only one is London itself, with its country after it.
      const r = await fill("to", "London");
      assert.equal(await get(() => window.placeChosen.to), "London, United Kingdom", r.message);
      const vague = await fill("to", "London S");
      assert.match(vague.message, /chose "London Stansted Airport"/, "an only match by its beginning is still chosen");
      const many = await fill("from", "New");
      assert.equal(await get(() => window.placeChosen.from), "");
      assert.match(many.message, /: \[\d+\] "New York, USA", \[\d+\] "Newark \(EWR\)"\. Nothing is chosen yet/);
      const none = await fill("from", "Zzyzx");
      assert.match(none.message, /takes its value from a list of choices, and none came up for "Zzyzx": nothing is chosen/);
    });
    await check("a link made to open in a new tab hands its address back; one the page handles itself does not", async () => {
      const r = await zoo.send({ action: "interact", data: { action: "click", id: await refOf("ext") } });
      assert.equal(r.opensTab, "https://zoo.example/other", JSON.stringify(r).slice(0, 200));
      const own = await zoo.send({ action: "interact", data: { action: "click", id: await refOf("spa") } });
      assert.equal(own.opensTab, undefined);
      assert.equal(await get(() => document.getElementById("spa").dataset.handled), "1");
    });
    await check("a native slider or checkbox the page draws over is listed with its state, once, and takes a value", async () => {
      const lines = scan.elements.map((e) => TOOLS.formatElementLine(e));
      assert.ok(lines.some((l) => /input\(range\) "Adults" value="2" min=1 max=30/.test(l)), lines.filter((l) => /Adults|pets/.test(l)).join(" | "));
      assert.ok(lines.some((l) => /input\(checkbox\) "Traveling with pets\?".*checked=false/.test(l)));
      assert.equal(lines.filter((l) => /Traveling with pets/.test(l)).length, 1, "the label is not listed beside its control");
      await fill("adults", "3");
      assert.equal(await get(() => document.getElementById("adults-shown").textContent), "3");
      await fill("pets", "on");
      assert.equal(await get(() => document.getElementById("pets").checked), true);
    });
    await check("what is on top of a page is found by where it sits: a notice built from plain boxes, and a box over the middle", async () => {
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Shop</title></head><body>
        <header style="position:fixed;top:0;left:0;right:0;height:50px;background:#eee"><nav><a href="/a">Home</a> <a href="/b">Deals</a></nav></header>
        <main style="margin-top:60px">${"<p>Blue widgets and other things for sale, with prices and reviews for each of them.</p>".repeat(30)}<button id="buy">Add to cart</button></main>
        <div id="cookies" style="position:fixed;left:0;right:0;bottom:0;height:90px;background:#222;color:#fff"><span>We use cookies to improve your experience.</span> <button id="reject">Reject all</button> <button id="accept">Accept all</button></div>
        <div id="veil" style="position:fixed;inset:0;background:rgba(0,0,0,.4)"><div style="position:absolute;left:340px;top:200px;width:600px;height:300px;background:#fff"><h2>Get 10% off</h2><input id="mail" aria-label="Email"><button id="close">No thanks</button></div></div>
      </body></html>`;
      const shop = await open(browser, "https://overlay.example/", html);
      // A box over the middle with a veil behind it covers everything else, the cookie notice included.
      const seen = await shop.send({ action: "scan", limit: 500, task: "", whole: true });
      assert.deepEqual(seen.overlays.map((o) => `${o.where}:${o.name}:${o.controls}`), ["middle:Get 10% off:2"], JSON.stringify(seen.overlays));
      assert.deepEqual(seen.elements.filter((e) => e.onTop).map((e) => TOOLS.elementLabel(e)).sort(), ["Email", "No thanks"]);
      assert.ok(!seen.elements.find((e) => TOOLS.elementLabel(e) === "Add to cart").onTop, "the page's own controls are under it");
      // Closed, the notice across the bottom is what is on top.
      await shop.page.evaluate(() => document.getElementById("veil").remove());
      const bar = await shop.send({ action: "scan", limit: 500, task: "", whole: true });
      assert.deepEqual(bar.overlays.map((o) => `${o.where}:${o.controls}`), ["bottom:2"], JSON.stringify(bar.overlays));
      assert.match(bar.overlays[0].name, /^We use cookies/);
      assert.deepEqual(bar.elements.filter((e) => e.onTop).map((e) => TOOLS.elementLabel(e)).sort(), ["Accept all", "Reject all"]);
      assert.ok(!bar.elements.find((e) => TOOLS.elementLabel(e) === "Deals").onTop, "the site's own bar of links is part of the page");
      await shop.page.evaluate(() => document.getElementById("cookies").remove());
      const after = await shop.send({ action: "scan", limit: 500, task: "", whole: true });
      assert.deepEqual(after.overlays, []);
      await shop.page.close();
    });
    await check("an action's result names what it brought up, by the numbers the listing will use", async () => {
      await zoo.send({ action: "scan", limit: 500, task: "", whole: true });
      const r = await zoo.send({ action: "interact", data: { action: "click", id: await refOf("sort") } });
      assert.ok(Array.isArray(r.appeared) && r.appeared.length >= 4, JSON.stringify(r).slice(0, 300));
      assert.match(r.appeared.join(" | "), /\[\d+\] li "Price: low to high" role=option/);
      const next = await zoo.send({ action: "scan", limit: 500, task: "", whole: true });
      assert.ok(next.elements.some((e) => e.isNew && TOOLS.elementLabel(e) === "Price: low to high"), "and they are still marked as new in the next listing");
      await zoo.send({ action: "interact", data: { action: "click", id: await refOf("sort") } });
    });
    await check("a field that keeps what was typed only when it is left gets left", async () => {
      await fill("depart", "Dec 26, 2026");
      assert.equal(await get(() => document.getElementById("depart-set").textContent), "Dec 26, 2026");
      // A field waiting for a choice from its list is not left: the list would close.
      await fill("city", "Sin");
      assert.equal(await get(() => document.getElementById("city-list").hidden), false);
      await fill("city", "Stockholm");
    });
    await check("typing follows the cursor when the page moves it to another box", async () => {
      const r = await fill("dest", "London");
      assert.equal(await get(() => document.getElementById("dest-big").value), "London", r.message || r.error);
      assert.match(r.message, /moved the cursor to another box \("Where else\?"\)/);
    });
    await check("a menu built from plain buttons: what pressing the control brings up is what it offers", async () => {
      await zoo.send({ action: "scan", limit: 500, task: "", whole: true });
      const r = await fill("order", "Recently updated");
      assert.equal(await get(() => document.getElementById("order").textContent), "Sort: Recently updated", r.message || r.error);
      await zoo.send({ action: "scan", limit: 500, task: "", whole: true });
      const bad = await fill("order", "Oldest");
      assert.match(bad.message, /none is "Oldest": \[\d+\] "Most likes", \[\d+\] "Recently updated"/);
      await zoo.page.evaluate(() => { document.getElementById("order-menu").hidden = true; document.getElementById("order").setAttribute("aria-expanded", "false"); });
    });
    await check("page numbers are links to follow; footnote numbers are not", async () => {
      const pages = scan.elements.filter((e) => e.tagName === "a" && /^[123]$/.test(TOOLS.elementLabel(e)));
      assert.equal(pages.length, 3, "the pager's 1, 2 and 3");
      assert.ok(!scan.elements.some((e) => TOOLS.elementLabel(e) === "7"), "a raised number pointing at a note is left out");
      assert.equal(scan.elements.filter((e) => /^1[45]$/.test(TOOLS.elementLabel(e))).length, 2, "the days of a calendar are buttons written as links");
    });
    await check("a link written as a button is listed; a link to a spot on the same page is not", async () => {
      const labels = scan.elements.map((e) => TOOLS.elementLabel(e));
      assert.ok(labels.includes("Closed 30"), 'href="#" does something when pressed');
      assert.ok(labels.includes("Settings"), "a fragment nothing on the page answers to is an app's own address");
      assert.ok(!labels.includes("Jump to reviews"), "a table-of-contents link only scrolls");
      await zoo.send({ action: "interact", data: { action: "click", id: await refOf("tab-closed") } });
      assert.equal(await get(() => document.getElementById("tab-closed").dataset.pressed), "1");
    });
    await check("typing goes to the box that is drawn over a field, when one is", async () => {
      // The larger box is already open over the field, as after a click on it.
      await zoo.page.evaluate(() => {
        const dest = document.getElementById("dest"), big = document.getElementById("dest-big"), layer = document.getElementById("dest-layer");
        big.value = "";
        layer.hidden = false;
        const r = dest.getBoundingClientRect();
        layer.style.cssText = `position:absolute;left:${r.left + window.scrollX}px;top:${r.top + window.scrollY}px;z-index:5`;
      });
      const r = await fill("dest", "Paris");
      assert.equal(await get(() => document.getElementById("dest-big").value), "Paris", r.message || r.error);
      await zoo.page.evaluate(() => { const layer = document.getElementById("dest-layer"); layer.hidden = true; layer.style.cssText = ""; });
    });
    await check("a slider that only listens to the keyboard", async () => {
      const r = await fill("rating", "4");
      assert.equal(await get(() => document.getElementById("rating").getAttribute("aria-valuenow")), "4", r.message || r.error);
    });
    await check("a field a framework owns keeps the value", async () => {
      await fill("ctl", "typed by the agent");
      await new Promise((r) => setTimeout(r, 120));
      assert.equal(await get(() => document.getElementById("ctl").value), "typed by the agent");
    });
    await check("a read-only box that opens its own picker says typing did nothing", async () => {
      const r = await fill("pickup", "2026-12-18");
      assert.equal(r.success, false);
      assert.match(r.error, /did not take/);
    });
    await check("a click says what the control shows afterwards; a read-only box says so in the listing", async () => {
      const id = await get(() => Number(window.__selectToAiIdOf(document.getElementById("gift"))));
      const was = await get(() => document.getElementById("gift").getAttribute("aria-checked") === "true");
      const one = await zoo.send({ action: "interact", data: { action: "click", id } });
      assert.ok(one.message.endsWith(`[${id}] is now ${was ? "not checked" : "checked"}.`), one.message);
      const two = await zoo.send({ action: "interact", data: { action: "click", id } });
      assert.ok(two.message.endsWith(`[${id}] is now ${was ? "checked" : "not checked"}.`), two.message);
      const seen = await zoo.send({ action: "scan", limit: 500, task: "", whole: true });
      const lines = seen.elements.map((e) => TOOLS.formatElementLine(e));
      assert.ok(lines.some((l) => /Pick a date/.test(l) && / read-only/.test(l)), "the pickup box is listed as read-only");
      assert.ok(!lines.some((l) => /"Tab A"/.test(l) && /→/.test(l)), "a link to this same page names no address");
    });
    await check("a click that changes nothing is measured as changing nothing", async () => {
      const id = await get(() => Number(window.__selectToAiIdOf(document.getElementById("icon-star"))));
      const r = await zoo.send({ action: "interact", data: { action: "click", id } });
      assert.equal(r.outcome.domMutationCount, 0, "the agent's own cursor and numbers are not counted");
      assert.equal(r.outcome.noEffect, true);
    });
    await check("scroll with a control scrolls the box that control is in", async () => {
      const id = await get(() => Number(window.__selectToAiIdOf(document.getElementById("terms-ok"))));
      assert.ok(id, "a control inside the box is listed");
      const top = await get(() => window.scrollY);
      let r = null;
      for (let i = 0; i < 12; i++) { r = await zoo.send({ action: "interact", data: { action: "scroll", id, scrollTarget: id, scrollDirection: "down" } }); if (/bottom/.test(r.message)) break; }
      assert.match(r.message, /That is the bottom|already at the bottom/, r.message);
      assert.ok(await get(() => document.getElementById("termsbox").scrollTop) > 300, r.message + " top=" + await get(() => document.getElementById("termsbox").scrollTop + "/" + document.getElementById("termsbox").scrollHeight));
      assert.equal(await get(() => window.scrollY), top, "the page itself did not move");
      const up = await zoo.send({ action: "interact", data: { action: "scroll", id, scrollTarget: id, scrollDirection: "top" } });
      assert.match(up.message, /Scrolled to the top of the box around/);
      assert.equal(await get(() => document.getElementById("termsbox").scrollTop), 0);
      const end = await zoo.send({ action: "interact", data: { action: "scroll", id, scrollTarget: id, scrollDirection: "bottom" } });
      assert.match(end.message, /Scrolled to the bottom of the box around/);
      assert.ok(await get(() => { const b = document.getElementById("termsbox"); return b.scrollTop + b.clientHeight >= b.scrollHeight - 2; }));
    });
    await check("scroll on a page whose window never scrolls moves the main box inside it, and says which", async () => {
      const rows = Array.from({ length: 60 }, (_, i) => `<p>Message ${i + 1} <button>Open ${i + 1}</button></p>`).join("");
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Mail</title>
        <style>html,body{margin:0;height:100%;overflow:hidden} .app{display:flex;height:100vh} nav{width:200px;overflow-y:auto} main{flex:1;overflow-y:scroll}</style></head><body>
        <div class="app"><nav aria-label="Folders">${"<div>Folder</div>".repeat(80)}</nav><main id="pane" aria-label="Inbox">${rows}</main></div></body></html>`;
      const app = await open(browser, "https://app.example/", html);
      const at = () => app.page.evaluate(() => ({ pane: document.getElementById("pane").scrollTop, win: window.scrollY, nav: document.querySelector("nav").scrollTop }));
      const seen = await app.send({ action: "scan", limit: 500, task: "" });
      assert.ok((seen.hiddenControls || {}).below > 0, "controls further down the box are counted as below: " + JSON.stringify(seen.hiddenControls));
      const down = await app.send({ action: "interact", data: { action: "scroll", scrollDirection: "down" } });
      assert.match(down.message, /^Scrolled the part "Inbox" down\. Screen \d of 3 of it\.$/, down.message);
      let now = await at();
      assert.ok(now.pane > 300 && now.win === 0 && now.nav === 0, JSON.stringify(now));
      const end = await app.send({ action: "interact", data: { action: "scroll", scrollDirection: "bottom" } });
      assert.equal(end.message, 'Scrolled to the bottom of the part "Inbox".');
      const again = await app.send({ action: "interact", data: { action: "scroll", scrollDirection: "down" } });
      assert.match(again.message, /^Nothing moved: the page is already at the bottom\./, again.message);
      const top = await app.send({ action: "interact", data: { action: "scroll", scrollDirection: "top" } });
      assert.equal(top.message, 'Scrolled to the top of the part "Inbox".');
      now = await at();
      assert.equal(now.pane, 0);
      await app.page.close();
    });
    await check("scroll on a page whose window scrolls moves the window, even beside a small list with its own bar", async () => {
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Shop</title></head><body>
        <div id="side" style="position:fixed;right:0;top:0;width:200px;height:200px;overflow-y:auto">${"<div>Filter</div>".repeat(60)}</div>
        ${"<p>Blue widgets and other things for sale, with prices and reviews.</p>".repeat(200)}</body></html>`;
      const shop = await open(browser, "https://window.example/", html);
      const down = await shop.send({ action: "interact", data: { action: "scroll", scrollDirection: "down" } });
      assert.match(down.message, /^Scrolled down\. Screen \d of \d+ of the page is in view\.$/, down.message);
      assert.ok(await shop.page.evaluate(() => window.scrollY) > 300);
      assert.equal(await shop.page.evaluate(() => document.getElementById("side").scrollTop), 0, "the small list did not move");
      const end = await shop.send({ action: "interact", data: { action: "scroll", scrollDirection: "bottom" } });
      assert.equal(end.message, "Scrolled to the bottom of the page.");
      const again = await shop.send({ action: "interact", data: { action: "scroll", scrollDirection: "down" } });
      assert.match(again.message, /^Nothing moved: the page is already at the bottom\./);
      const top = await shop.send({ action: "interact", data: { action: "scroll", scrollDirection: "top" } });
      assert.equal(top.message, "Scrolled to the top of the page.");
      await shop.page.close();
    });
    await check("find gives a number to a piece of text nothing marks as a control, symbols included", async () => {
      const before = await zoo.send({ action: "scan", limit: 500, task: "", whole: true });
      assert.ok(!before.elements.some((e) => e.text === "+"), "it is not listed before it is looked for");
      const res = await zoo.send({ action: "find", query: "+" });
      assert.equal(res.refs.length, 1, JSON.stringify(res));
      await zoo.send({ action: "interact", data: { action: "click", id: res.refs[0].id } });
      assert.equal(await get(() => document.getElementById("qty").textContent), "1");
      const after = await zoo.send({ action: "scan", limit: 500, task: "", whole: true });
      assert.ok(after.elements.some((e) => e.text === "+"), "it stays in the listing");
    });
    await check("a row of separate labels is listed label by label; a hover-only pointer counts", async () => {
      const seen = await zoo.send({ action: "scan", limit: 500, task: "", whole: true });
      const texts = seen.elements.map((e) => e.text);
      assert.ok(texts.includes("Reply") && texts.includes("Forward"), "each label is its own control");
      assert.ok(!texts.some((t) => /Reply\s+Forward/.test(t)), "the row itself is not one control");
      assert.ok(texts.includes("Like"), "the hover-only pointer is listed");
    });
    await check("a key can be pressed several times in one action", async () => {
      const id = await get(() => Number(window.__selectToAiIdOf(document.getElementById("spin"))));
      const r = await zoo.send({ action: "interact", data: { action: "keypress", id, text: "ArrowUp", times: 6 } });
      assert.match(r.message, /Pressed ArrowUp 6 times/);
      assert.equal(await get(() => document.getElementById("spin").textContent), "6");
    });
    // Text typed where the cursor is, as an editor hears it: beforeinput,
    // then the browser's own edit, which a page may take over by cancelling
    // beforeinput. A key the page leaves alone does what the browser does.
    const EDITING = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Editing</title></head><body>
      <div id="plain" contenteditable="true" aria-label="Draft" style="border:1px solid #888;min-height:40px"><p>Hello world</p></div>
      <div id="self" contenteditable="true" aria-label="Self" style="border:1px solid #888;min-height:20px"></div>
      <input id="line" aria-label="Line" value="abc">
      <div id="spot" role="button" aria-label="Spot" style="width:40px;height:20px;background:#ccc"></div>
      <div id="knob" role="slider" tabindex="0" aria-label="Knob" aria-valuenow="7" aria-valuemin="0" aria-valuemax="10" style="width:80px;height:10px;background:#ddd"></div>
      <button id="mute" type="button" aria-pressed="true">Mute</button>
      <script>
        window.selfTyped = '';
        document.getElementById('self').addEventListener('beforeinput', (e) => { if (e.inputType !== 'insertText') return; e.preventDefault(); window.selfTyped += e.data; document.getElementById('self').textContent = window.selfTyped; });
        window.pageKeys = 0;
        document.addEventListener('keydown', () => { window.pageKeys += 1; });
      </script></body></html>`;
    const ed = await open(browser, "https://editing.example/", EDITING);
    const edScan = await ed.send({ action: "scan", limit: 500, task: "", whole: true });
    const edRef = (i) => ed.page.evaluate((x) => Number(window.__selectToAiIdOf(document.getElementById(x))), i);
    const edDo = async (action, i, more) => ed.send({ action: "interact", data: { action, id: await edRef(i), ...more } });
    await check("type puts text at the end of an editable region, and keys the page leaves alone type, break lines and format", async () => {
      let r = await edDo("insertText", "plain", { value: " again" });
      assert.equal(r.success, true, r.error);
      assert.match(r.message, /at the end of its text/);
      r = await edDo("keypress", "plain", { text: "!" });
      assert.equal(await ed.page.evaluate(() => document.getElementById("plain").innerText.trim()), "Hello world again!", r.message);
      r = await edDo("insertText", "plain", { value: "\nNext line" });
      assert.match(r.message, /now has 2 lines; the last 2 read "Hello world again!", "Next line"/, r.message || r.error);
      r = await edDo("selectText", "plain", { value: "world" });
      assert.match(r.message, /"world" is selected, and has no bold/, r.message || r.error);
      r = await edDo("keypress", "plain", { text: "ctrl+b" });
      assert.match(r.message, /"world" is selected, and is bold/, r.message);
      assert.equal(await ed.page.evaluate(() => (document.querySelector("#plain b, #plain strong") || {}).textContent), "world");
      r = await edDo("keypress", "plain", { text: "Backspace" });
      assert.doesNotMatch(await ed.page.evaluate(() => document.getElementById("plain").innerText), /world/, r.message);
    });
    await check("an editor that puts typed text in itself is not given it twice", async () => {
      const r = await edDo("insertText", "self", { value: "hey" });
      assert.equal(r.success, true, r.error);
      assert.equal(await ed.page.evaluate(() => [window.selfTyped, document.getElementById("self").textContent].join("|")), "hey|hey");
    });
    await check("type into a one-line box goes after its text; Backspace deletes there", async () => {
      await edDo("insertText", "line", { value: "def" });
      await edDo("keypress", "line", { text: "Backspace" });
      assert.equal(await ed.page.evaluate(() => document.getElementById("line").value), "abcde");
      const multi = await edDo("insertText", "line", { value: "a\nb" });
      assert.match(multi.error, /one-line box/);
    });
    await check("a key named for a control that cannot hold the focus is not sent to the page as a whole; Escape is, and says so", async () => {
      const before = await ed.page.evaluate(() => window.pageKeys);
      const r = await edDo("keypress", "spot", { text: "ArrowRight" });
      assert.equal(r.success, false);
      assert.match(r.error, /cannot take the keyboard focus, so ArrowRight would go to the page as a whole/);
      assert.equal(await ed.page.evaluate(() => window.pageKeys), before, "no key reached the page");
      const esc = await edDo("keypress", "spot", { text: "Escape" });
      assert.match(esc.message, /cannot take the keyboard focus, so it went to/);
      const none = await ed.send({ action: "interact", data: { action: "keypress", text: "x" } });
      assert.match(none.message, /Pressed x (on the page as a whole|in \[\d+\], which has the keyboard focus|in .*, which has the keyboard focus)/);
    });
    await check("the listing reads back a slider's value, a toggle's pressed state and an editor's text", async () => {
      const lines = (await ed.send({ action: "scan", limit: 500, task: "", whole: true })).elements.map((e) => TOOLS.formatElementLine(e));
      assert.ok(lines.some((l) => /div "Knob" role=slider value="7" min=0 max=10/.test(l)), lines.join(" | "));
      assert.ok(lines.some((l) => /button "Mute" pressed=true/.test(l)), lines.join(" | "));
      assert.ok(lines.some((l) => /"Draft" value="Hello/.test(l)), lines.join(" | "));
      assert.ok(edScan.elements.length > 0);
    });
    await check("a plain button does not hold a value", async () => {
      const r = await fill("plain", "x");
      assert.equal(r.success, false);
      assert.match(r.error, /does not hold a value\. Use click/);
    });

    const busy = await open(browser, "https://settle.example/", SETTLE_PAGE);
    await busy.send({ action: "scan", limit: 500, task: "", whole: true });
    const busyRef = (id) => busy.page.evaluate((i) => Number(window.__selectToAiIdOf(document.getElementById(i))), id);
    const pressBusy = async (id) => busy.send({ action: "interact", data: { action: "click", id: await busyRef(id) } });
    // The page is left alone for as long as a model takes to answer, so what it does by itself is seen.
    await new Promise((r) => setTimeout(r, 2500));
    await check("a press that changes the page at once is not held by a clock and a rotating panel", async () => {
      const r = await pressBusy("quick");
      assert.equal(r.success, true, r.error);
      assert.equal(r.settle.loading, false, JSON.stringify(r.settle));
      assert.ok(r.settle.ms < 1500, `waited ${r.settle.ms} ms`);
      assert.match((r.appeared || []).join(" | "), /Read the note/);
      settleTimes.push(`press on a busy page: ${r.settle.ms} ms`);
    });
    await check("a progress bar the press brings up is waited for until it goes", async () => {
      await new Promise((r) => setTimeout(r, 1500));
      const r = await pressBusy("report");
      assert.equal(r.settle.loading, false, JSON.stringify(r.settle));
      assert.ok(r.settle.ms >= 2800, `waited only ${r.settle.ms} ms`);
      assert.match((r.appeared || []).join(" | "), /Open the report/);
      settleTimes.push(`progress bar: ${r.settle.ms} ms`);
    });
    await check("without the network view, a spinner holds the wait for results three seconds away", async () => {
      await new Promise((r) => setTimeout(r, 1500));
      const r = await pressBusy("search");
      assert.equal(r.settle.network, false);
      assert.equal(r.settle.loading, false, JSON.stringify(r.settle));
      assert.ok(r.settle.ms >= 2800 && r.settle.ms < TOOLS.SETTLE.FALLBACK_MS, `waited ${r.settle.ms} ms`);
      assert.match((r.appeared || []).join(" | "), /Flight 101/);
      settleTimes.push(`spinner, no network view: ${r.settle.ms} ms`);
    });
    await check("a page busy past the cap is reported as still loading", async () => {
      await busy.page.evaluate(() => { document.getElementById('report').onclick = () => { document.getElementById('bar').innerHTML = '<progress></progress>'; }; });
      const r = await pressBusy("report");
      assert.equal(r.settle.loading, true, JSON.stringify(r.settle));
      assert.ok(r.settle.ms >= TOOLS.SETTLE.FALLBACK_MS && r.settle.ms < TOOLS.SETTLE.FALLBACK_MS + 1000, `waited ${r.settle.ms} ms`);
      assert.match(TOOLS.stillLoadingNote(r.settle.ms, r.settle.signs), /^The page was still loading after 8(\.\d)? seconds: a progress bar is showing\.$/);
    });

    const more = await open(browser, "https://more.example/", MORE);
    const moreScan = () => more.send({ action: "scan", limit: 500, task: "", whole: true });
    const seenMore = await moreScan();
    const entryOf = (scanned, id) => more.page.evaluate((i) => Number(window.__selectToAiIdOf(document.getElementById(i))), id).then((ref) => scanned.elements.find((e) => e.id === ref));
    const fillMore = async (id, value) => more.send({ action: "interact", data: { action: "fill", id: await more.page.evaluate((i) => Number(window.__selectToAiIdOf(document.getElementById(i))), id), value } });
    await check("a field with no label of its own is named by the words beside it, not by another field's", async () => {
      const names = {};
      for (const id of ["gender", "last", "plan-pick", "offers", "phone-a", "phone-b"]) names[id] = (await entryOf(seenMore, id)).accName;
      assert.deepEqual(names, { gender: "Gender", last: "Last name", "plan-pick": "Plan", offers: "Email me offers", "phone-a": "Phone", "phone-b": "" });
    });
    await check("controls that read the same are told apart by the words of their row; unique ones are left as they are", async () => {
      const listing = TOOLS.formatElementList(seenMore.elements);
      for (const n of ["-3", "7", "12", "0"]) assert.match(listing, new RegExp(`item "Odd ${n} Even":\\n  \\[\\d+\\] button "Odd"\\n  \\[\\d+\\] button "Even"`), listing.slice(0, 600));
      const tools = seenMore.elements.filter((e) => ["Copy", "Paste", "Cut"].includes(TOOLS.elementLabel(e)));
      assert.equal(tools.length, 3);
      assert.ok(tools.every((e) => !e.group), JSON.stringify(tools.map((e) => e.group)));
    });
    await check("a wordless control says its colour and where it is", async () => {
      const lines = seenMore.elements.map((e) => TOOLS.formatElementLine(e));
      const reds = lines.filter((l) => / div no name, red at \d+,\d+$/.test(l));
      assert.equal(reds.length, 2, lines.filter((l) => /no name/.test(l)).join(" | "));
      assert.notEqual(reds[0].split(" at ")[1], reds[1].split(" at ")[1], "two identical shapes are told apart by where they are");
      assert.ok(lines.some((l) => / div no name, green, marked "box-3" at \d+,\d+$/.test(l)), lines.filter((l) => /no name/.test(l)).join(" | "));
      assert.ok(lines.some((l) => / svg no name, blue at \d+,\d+$/.test(l)), lines.filter((l) => /no name/.test(l)).join(" | "));
      const named = lines.find((l) => /"Last name"/.test(l));
      assert.ok(!/ at \d/.test(named), "a control with words is not given a position");
    });
    await check("words that are not drawn are not a control's label", async () => {
      const menu = await entryOf(seenMore, "menu-btn");
      assert.equal(menu.text, "");
      assert.doesNotMatch(TOOLS.formatElementLine(menu), /folded entries/);
    });
    await check("the days of a calendar written as links are all listed", async () => {
      const days = seenMore.elements.filter((e) => e.tagName === "a" && /^\d{1,2}$/.test(TOOLS.elementLabel(e)));
      assert.equal(days.length, 31);
    });
    await check("hover opens a menu that opens on the pointer, names what it brought up, and presses nothing", async () => {
      const id = (await entryOf(seenMore, "products")).id;
      const r = await more.send({ action: "interact", data: { action: "hover", id } });
      assert.equal(r.success, true, r.error);
      assert.match((r.appeared || []).join(" | "), /\[\d+\] a "Pricing"/, JSON.stringify(r).slice(0, 300));
      assert.equal(await more.page.evaluate(() => !!window.parentClicked), false, "the parent item was not clicked");
      assert.equal(await more.page.evaluate(() => location.pathname), "/");
    });
    await check("a spin box steps up and down; a slider that only takes up and down still moves", async () => {
      const spin = await fillMore("spinb", "5");
      assert.equal(await more.page.evaluate(() => document.getElementById("spinb").getAttribute("aria-valuenow")), "5", spin.message || spin.error);
      const tall = await fillMore("tall", "6");
      assert.equal(await more.page.evaluate(() => document.getElementById("tall").getAttribute("aria-valuenow")), "6", tall.message || tall.error);
    });
    await check("a handle with no value of its own is set by the number its arrow keys move", async () => {
      const r = await fillMore("knob", "7");
      assert.equal(await more.page.evaluate(() => document.getElementById("knob-shown").textContent), "7", r.message || r.error);
      assert.match(r.message, /now shows "7"/);
      const down = await fillMore("knob", "1");
      assert.equal(await more.page.evaluate(() => document.getElementById("knob-shown").textContent), "1", down.message || down.error);
      // The number may be given to the track around the knob: the knob inside takes the keys.
      const outer = await fillMore("track", "4");
      assert.equal(await more.page.evaluate(() => document.getElementById("knob-shown").textContent), "4", outer.message || outer.error);
      const none = await fillMore("inert", "5");
      assert.equal(none.success, false);
      assert.match(none.error, /arrow keys did not move it/);
    });

    const ptr = await open(browser, "https://pointer.example/", POINTER_PAGE, { realPointer: true });
    await ptr.send({ action: "scan", limit: 500, task: "", whole: true });
    const ptrRef = (id) => ptr.page.evaluate((i) => Number(window.__selectToAiIdOf(document.getElementById(i))), id);
    const ptrDo = async (data) => ptr.send({ action: "interact", data });
    await check("real pointer: hover opens a menu that only CSS :hover opens, and the item in it is clicked", async () => {
      const r = await ptrDo({ action: "hover", id: await ptrRef("products") });
      assert.equal(r.success, true, r.error);
      assert.equal(r.pointer, "real");
      assert.match((r.appeared || []).join(" | "), /"Pricing"/, JSON.stringify(r).slice(0, 300));
      await ptr.send({ action: "scan", limit: 500, task: "", whole: true });
      const c = await ptrDo({ action: "click", id: await ptrRef("pricing") });
      assert.equal(c.pointer, "real", c.error);
      assert.equal(await ptr.page.evaluate(() => document.getElementById("chosen").textContent), "Pricing chosen", c.message || c.error);
    });
    await check("real pointer: a slider that captures the pointer is set by drag, and the result says its value", async () => {
      const r = await ptrDo({ action: "drag", id: await ptrRef("thumb"), direction: "right", distance: 150 });
      assert.equal(r.success, true, r.error);
      assert.equal(r.pointer, "real");
      const v = Number(await ptr.page.evaluate(() => document.getElementById("thumb").getAttribute("aria-valuenow")));
      assert.ok(v >= 50 && v <= 58, `value ${v}`);
      assert.match(r.message, new RegExp(`is now .*"${v}"`), r.message);
    });
    await check("real pointer: a row of a list is dragged onto another, and the result says where it is now", async () => {
      await ptr.send({ action: "scan", limit: 500, task: "", whole: true });
      const rows = await ptr.page.evaluate(() => [...document.querySelectorAll("#sortable li")].map((li) => Number(window.__selectToAiIdOf(li))));
      assert.ok(rows.every((n) => n > 0), `rows that can be grabbed are listed: ${rows}`);
      const r = await ptrDo({ action: "drag", id: rows[0], to: rows[2] });
      assert.equal(r.success, true, r.error);
      // Let go over the middle of Cherries: before or after it, as the list decides, and said as it is.
      const order = await ptr.page.evaluate(() => [...document.querySelectorAll("#sortable li")].map((li) => li.textContent));
      const place = order.indexOf("Apples") + 1;
      assert.ok(place === 2 || place === 3, JSON.stringify(order));
      assert.match(r.message, new RegExp(`is now ${["", "1st", "2nd", "3rd"][place]} of 4 in its list \\(it was 1st\\)`), r.message);
    });
    await check("real pointer: a drag and drop of the browser's own is carried to the drop zone", async () => {
      await ptr.send({ action: "scan", limit: 500, task: "", whole: true });
      const r = await ptrDo({ action: "drag", id: await ptrRef("chip"), to: await ptrRef("zone") });
      assert.equal(r.success, true, r.error);
      assert.equal(await ptr.page.evaluate(() => window.dropped || ""), "invoice", r.message);
      assert.match(r.message, /is now in \[\d+\] "Drop files here/, r.message);
    });
    await check("real pointer: a button something is drawn over is reported as covered, and not pressed", async () => {
      const r = await ptrDo({ action: "click", id: await ptrRef("under") });
      assert.equal(r.success, false);
      assert.match(r.error, /is covered: a div with no words is drawn over it/, r.error);
      assert.equal(await ptr.page.evaluate(() => !!window.underPressed), false);
    });
    await check("real pointer: a button scrolled out of a box that scrolls inside the page is scrolled to and pressed, not called covered", async () => {
      await ptr.page.evaluate(() => { window.scrollTo(0, 0); document.getElementById("feed").scrollTop = 0; });
      // The case itself: inside the window, cut off by the box, and only the page drawn at its middle.
      const before = await ptr.page.evaluate(() => { const r = document.getElementById("deep").getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { inWindow: r.bottom < innerHeight, top: top && top.id }; });
      assert.equal(before.inWindow, true);
      assert.notEqual(before.top, "deep");
      const r = await ptrDo({ action: "click", id: await ptrRef("deep") });
      assert.equal(r.success, true, r.error);
      assert.equal(r.pointer, "real", JSON.stringify(r).slice(0, 300));
      assert.equal(await ptr.page.evaluate(() => window.deepPressed || 0), 1, r.message);
    });
    await check("real pointer: a knob with no value of its own is dragged, and the result says the number it moved", async () => {
      await ptr.send({ action: "scan", limit: 500, task: "", whole: true });
      const r = await ptrDo({ action: "drag", id: await ptrRef("knob2"), direction: "right", distance: 90 });
      assert.equal(r.success, true, r.error);
      const level = await ptr.page.evaluate(() => document.getElementById("level").textContent);
      assert.notEqual(level, "0", r.message);
      assert.match(r.message, new RegExp(`went from 0 to ${level}`), r.message);
      assert.match(r.message, /moved \d+ px right/, r.message);
    });
    await check("real pointer: a box the page hides to draw its own is pressed by its label", async () => {
      const r = await ptrDo({ action: "click", id: await ptrRef("remember") });
      assert.equal(r.success, true, r.error);
      assert.equal(await ptr.page.evaluate(() => document.getElementById("remember").checked), true, r.message);
    });
    await check("real pointer: click_at presses a drawing at a point in page pixels, below the fold", async () => {
      const box = await ptr.page.evaluate(() => { window.scrollTo(0, 0); const r = document.getElementById("spot").getBoundingClientRect(); return { x: r.left + window.scrollX + 1, y: r.top + window.scrollY + 1 }; });
      const r = await ptrDo({ action: "click_at", x: Math.round(box.x + 190), y: Math.round(box.y + 55), expect: { ref: await ptrRef("spot").then((n) => n || null) } });
      assert.equal(r.success, true, r.error);
      assert.equal(r.pointer, "real");
      const spots = await ptr.page.evaluate(() => window.spots);
      assert.equal(spots.length, 1, JSON.stringify(spots));
      assert.ok(Math.abs(spots[0][0] - 190) <= 1 && Math.abs(spots[0][1] - 55) <= 1 && spots[0][2] === true, JSON.stringify(spots));
    });
    await check("real pointer: a press at a point is not made when what is there is not what was checked", async () => {
      const box = await ptr.page.evaluate(() => { const r = document.getElementById("spot").getBoundingClientRect(); return { x: r.left + window.scrollX + 20, y: r.top + window.scrollY + 20 }; });
      const r = await ptrDo({ action: "click_at", x: Math.round(box.x), y: Math.round(box.y), expect: { ref: 9999 } });
      assert.equal(r.success, false);
      assert.match(r.error, /is not what was checked before/);
      assert.equal(await ptr.page.evaluate(() => window.spots.length), 1);
    });
    const plain = await open(browser, "https://pointer2.example/", POINTER_PAGE);
    await plain.send({ action: "scan", limit: 500, task: "", whole: true });
    await check("without the real pointer, a click and a drag are made by script and say so", async () => {
      const ref = (id) => plain.page.evaluate((i) => Number(window.__selectToAiIdOf(document.getElementById(i))), id);
      const c = await plain.send({ action: "interact", data: { action: "click", id: await ref("products") } });
      assert.equal(c.pointer, "synthetic", c.error);
      const rows = await plain.page.evaluate(() => [...document.querySelectorAll("#sortable li")].map((li) => Number(window.__selectToAiIdOf(li))));
      const d = await plain.send({ action: "interact", data: { action: "drag", id: rows[0], to: rows[2] } });
      assert.equal(d.pointer, "synthetic", d.error);
      assert.notEqual(await plain.page.evaluate(() => document.querySelector("#sortable li").textContent), "Apples", d.message);
    });
  } finally {
    await browser.close();
  }
  for (const [name, err] of results) console.log(`${err ? "FAIL" : "PASS"}  ${name}${err ? `\n      ${err}` : ""}`);
  if (settleTimes.length) console.log(`\nwait after the press: ${settleTimes.join("; ")}`);
  const failed = results.filter(([, e]) => e).length;
  console.log(`\n${results.length - failed}/${results.length} widget checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
