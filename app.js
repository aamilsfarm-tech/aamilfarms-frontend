
"use strict";
var S = { lang: "en", tab: "over", site: "", ponds: [], entries: [], db: null, canWrite: true, live: false };
try { var sl = localStorage.getItem("pl_lang"); if (sl === "hi" || sl === "en") S.lang = sl; } catch (e) {}

function t(k, v) {
  var s = (TX[S.lang] && TX[S.lang][k]) || TX.en[k] || k;
  if (v) for (var n in v) s = s.replace("{" + n + "}", v[n]);
  return s;
}
function esc(x) { return String(x == null ? "" : x).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
function today() { return new Date().toLocaleDateString("en-CA"); }
function dayDiff(a, b) { return Math.round((new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 86400000); }
function nf(n, d) { return (n == null || isNaN(n)) ? "–" : Number(n).toLocaleString("en-IN", { maximumFractionDigits: d == null ? 0 : d, minimumFractionDigits: 0 }); }
function inr(n) { return (n < 0 ? "−" : "") + "₹" + nf(Math.abs(n)); }
function dshort(d) { try { return new Date(d + "T00:00:00").toLocaleDateString(S.lang === "hi" ? "hi-IN" : "en-IN", { day: "numeric", month: "short" }); } catch (e) { return d; } }
function num(v) { var n = parseFloat(v); return isNaN(n) ? null : n; }
function speciesName(s) { return s === "imc" ? t("imc") : t("pang"); }

/* ---- calculations ---- */
function entriesOf(pid, type) { return S.entries.filter(function (e) { return e.pondId === pid && (!type || e.type === type); }); }
function sum(arr, f) { return arr.reduce(function (a, x) { return a + (f(x) || 0); }, 0); }

function pondStats(p) {
  var E = entriesOf(p.id);
  var feeds = E.filter(function (e) { return e.type === "feed"; });
  var feedKg = sum(feeds, function (e) { return e.kg; });
  var feedCost = sum(feeds, function (e) { return (e.kg || 0) * (e.rate || 0); });
  var mort = sum(E.filter(function (e) { return e.type === "mort"; }), function (e) { return e.count; });
  var samples = E.filter(function (e) { return e.type === "sample"; }).sort(function (a, b) { return a.date < b.date ? 1 : -1; });
  var sales = E.filter(function (e) { return e.type === "sale"; });
  var soldKg = sum(sales, function (e) { return e.kg; });
  var revenue = sum(sales, function (e) { return e.amount; });
  var otherCost = sum(E.filter(function (e) { return e.type === "expense"; }), function (e) { return e.amount; });
  var cost = (p.seedCost || 0) + feedCost + otherCost;
  var seed = p.seed || 0;
  var alive = Math.max(0, seed - mort);
  var lastWt = samples.length ? samples[0].avgWt : (p.seedWt || 0);
  var biomass = p.status === "harvested" ? soldKg : alive * lastWt / 1000;
  var gain = biomass - seed * (p.seedWt || 0) / 1000;
  var fcr = (gain > 0 && feedKg > 0) ? feedKg / gain : null;
  var end = p.status === "harvested" && p.harvestDate ? p.harvestDate : today();
  var doc = p.stockDate ? Math.max(0, dayDiff(p.stockDate, end)) : null;
  return { feedKg: feedKg, feedCost: feedCost, mort: mort, alive: alive, lastWt: lastWt, biomass: biomass, fcr: fcr, doc: doc, soldKg: soldKg, revenue: revenue, cost: cost, profit: revenue - cost, hasSample: samples.length > 0 };
}

/* general guide thresholds for pond water */
function waterFlags(e) {
  var f = [];
  function add(k, lvl, dir) { f.push({ k: k, lvl: lvl, dir: dir }); }
  if (e.ph != null) { if (e.ph < 6 || e.ph > 9) add("ph", "crit", e.ph < 6 ? "low" : "high"); else if (e.ph < 6.5 || e.ph > 8.5) add("ph", "warn", e.ph < 6.5 ? "low" : "high"); }
  if (e.dox != null) { if (e.dox < 3) add("dox", "crit", "low"); else if (e.dox < 4) add("dox", "warn", "low"); }
  if (e.temp != null) { if (e.temp < 20 || e.temp > 36) add("temp", "crit", e.temp < 20 ? "low" : "high"); else if (e.temp < 24 || e.temp > 33) add("temp", "warn", e.temp < 24 ? "low" : "high"); }
  if (e.nh3 != null) { if (e.nh3 > 1) add("nh3", "crit", "high"); else if (e.nh3 > 0.5) add("nh3", "warn", "high"); }
  return f;
}
function worst(flags) { return flags.some(function (x) { return x.lvl === "crit"; }) ? "crit" : (flags.length ? "warn" : "ok"); }

function visiblePonds() { return S.ponds.filter(function (p) { return !S.site || p.site === S.site; }).sort(function (a, b) { return (a.name || "").localeCompare(b.name || "", undefined, { numeric: true }); }); }
function visibleIds() { var m = {}; visiblePonds().forEach(function (p) { m[p.id] = 1; }); return m; }
function pondById(id) { for (var i = 0; i < S.ponds.length; i++) if (S.ponds[i].id === id) return S.ponds[i]; return null; }
function sitesList() { var m = {}; S.ponds.forEach(function (p) { if (p.site) m[p.site] = 1; }); return Object.keys(m).sort(); }

/* ---- data layer: REST API + local cache + offline queue ---- */
var API = String(window.API_BASE || "").replace(/\/$/, "");
var DOCS = { ponds: {}, entries: {} };
var Q = [];            // changes waiting to reach the server
var token = null, since = null, busy = false, pulling = false, deferredInstall = null;
S.online = true; S.canWrite = true; S.user = null; S.ready = false; S.msg = "";

function isOwner() { return !!(S.user && S.user.role === "owner"); }

function idb() {
  return new Promise(function (res, rej) {
    var r = indexedDB.open("pondledger", 1);
    r.onupgradeneeded = function () { r.result.createObjectStore("kv"); };
    r.onsuccess = function () { res(r.result); };
    r.onerror = function () { rej(r.error); };
  });
}
async function kvGet(k) {
  try { var d = await idb(); return await new Promise(function (res) { var q = d.transaction("kv").objectStore("kv").get(k); q.onsuccess = function () { res(q.result); }; q.onerror = function () { res(undefined); }; }); }
  catch (e) { return undefined; }
}
async function kvSet(k, v) {
  try { var d = await idb(); await new Promise(function (res) { var tx = d.transaction("kv", "readwrite"); tx.objectStore("kv").put(v, k); tx.oncomplete = res; tx.onerror = res; tx.onabort = res; }); } catch (e) {}
}
function persist() { kvSet("cache", { docs: DOCS, since: since, user: S.user }); kvSet("queue", Q); }
function rebuild() {
  S.ponds = Object.keys(DOCS.ponds).map(function (id) { return Object.assign({ id: id }, DOCS.ponds[id]); });
  S.entries = Object.keys(DOCS.entries).map(function (id) { return Object.assign({ id: id }, DOCS.entries[id]); });
}

async function api(method, path, body) {
  var r;
  try {
    r = await fetch(API + path, { method: method, headers: Object.assign({ "Content-Type": "application/json" }, token ? { Authorization: "Bearer " + token } : {}), body: body ? JSON.stringify(body) : undefined });
  } catch (e) { var ne = new Error("net"); ne.net = true; throw ne; }
  var j = null; try { j = await r.json(); } catch (e) {}
  if (r.status === 401 && path !== "/api/login") { signedOut(); var ae = new Error("auth"); ae.status = 401; throw ae; }
  if (!r.ok) { var he = new Error((j && j.error) || "http"); he.status = r.status; he.code = j && j.error; throw he; }
  return j;
}

async function flush() {
  if (busy || !token) return;
  busy = true;
  try {
    while (Q.length) {
      var o = Q[0];
      try {
        if (o.op === "put") await api("PUT", "/api/docs/" + o.col + "/" + o.id, { data: o.data });
        else await api("DELETE", "/api/docs/" + o.col + "/" + o.id);
        Q.shift(); persist();
      } catch (e) {
        if (e.net || e.status === 401 || e.status >= 500) throw e;
        Q.shift(); since = null; persist(); flash(t("rejected"));
      }
    }
    S.online = true;
  } catch (e) { if (e.net) S.online = false; }
  finally { busy = false; draw(); }
}
async function pull() {
  if (!token || Q.length || pulling) return;
  pulling = true;
  try {
    var full = since === null;
    var j = await api("GET", "/api/sync" + (since ? "?since=" + encodeURIComponent(since) : ""));
    if (full) DOCS = { ponds: {}, entries: {} };
    j.docs.forEach(function (d) {
      if (!DOCS[d.col]) return;
      if (d.deleted) delete DOCS[d.col][d.id]; else DOCS[d.col][d.id] = d.data;
    });
    since = new Date(Date.parse(j.now) - 5000).toISOString();
    S.online = true; rebuild(); persist(); draw();
  } catch (e) { if (e.net) S.online = false; draw(); }
  finally { pulling = false; }
}
async function sync() { await flush(); await pull(); }

function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function clean(o) { var r = {}; for (var k in o) if (o[k] !== null && o[k] !== undefined && o[k] !== "") r[k] = o[k]; return r; }
function afterLocal() { rebuild(); persist(); draw(); flush(); }
async function setDoc(col, id, data) { data = clean(data); DOCS[col][id] = data; Q.push({ op: "put", col: col, id: id, data: data }); afterLocal(); }
async function addDoc(col, data) { return setDoc(col, newId(), data); }
async function delDoc(col, id) {
  delete DOCS[col][id];
  if (col === "ponds") Object.keys(DOCS.entries).forEach(function (k) { if (DOCS.entries[k].pondId === id) delete DOCS.entries[k]; });
  Q.push({ op: "del", col: col, id: id }); afterLocal();
}

async function login(username, password) {
  var j = await api("POST", "/api/login", { username: username, password: password });
  token = j.token; S.user = j.user; S.live = true;
  try { localStorage.setItem("pl_token", token); } catch (e) {}
  since = null; DOCS = { ponds: {}, entries: {} }; rebuild(); persist(); draw(); sync();
}
function signedOut() {
  token = null; S.user = null; S.live = false;
  try { localStorage.removeItem("pl_token"); } catch (e) {}
  draw();
}
async function signOutNow(force) {
  await flush();
  if (Q.length && !force) return false;
  Q = []; DOCS = { ponds: {}, entries: {} }; since = null; rebuild(); await kvSet("cache", null); await kvSet("queue", []);
  signedOut(); return true;
}
async function boot() {
  try { token = localStorage.getItem("pl_token"); } catch (e) {}
  var c = await kvGet("cache");
  if (c && c.docs) { DOCS = c.docs; since = c.since || null; if (token) S.user = c.user || null; }
  var q = await kvGet("queue"); if (q && q.length) Q = q;
  S.live = !!token; rebuild(); S.ready = true; draw();
  if (token) { try { var m = await api("GET", "/api/me"); S.user = m.user; persist(); draw(); } catch (e) {} sync(); }
}
setInterval(function () { if (!document.hidden) sync(); }, 30000);
document.addEventListener("visibilitychange", function () { if (!document.hidden) sync(); });
window.addEventListener("online", function () { sync(); });
window.addEventListener("offline", function () { S.online = false; draw(); });
window.addEventListener("beforeinstallprompt", function (e) { e.preventDefault(); deferredInstall = e; });
if ("serviceWorker" in navigator) window.addEventListener("load", function () { navigator.serviceWorker.register("sw.js").catch(function () {}); });


var ICON = {
  over: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  ponds: '<path d="M3 14c3-3 6 3 9 0s6 3 9 0M3 19c3-3 6 3 9 0s6 3 9 0M7 9a5 5 0 0 1 10 0"/>',
  water: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.500 6-11 6-11z"/>',
  feed: '<path d="M4 10h16l-1.500 9h-13zM8 10l1-5h6l1 5"/>',
  money: '<circle cx="12" cy="12" r="9"/><path d="M9 8h6M9 12h6M10 8c4 0 4 5 0 5l4 3"/>'
};
var TABS = [["over", "tOver"], ["ponds", "tPonds"], ["water", "tWater"], ["feed", "tFeed"], ["money", "tMoney"]];
var SHORT = { ph: "pH", dox: "DO", temp: "Temp", nh3: "NH₃" };
var msgTimer = null;

function $(id) { return document.getElementById(id); }
function flash(m) { S.msg = m; draw(); clearTimeout(msgTimer); msgTimer = setTimeout(function () { S.msg = ""; draw(); }, 4000); }

function draw() {
  document.documentElement.lang = S.lang === "hi" ? "hi" : "en";
  $("ttl").textContent = t("app");
  $("lEn").setAttribute("aria-pressed", S.lang === "en");
  $("lHi").setAttribute("aria-pressed", S.lang === "hi");
  var sites = sitesList(), key = S.lang + "|" + sites.join("|") + "|" + S.site, sel = $("siteSel");
  if (sel.getAttribute("data-k") !== key) {
    sel.innerHTML = '<option value="">' + esc(t("allSites")) + "</option>" + sites.map(function (s) { return '<option value="' + esc(s) + '"' + (s === S.site ? " selected" : "") + ">" + esc(s) + "</option>"; }).join("");
    sel.setAttribute("data-k", key);
  }
  sel.hidden = sites.length === 0;
  $("tabs").innerHTML = TABS.map(function (x) {
    return '<button type="button" data-act="tab" data-id="' + x[0] + '"' + (S.tab === x[0] ? ' aria-current="page"' : "") + '><svg viewBox="0 0 24 24" aria-hidden="true">' + ICON[x[0]] + "</svg>" + esc(t(x[1])) + "</button>";
  }).join("");
  var authed = !!S.live;
  document.querySelector("nav.tabs").hidden = !authed;
  $("acctBtn").hidden = !authed;
  if (!authed) sel.hidden = true;
  var b = "";
  if (authed && !S.online) b += '<div class="banner">' + esc(t("offline")) + (Q.length ? " " + esc(t("pending", { n: Q.length })) : "") + "</div>";
  else if (authed && Q.length) b += '<div class="banner">' + esc(t("pending", { n: Q.length })) + "</div>";
  if (S.msg) b += '<div class="banner">' + esc(S.msg) + "</div>";
  $("banner").innerHTML = b;
  var v = { over: viewOver, ponds: viewPonds, water: viewWater, feed: viewFeed, money: viewMoney }[S.tab];
  if (!S.ready) $("view").innerHTML = "";
  else if (authed) { var ae = document.activeElement; if (!(ae && String(ae.className).indexOf("plan-in") >= 0)) $("view").innerHTML = v(); }
  else if (!$("loginForm")) $("view").innerHTML = viewLogin();
}

function addBtn(act, label, cls) { return '<button type="button" class="btn ' + (cls || "") + '" data-act="' + act + '"' + (S.live && (act !== "addPond" || isOwner()) ? "" : " disabled") + ">+ " + esc(label) + "</button>"; }
function emptyBox(tk, bk, act, label) { return '<div class="empty"><strong>' + esc(t(tk)) + "</strong><span>" + esc(t(bk)) + "</span>" + (act ? addBtn(act, label) : "") + "</div>"; }
function tile(k, v, sub) { return '<div class="tile"><div class="k">' + esc(k) + '</div><div class="v num">' + v + (sub ? " <small>" + esc(sub) + "</small>" : "") + "</div></div>"; }
function pondLabel(id) { var p = pondById(id); return p ? p.name : "?"; }

function latestWater(pid) {
  var w = entriesOf(pid, "water").sort(function (a, b) { return a.date < b.date ? 1 : (a.date > b.date ? -1 : (b.ts || 0) - (a.ts || 0)); });
  return w[0] || null;
}
function flagPills(flags) { return flags.map(function (f) { return '<span class="pill ' + f.lvl + '">' + SHORT[f.k] + " " + esc(t(f.dir)) + "</span>"; }).join(""); }

/* ---- Overview ---- */
function viewOver() {
  var ps = visiblePonds();
  if (!ps.length) return emptyBox("emptyPondsT", "emptyPondsB", "addPond", t("addPond"));
  var act = ps.filter(function (p) { return p.status !== "harvested"; });
  var st = {}; ps.forEach(function (p) { st[p.id] = pondStats(p); });
  var bio = sum(act, function (p) { return st[p.id].biomass; });
  var profit = sum(ps, function (p) { return st[p.id].profit; });
  var fc = act.map(function (p) { return st[p.id].fcr; }).filter(function (x) { return x != null; });
  var avgF = fc.length ? sum(fc, function (x) { return x; }) / fc.length : null;
  var h = '<div class="tiles">' + tile(t("activePonds"), nf(act.length)) + tile(t("biomass"), nf(bio), "kg") + tile(t("avgFcr"), avgF == null ? "–" : nf(avgF, 2)) + tile(t("netProfit"), '<span class="' + (profit < 0 ? "neg" : "pos") + '">' + inr(profit) + "</span>") + "</div>";
  var items = "";
  act.forEach(function (p) {
    var w = latestWater(p.id);
    if (!w) { items += '<div class="row stripe-warn"><div><div class="t">' + esc(p.name) + '</div><div class="s">' + esc(t("noReading")) + "</div></div></div>"; return; }
    var fl = waterFlags(w), age = dayDiff(w.date, today());
    if (fl.length || age >= 2) {
      items += '<div class="row stripe-' + (worst(fl) === "crit" ? "crit" : "warn") + '"><div><div class="t">' + esc(p.name) + '</div><div class="s">' + esc(dshort(w.date)) + (age >= 2 ? " · " + esc(t("staleReading", { n: age })) : "") + '</div><div class="pills">' + flagPills(fl) + "</div></div></div>";
    }
  });
  h += '<section><div class="sec-h"><h2>' + esc(t("attention")) + '</h2></div><div class="list">' + (items || '<div class="row"><div class="s">' + esc(t("allGood")) + "</div></div>") + "</div></section>";
  var cult = ["pangasius", "imc"].map(function (sp) {
    var L = act.filter(function (p) { return (p.species || "pangasius") === sp; });
    if (!L.length) return "";
    return '<div class="row"><div><div class="t">' + esc(speciesName(sp)) + '</div><div class="s">' + L.length + " " + esc(t("tPonds")) + '</div></div><div class="num"><b>' + nf(sum(L, function (p) { return st[p.id].biomass; })) + " kg</b></div></div>";
  }).join("");
  if (cult) h += '<section><div class="sec-h"><h2>' + esc(t("byCulture")) + '</h2></div><div class="list">' + cult + "</div></section>";
  return h;
}

/* ---- Ponds ---- */
function viewPonds() {
  var ps = visiblePonds();
  var h = '<div class="sec-h"><h2>' + esc(t("tPonds")) + "</h2>" + addBtn("addPond", t("addPond")) + "</div>";
  if (!ps.length) return h + emptyBox("emptyPondsT", "emptyPondsB");
  h += '<div class="list">' + ps.map(function (p) {
    var s = pondStats(p), done = p.status === "harvested";
    return '<button type="button" class="row" data-act="pond" data-id="' + esc(p.id) + '"><div><div class="t">' + esc(p.name) + '</div><div class="s">' + esc((p.site ? p.site + " · " : "") + speciesName(p.species) + (p.area ? " · " + nf(p.area, 2) + " ac" : "")) + '</div><div class="pills"><span class="pill ' + (done ? "" : "good") + '">' + esc(done ? t("harvested") : t("active")) + "</span>" + (s.doc != null ? '<span class="pill">' + esc(t("doc")) + " " + s.doc + "</span>" : "") + '</div></div><div class="num" style="text-align:end"><b>' + nf(s.biomass) + ' kg</b><div class="s">' + nf(s.lastWt) + " g</div></div></button>";
  }).join("") + "</div>";
  return h;
}

/* ---- entry display ---- */
function entryLine(e) {
  var tp = e.type;
  if (tp === "water") return [e.ph != null ? "pH " + e.ph : "", e.dox != null ? "DO " + e.dox : "", e.temp != null ? e.temp + " °C" : "", e.nh3 != null ? "NH₃ " + e.nh3 : ""].filter(Boolean).join(" · ");
  if (tp === "feed") return nf(e.kg, 1) + " kg" + (e.rate ? " @ ₹" + nf(e.rate, 1) : "") + (e.from ? " · " + dshort(e.from) + " – " + dshort(e.date) : "") + (e.est ? " · " + t("estTag") : "");
  if (tp === "sample") return nf(e.avgWt) + " g" + (e.n ? " (" + e.n + ")" : "");
  if (tp === "mort") return nf(e.count) + " " + t("eMort").toLowerCase();
  if (tp === "expense") return (e.cat ? t(e.cat) + " · " : "") + inr(e.amount || 0);
  if (tp === "sale") return nf(e.kg, 1) + " kg" + (e.rate ? " @ ₹" + nf(e.rate, 1) : "") + " · " + inr(e.amount || 0);
  return "";
}
var TYPE_KEY = { water: "eWater", feed: "eFeed", sample: "eSample", mort: "eMort", expense: "eExpense", sale: "eSale" };
function entryRows(types, limit) {
  var ids = visibleIds();
  var L = S.entries.filter(function (e) { return types.indexOf(e.type) >= 0 && ids[e.pondId]; })
    .sort(function (a, b) { return a.date < b.date ? 1 : (a.date > b.date ? -1 : (b.ts || 0) - (a.ts || 0)); }).slice(0, limit || 40);
  return L.map(function (e) {
    var fl = e.type === "water" ? waterFlags(e) : [];
    var cls = fl.length ? " stripe-" + (worst(fl) === "crit" ? "crit" : "warn") : "";
    return '<button type="button" class="row' + cls + '" data-act="entry" data-id="' + esc(e.id) + '"><div><div class="t">' + esc(pondLabel(e.pondId)) + ' <span class="pill">' + esc(t(TYPE_KEY[e.type])) + '</span></div><div class="s num">' + esc(entryLine(e)) + (e.note ? " · " + esc(e.note) : "") + "</div>" + (fl.length ? '<div class="pills">' + flagPills(fl) + "</div>" : "") + '</div><div class="s num">' + esc(dshort(e.date)) + "</div></button>";
  }).join("");
}

/* ---- Water ---- */
function viewWater() {
  var h = '<div class="sec-h"><h2>' + esc(t("tWater")) + "</h2>" + addBtn("addWater", t("addReading")) + '</div><div class="note">' + esc(t("guide")) + "</div>";
  var rows = entryRows(["water"]);
  return h + (rows ? '<div class="list">' + rows + "</div>" : emptyBox("emptyWaterT", "emptyWaterB"));
}


/* ---- feed plan: daily feed = fish alive x body weight x feed % ---- */
var RATES = {
  pangasius: [[20, 8], [100, 5], [300, 3.5], [600, 2.5], [1000, 2], [Infinity, 1.5]],
  imc: [[20, 6], [100, 4], [300, 3], [600, 2.2], [Infinity, 1.5]]
};
function autoRate(species, wt) { var T = RATES[species === "imc" ? "imc" : "pangasius"]; for (var i = 0; i < T.length; i++) if (wt < T[i][0]) return T[i][1]; return 1.5; }
function r1(x) { return Math.round(x * 10) / 10; }
function weightNow(p) {
  var pts = [];
  if (p.stockDate && p.seedWt) pts.push({ d: p.stockDate, w: p.seedWt });
  var smp = entriesOf(p.id, "sample").filter(function (e) { return e.avgWt; }).sort(function (a, b) { return a.date < b.date ? -1 : 1; });
  smp.forEach(function (e) { pts.push({ d: e.date, w: e.avgWt }); });
  if (!pts.length) return null;
  var last = pts[pts.length - 1], age = Math.max(0, dayDiff(last.d, today())), adg = null;
  if (pts.length >= 2) { var gap = dayDiff(pts[pts.length - 2].d, last.d); if (gap > 0) adg = Math.max(0, (last.w - pts[pts.length - 2].w) / gap); }
  var dflt = adg == null;
  if (dflt) adg = p.species === "imc" ? 3 : 8;
  return { wt: last.w + adg * (dflt ? age : Math.min(age, 30)), sampleAge: smp.length ? Math.max(0, dayDiff(smp[smp.length - 1].date, today())) : null };
}
function lastFeedRate(pid) {
  var f = entriesOf(pid, "feed").filter(function (e) { return e.rate; }).sort(function (a, b) { return a.date < b.date ? 1 : -1; });
  return f[0] ? f[0].rate : null;
}
function planInfo(p) {
  var st = pondStats(p), w = weightNow(p);
  if (!w || st.alive <= 0) return null;
  var pct = p.feedMode === "fixed" && p.feedPct ? p.feedPct : autoRate(p.species, w.wt);
  var daily = r1(st.alive * w.wt / 1000 * pct / 100);
  var adj = 1, note = "", lw = latestWater(p.id);
  if (lw && dayDiff(lw.date, today()) <= 3) {
    if ((lw.dox != null && lw.dox < 3) || (lw.nh3 != null && lw.nh3 > 1)) { adj = 0; note = "holdFeed"; }
    else if ((lw.dox != null && lw.dox < 4) || (lw.nh3 != null && lw.nh3 > 0.5)) { adj = 0.5; note = "cutFeed"; }
  }
  var T = today(), feeds = entriesOf(p.id, "feed");
  var fedToday = sum(feeds.filter(function (e) { return e.date >= T && (e.from || e.date) <= T; }), function (e) { return e.kg; });
  var past = feeds.map(function (e) { return e.date; }).filter(function (d) { return d <= T; }).sort();
  var lastFeed = past.length ? past[past.length - 1] : null;
  var missed = lastFeed ? Math.min(30, dayDiff(lastFeed, T) - 1) : 0;
  return { p: p, st: st, wt: w.wt, sampleAge: w.sampleAge, pct: pct, daily: daily, adj: adj, note: note, planned: r1(daily * adj), meals: p.meals > 0 ? p.meals : 2, fedToday: fedToday, lastFeed: lastFeed, missed: missed > 0 ? missed : 0 };
}
function planRows() {
  return visiblePonds().filter(function (p) { return p.status !== "harvested" && p.seed; }).map(planInfo).filter(Boolean);
}
S.planKg = {};
function planHtml() {
  var R = planRows(); if (!R.length) return "";
  var total = sum(R.filter(function (r) { return !r.fedToday; }), function (r) { return r.planned; });
  var h = '<section><div class="sec-h"><h2>' + esc(t("feedPlan")) + '</h2><button type="button" class="btn" data-act="logAll"' + (S.live && total > 0 ? "" : " disabled") + ">" + esc(t("logAll")) + '</button></div><div class="note">' + esc(t("planTotal", { n: nf(total, 1) })) + '</div><div class="list" style="margin-top:8px">';
  R.forEach(function (r) {
    var val = S.planKg[r.p.id] != null ? S.planKg[r.p.id] : r.planned;
    var pills = "";
    if (r.note) pills += '<span class="pill ' + (r.adj === 0 ? "crit" : "warn") + '">' + esc(t(r.note)) + "</span>";
    if (r.sampleAge == null) pills += '<span class="pill warn">' + esc(t("noSample")) + "</span>";
    else if (r.sampleAge > 15) pills += '<span class="pill warn">' + esc(t("sampleOld", { n: r.sampleAge })) + "</span>";
    h += '<div class="row"><div style="flex:1;min-width:0"><div class="t">' + esc(r.p.name) + ' <span class="pill">' + nf(r.pct, 1) + "%</span></div>" +
      '<div class="s num">' + esc(t("avgWt")) + " ~" + nf(r.wt) + " g · " + nf(r.st.alive) + " · " + nf(r.st.alive * r.wt / 1000) + " kg</div>" +
      '<div class="s num"><b>' + nf(r.planned, 1) + " " + esc(t("perDay")) + "</b> · " + r.meals + " × " + nf(r.planned / r.meals, 1) + " kg</div>" +
      (pills ? '<div class="pills">' + pills + "</div>" : "") + '<div class="plan-act">';
    if (r.fedToday > 0) h += '<span class="pill good">' + esc(t("fedToday", { n: nf(r.fedToday, 1) })) + "</span>";
    else h += '<input class="plan-in" id="pk_' + esc(r.p.id) + '" data-id="' + esc(r.p.id) + '" type="number" inputmode="decimal" min="0" step="any" value="' + esc(val) + '" aria-label="kg"><span class="note">kg</span><button type="button" class="btn" data-act="logPlan" data-id="' + esc(r.p.id) + '"' + (S.live ? "" : " disabled") + ">" + esc(t("logKg")) + "</button>";
    if (r.missed > 0) h += '<button type="button" class="btn ghost" data-act="catchUp" data-id="' + esc(r.p.id) + '"' + (S.live ? "" : " disabled") + ">" + esc(t("catchUp", { d: r.missed, n: nf(r.daily * r.missed) })) + "</button>";
    h += "</div></div></div>";
  });
  return h + '</div><div class="note">' + esc(t("planNote")) + "</div></section>";
}
async function logPlan(pid) {
  var r = planRows().filter(function (x) { return x.p.id === pid; })[0]; if (!r || r.fedToday > 0) return false;
  var el = $("pk_" + pid), kg = el ? num(el.value) : r.planned;
  if (kg == null || kg <= 0) return false;
  await addDoc("entries", { type: "feed", ts: Date.now(), pondId: pid, date: today(), kg: kg, rate: lastFeedRate(pid) });
  delete S.planKg[pid]; return true;
}
async function logAllPlan() { var R = planRows(); for (var i = 0; i < R.length; i++) await logPlan(R[i].p.id); }
async function catchUpFeed(pid) {
  var r = planRows().filter(function (x) { return x.p.id === pid; })[0]; if (!r || r.missed < 1) return;
  var T = today(), yest = new Date(T + "T00:00:00"); yest.setDate(yest.getDate() - 1);
  var y = yest.toLocaleDateString("en-CA"), from = new Date(T + "T00:00:00"); from.setDate(from.getDate() - r.missed);
  await addDoc("entries", { type: "feed", ts: Date.now(), pondId: pid, date: y, from: r.missed > 1 ? from.toLocaleDateString("en-CA") : null, kg: r1(r.daily * r.missed), rate: lastFeedRate(pid), est: true });
}
document.addEventListener("input", function (e) { if (e.target.classList && e.target.classList.contains("plan-in")) S.planKg[e.target.getAttribute("data-id")] = e.target.value; });

/* ---- Feed and growth ---- */
function viewFeed() {
  var act = visiblePonds().filter(function (p) { return p.status !== "harvested"; });
  var h = '<div class="sec-h"><h2>' + esc(t("growth")) + '</h2></div><div class="actions" style="justify-content:flex-start">' + addBtn("addFeed", t("addFeed")) + addBtn("addSample", t("addSample"), "ghost") + addBtn("addMort", t("addMort"), "ghost") + "</div>" + planHtml();
  if (act.length) {
    h += '<div class="list">' + act.map(function (p) {
      var s = pondStats(p);
      return '<div class="row"><div style="flex:1"><div class="t">' + esc(p.name) + '</div><div class="kv num"><div><span>' + esc(t("doc")) + "</span><b>" + (s.doc == null ? "–" : s.doc) + "</b></div><div><span>" + esc(t("avgWt")) + "</span><b>" + nf(s.lastWt) + " g</b></div><div><span>" + esc(t("feedUsed")) + "</span><b>" + nf(s.feedKg) + " kg</b></div><div><span>" + esc(t("fcr")) + "</span><b>" + (s.fcr == null ? "–" : nf(s.fcr, 2)) + "</b></div><div><span>" + esc(t("alive")) + "</span><b>" + nf(s.alive) + "</b></div></div></div></div>";
    }).join("") + '</div><div class="note">' + esc(t("fcrNote")) + "</div>";
  }
  var rows = entryRows(["feed", "sample", "mort"]);
  return h + (rows ? '<section><div class="sec-h"><h2>' + esc(t("recent")) + '</h2></div><div class="list">' + rows + "</div></section>" : (act.length ? "" : emptyBox("emptyFeedT", "emptyFeedB")));
}

/* ---- Money ---- */
function viewMoney() {
  var ps = visiblePonds(), st = {};
  ps.forEach(function (p) { st[p.id] = pondStats(p); });
  var cost = sum(ps, function (p) { return st[p.id].cost; }), rev = sum(ps, function (p) { return st[p.id].revenue; });
  var h = '<div class="sec-h"><h2>' + esc(t("tMoney")) + '</h2></div><div class="actions" style="justify-content:flex-start">' + addBtn("addExpense", t("addExpense")) + addBtn("addSale", t("addSale"), "ghost") + "</div>";
  if (!ps.length) return h + emptyBox("emptyPondsT", "emptyPondsB", "addPond", t("addPond"));
  h += '<div class="tiles">' + tile(t("expenses"), inr(cost)) + tile(t("sales"), inr(rev)) + tile(t("profit"), '<span class="' + (rev - cost < 0 ? "neg" : "pos") + '">' + inr(rev - cost) + "</span>") + "</div>";
  h += '<section><div class="sec-h"><h2>' + esc(t("perPond")) + '</h2></div><div class="list">' + ps.map(function (p) {
    var s = st[p.id];
    return '<div class="row"><div><div class="t">' + esc(p.name) + '</div><div class="s num">' + esc(t("cost")) + " " + inr(s.cost) + " · " + esc(t("revenue")) + " " + inr(s.revenue) + '</div></div><div class="num ' + (s.profit < 0 ? "neg" : "pos") + '"><b>' + inr(s.profit) + "</b></div></div>";
  }).join("") + "</div></section>";
  var rows = entryRows(["expense", "sale"]);
  if (rows) h += '<section><div class="sec-h"><h2>' + esc(t("recent")) + '</h2></div><div class="list">' + rows + "</div></section>";
  return h;
}


var FORM = null;

function openSheet(html) {
  $("sheet").innerHTML = html; $("scrim").hidden = false;
  var f = $("sheet").querySelector("input,select,button"); if (f) f.focus();
}
function closeSheet() { $("scrim").hidden = true; $("sheet").innerHTML = ""; FORM = null; }

function fieldHtml(f, v) {
  if (f.type === "hint") return '<div class="note full">' + esc(f.text) + "</div>";
  var id = "f_" + f.id, val = v == null ? "" : v, h = '<div class="field' + (f.full ? " full" : "") + '"><label for="' + id + '">' + esc(f.label) + (f.req ? " *" : "") + "</label>";
  if (f.type === "select") h += '<select id="' + id + '">' + f.opts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(val) ? " selected" : "") + ">" + esc(o[1]) + "</option>"; }).join("") + "</select>";
  else if (f.type === "textarea") h += '<textarea id="' + id + '" rows="2">' + esc(val) + "</textarea>";
  else h += '<input id="' + id + '" type="' + (f.type || "text") + '"' + (f.type === "number" ? ' inputmode="decimal" step="' + (f.step || "any") + '" min="0"' : "") + ' value="' + esc(val) + '">';
  return h + "</div>";
}
function openForm(title, fields, defaults, onSave) {
  FORM = { fields: fields, onSave: onSave };
  openSheet('<h2 id="shTtl">' + esc(title) + '</h2><div class="fgrid">' + fields.map(function (f) { return fieldHtml(f, defaults[f.id]); }).join("") + '</div><div class="err" id="ferr" role="alert"></div><div class="actions"><button type="button" class="btn ghost" data-act="cancel">' + esc(t("cancel")) + '</button><button type="button" class="btn" data-act="save">' + esc(t("save")) + "</button></div>");
}
async function submitForm() {
  if (!FORM) return;
  var vals = {}, bad = false;
  FORM.fields.forEach(function (f) {
    if (f.type === "hint") return;
    var el = $("f_" + f.id), v = el.value;
    if (f.type === "number") v = num(v); else v = String(v).trim();
    if (f.req && (v === null || v === "")) bad = true;
    vals[f.id] = v;
  });
  var err = $("ferr");
  if (bad) { err.textContent = t("required"); return; }
  var extra = FORM.onSave.check && FORM.onSave.check(vals);
  if (extra) { err.textContent = extra; return; }
  err.textContent = "";
  try { await FORM.onSave(vals); closeSheet(); }
  catch (e) { var ek = e && e.code ? "err_" + e.code : ""; err.textContent = (ek && TX.en[ek]) ? t(ek) : (e && e.net ? t("offline") : t("saveFail")); }
}

function pondOpts() {
  var L = visiblePonds().filter(function (p) { return p.status !== "harvested"; });
  if (!L.length) L = visiblePonds();
  return L.map(function (p) { return [p.id, p.name]; });
}
function needPond() { if (!visiblePonds().length) { flash(t("needPond")); return true; } return false; }
function pondField() { return { id: "pondId", label: t("pond"), type: "select", opts: pondOpts(), req: true, full: true }; }
function dateField() { return { id: "date", label: t("date"), type: "date", req: true }; }
function noteField() { return { id: "note", label: t("note"), type: "textarea", full: true }; }
function saveEntry(type, keys) {
  var fn = async function (v) { var d = { type: type, ts: Date.now() }; keys.forEach(function (k) { d[k] = v[k]; }); await addDoc("entries", d); };
  return fn;
}

function formPond(p) {
  var sites = sitesList(), def = p ? Object.assign({ feedMode: "auto", meals: 2 }, p) : { stockDate: today(), species: "pangasius", site: S.site || (sites[0] || ""), feedMode: "auto", meals: 2 };
  var fn = async function (v) {
    var d = { name: v.name, site: v.site, species: v.species, area: v.area, stockDate: v.stockDate, seed: v.seed, seedWt: v.seedWt, seedCost: v.seedCost, feedMode: v.feedMode, feedPct: v.feedMode === "fixed" ? v.feedPct : null, meals: v.meals, status: p ? p.status || "active" : "active" };
    if (p && p.harvestDate) d.harvestDate = p.harvestDate;
    if (p) await setDoc("ponds", p.id, d); else await addDoc("ponds", d);
  };
  fn.check = function (v) { return v.feedMode === "fixed" && !(v.feedPct > 0) ? t("required") : ""; };
  openForm(p ? t("editPond") : t("addPond"), [
    { id: "name", label: t("pName"), req: true, full: true },
    { id: "site", label: t("pSite") }, { id: "species", label: t("pSpecies"), type: "select", opts: [["pangasius", t("pang")], ["imc", t("imc")]] },
    { id: "area", label: t("pArea"), type: "number" }, { id: "stockDate", label: t("pStock"), type: "date" },
    { id: "seed", label: t("pSeed"), type: "number", step: "1" }, { id: "seedWt", label: t("pSeedWt"), type: "number" },
    { id: "seedCost", label: t("pSeedCost"), type: "number", full: true },
    { id: "feedMode", label: t("feedMode"), type: "select", opts: [["auto", t("feedAuto")], ["fixed", t("feedFixed")]] },
    { id: "feedPct", label: t("feedPct"), type: "number" },
    { id: "meals", label: t("meals"), type: "number", step: "1" }
  ], def, fn);
}
function formWater() {
  if (needPond()) return;
  var fn = saveEntry("water", ["pondId", "date", "ph", "dox", "temp", "nh3", "note"]);
  fn.check = function (v) { return (v.ph == null && v.dox == null && v.temp == null && v.nh3 == null) ? t("required") : ""; };
  openForm(t("addReading"), [pondField(), dateField(), { id: "ph", label: t("ph"), type: "number", step: "0.1" }, { id: "dox", label: t("dox"), type: "number", step: "0.1" }, { id: "temp", label: t("temp"), type: "number", step: "0.1" }, { id: "nh3", label: t("nh3"), type: "number", step: "0.01" }, noteField()], { date: today() }, fn);
}
function formFeed() {
  if (needPond()) return;
  var ps = visiblePonds().filter(function (p) { return p.status !== "harvested"; });
  if (!ps.length) ps = visiblePonds();
  var fields = [
    { id: "from", label: t("feedFrom"), type: "date", full: true },
    { id: "date", label: t("feedTo"), type: "date", req: true },
    { id: "rate", label: t("feedRate"), type: "number" },
    { id: "hint", type: "hint", text: t("feedHint") }
  ];
  ps.forEach(function (p) { fields.push({ id: "kg_" + p.id, label: p.name + " (kg)", type: "number" }); });
  fields.push(noteField());
  var fn = async function (v) {
    for (var i = 0; i < ps.length; i++) {
      var kg = v["kg_" + ps[i].id];
      if (kg != null && kg > 0) await addDoc("entries", { type: "feed", ts: Date.now(), pondId: ps[i].id, date: v.date, from: v.from && v.from < v.date ? v.from : null, kg: kg, rate: v.rate, note: v.note });
    }
  };
  fn.check = function (v) {
    if (v.from && v.from > v.date) return t("badPeriod");
    return ps.some(function (p) { var k = v["kg_" + p.id]; return k != null && k > 0; }) ? "" : t("required");
  };
  openForm(t("addFeed"), fields, { date: today() }, fn);
}
function formSample() {
  if (needPond()) return;
  openForm(t("addSample"), [pondField(), dateField(), { id: "avgWt", label: t("sampleWt"), type: "number", req: true }, { id: "n", label: t("sampleN"), type: "number", step: "1" }, noteField()], { date: today() }, saveEntry("sample", ["pondId", "date", "avgWt", "n", "note"]));
}
function formMort() {
  if (needPond()) return;
  openForm(t("addMort"), [pondField(), dateField(), { id: "count", label: t("mortN"), type: "number", step: "1", req: true }, noteField()], { date: today() }, saveEntry("mort", ["pondId", "date", "count", "note"]));
}
function formExpense() {
  if (needPond()) return;
  var cats = ["cLabour", "cPower", "cMed", "cRent", "cOther"].map(function (c) { return [c, t(c)]; });
  openForm(t("addExpense"), [pondField(), dateField(), { id: "cat", label: t("expCat"), type: "select", opts: cats }, { id: "amount", label: t("amount"), type: "number", req: true }, noteField()], { date: today() }, saveEntry("expense", ["pondId", "date", "cat", "amount", "note"]));
}
function formSale() {
  if (needPond()) return;
  var fn = async function (v) {
    var amt = v.amount != null ? v.amount : (v.kg != null && v.rate != null ? v.kg * v.rate : null);
    await addDoc("entries", { type: "sale", ts: Date.now(), pondId: v.pondId, date: v.date, kg: v.kg, rate: v.rate, amount: amt, buyer: v.buyer, note: v.note });
  };
  fn.check = function (v) { return (v.amount == null && (v.kg == null || v.rate == null)) ? t("required") : ""; };
  openForm(t("addSale"), [pondField(), dateField(), { id: "kg", label: t("soldKg"), type: "number", req: true }, { id: "rate", label: t("rate"), type: "number" }, { id: "amount", label: t("amount"), type: "number" }, { id: "buyer", label: t("buyer") }, noteField()], { date: today() }, fn);
}

/* ---- detail sheets ---- */
function pondSheet(p) {
  var s = pondStats(p), done = p.status === "harvested";
  var kv = function (k, v) { return "<div><span>" + esc(k) + "</span><b>" + v + "</b></div>"; };
  openSheet(ownerOnlyFilter('<h2 id="shTtl">' + esc(p.name) + '</h2><div class="s note">' + esc((p.site ? p.site + " · " : "") + speciesName(p.species)) + '</div><div class="kv num">' +
    kv(t("doc"), s.doc == null ? "–" : s.doc + " " + t("days")) + kv(t("seed"), nf(p.seed || 0)) + kv(t("alive"), nf(s.alive)) + kv(t("avgWt"), nf(s.lastWt) + " g") + kv(t("biomass"), nf(s.biomass) + " kg") +
    kv(t("fcr"), s.fcr == null ? "–" : nf(s.fcr, 2)) + kv(t("feedUsed"), nf(s.feedKg) + " kg") + kv(t("cost"), inr(s.cost)) + kv(t("revenue"), inr(s.revenue)) +
    kv(t("profit"), '<span class="' + (s.profit < 0 ? "neg" : "pos") + '">' + inr(s.profit) + "</span>") + '</div><div class="actions"><button type="button" class="btn ghost" data-act="editPond" data-id="' + esc(p.id) + '">' + esc(t("editPond")) + '</button><button type="button" class="btn ghost" data-act="toggleHarvest" data-id="' + esc(p.id) + '">' + esc(done ? t("reopen") : t("markHarvested")) + '</button><button type="button" class="btn danger" data-act="delPond" data-id="' + esc(p.id) + '">' + esc(t("deletePond")) + '</button><button type="button" class="btn" data-act="cancel">' + esc(t("close")) + "</button></div>"));
}
function entrySheet(e) {
  openSheet('<h2 id="shTtl">' + esc(pondLabel(e.pondId)) + " · " + esc(t(TYPE_KEY[e.type])) + '</h2><div class="num">' + esc(dshort(e.date)) + "</div><div class=\"num\"><b>" + esc(entryLine(e)) + "</b></div>" + (e.buyer ? "<div>" + esc(t("buyer")) + ": " + esc(e.buyer) + "</div>" : "") + (e.note ? '<div class="s note">' + esc(e.note) + "</div>" : "") + '<div class="actions"><button type="button" class="btn danger" data-act="delEntry" data-id="' + esc(e.id) + '"' + (S.live ? "" : " disabled") + ">" + esc(t("del")) + '</button><button type="button" class="btn" data-act="cancel">' + esc(t("close")) + "</button></div>");
}
function armed(btn, label) {
  if (btn.getAttribute("data-armed")) return true;
  btn.setAttribute("data-armed", "1"); btn.textContent = label; return false;
}


/* ---- login, account and team ---- */
function ownerOnlyFilter(h) { return isOwner() ? h : h.replace(/<button type="button" class="btn (?:ghost|danger)" data-act="(?:editPond|toggleHarvest|delPond)"[^>]*>.*?<\/button>/g, ""); }

function viewLogin() {
  return '<form id="loginForm" class="login" autocomplete="on"><h2>' + esc(t("signIn")) + "</h2>" +
    '<div class="field"><label for="lg_u">' + esc(t("username")) + '</label><input id="lg_u" name="username" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required></div>' +
    '<div class="field"><label for="lg_p">' + esc(t("password")) + '</label><input id="lg_p" name="password" type="password" autocomplete="current-password" required></div>' +
    '<div class="err" id="loginErr" role="alert"></div><button class="btn" type="submit">' + esc(t("signIn")) + "</button>" +
    (API ? "" : '<div class="note">' + esc(t("noApi")) + "</div>") + "</form>";
}
document.addEventListener("submit", async function (ev) {
  if (ev.target.id !== "loginForm") return;
  ev.preventDefault();
  var err = $("loginErr"), btn = ev.target.querySelector("button");
  err.textContent = ""; btn.disabled = true;
  try { await login($("lg_u").value.trim().toLowerCase(), $("lg_p").value); }
  catch (e) { err.textContent = e.net ? t("offline") : (e.status === 429 ? t("err_too_many") : t("loginFail")); var b2 = $("loginForm") && $("loginForm").querySelector("button"); if (b2) b2.disabled = false; }
});

function acctSheet() {
  var u = S.user || {};
  var h = '<h2 id="shTtl">' + esc(t("account")) + '</h2><div><b>' + esc(u.name || u.username || "") + '</b><div class="s note">' + esc(u.username || "") + " · " + esc(t(u.role === "owner" ? "roleOwner" : "roleStaff")) + "</div></div>";
  if (Q.length) h += '<div class="banner">' + esc(t("pending", { n: Q.length })) + "</div>";
  h += '<div class="actions" style="justify-content:flex-start">';
  if (deferredInstall) h += '<button type="button" class="btn ghost" data-act="install">' + esc(t("install")) + "</button>";
  h += '<button type="button" class="btn ghost" data-act="changePw">' + esc(t("changePassword")) + "</button></div>";
  if (!deferredInstall && /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.navigator.standalone) h += '<div class="note">' + esc(t("installIos")) + "</div>";
  if (isOwner()) h += '<hr class="sep"><div class="sec-h"><h2>' + esc(t("team")) + '</h2><button type="button" class="btn ghost" data-act="addStaff">+ ' + esc(t("addStaff")) + '</button></div><div class="list" id="teamList"><div class="s note">…</div></div>';
  h += '<hr class="sep"><div class="actions"><button type="button" class="btn danger" data-act="signout">' + esc(t("signOut")) + '</button><button type="button" class="btn" data-act="cancel">' + esc(t("close")) + "</button></div>";
  openSheet(h);
  if (isOwner()) loadTeam();
}
async function loadTeam() {
  try {
    var j = await api("GET", "/api/users"), box = $("teamList"); if (!box) return;
    box.innerHTML = j.users.filter(function (x) { return x.role !== "owner"; }).map(function (x) {
      return '<div class="row"><div><div class="t">' + esc(x.name || x.username) + '</div><div class="s">' + esc(x.username) + '</div></div><div class="actions"><button type="button" class="btn ghost" data-act="resetPw" data-id="' + esc(x.id) + '">' + esc(t("resetPassword")) + '</button><button type="button" class="btn danger" data-act="rmUser" data-id="' + esc(x.id) + '">' + esc(t("remove")) + "</button></div></div>";
    }).join("") || '<div class="s note">–</div>';
  } catch (e) { var b3 = $("teamList"); if (b3) b3.innerHTML = '<div class="s note">' + esc(t("offline")) + "</div>"; }
}
function formStaff() {
  openForm(t("addStaff"), [
    { id: "name", label: t("staffName"), full: true },
    { id: "username", label: t("username"), req: true, full: true },
    { id: "password", label: t("newPassword"), type: "password", req: true, full: true }
  ], {}, async function (v) { await api("POST", "/api/users", { name: v.name, username: v.username.toLowerCase(), password: v.password }); });
}
function formResetPw(id) {
  openForm(t("resetPassword"), [{ id: "password", label: t("newPassword"), type: "password", req: true, full: true }], {}, async function (v) { await api("PUT", "/api/users/" + id + "/password", { password: v.password }); });
}
function formChangePw() {
  openForm(t("changePassword"), [
    { id: "oldPassword", label: t("oldPassword"), type: "password", req: true, full: true },
    { id: "newPassword", label: t("newPassword"), type: "password", req: true, full: true }
  ], {}, async function (v) { await api("POST", "/api/me/password", { oldPassword: v.oldPassword, newPassword: v.newPassword }); });
}

/* ---- events ---- */
document.addEventListener("click", async function (ev) {
  if (ev.target.id === "scrim") { closeSheet(); return; }
  var b = ev.target.closest("[data-act]"); if (!b || b.disabled) return;
  var a = b.getAttribute("data-act"), id = b.getAttribute("data-id");
  try {
    if (a === "tab") { S.tab = id; draw(); window.scrollTo(0, 0); }
    else if (a === "addPond") formPond(null);
    else if (a === "addWater") formWater();
    else if (a === "addFeed") formFeed();
    else if (a === "addSample") formSample();
    else if (a === "addMort") formMort();
    else if (a === "addExpense") formExpense();
    else if (a === "addSale") formSale();
    else if (a === "pond") { var p = pondById(id); if (p) pondSheet(p); }
    else if (a === "editPond") { var p2 = pondById(id); if (p2) formPond(p2); }
    else if (a === "entry") { var e = S.entries.filter(function (x) { return x.id === id; })[0]; if (e) entrySheet(e); }
    else if (a === "acct") acctSheet();
    else if (a === "logPlan") { b.disabled = true; await logPlan(id); }
    else if (a === "logAll") { b.disabled = true; await logAllPlan(); }
    else if (a === "catchUp") { b.disabled = true; await catchUpFeed(id); }
    else if (a === "install") { if (deferredInstall) { deferredInstall.prompt(); deferredInstall = null; closeSheet(); } }
    else if (a === "changePw") formChangePw();
    else if (a === "addStaff") formStaff();
    else if (a === "resetPw") formResetPw(id);
    else if (a === "rmUser") { if (armed(b, t("confirmDel"))) { await api("DELETE", "/api/users/" + id); loadTeam(); } }
    else if (a === "signout") { var q0 = Q.length; if (!q0 || armed(b, t("signOutLose", { n: q0 }))) { await signOutNow(true); closeSheet(); } }
    else if (a === "save") submitForm();
    else if (a === "cancel") closeSheet();
    else if (a === "toggleHarvest") {
      var p3 = pondById(id); if (!p3) return;
      var d = {}; for (var k in p3) if (k !== "id") d[k] = p3[k];
      if (p3.status === "harvested") { d.status = "active"; delete d.harvestDate; } else { d.status = "harvested"; d.harvestDate = today(); }
      await setDoc("ponds", id, d); closeSheet();
    }
    else if (a === "delPond") { if (armed(b, t("confirmDel"))) { await delDoc("ponds", id); closeSheet(); } }
    else if (a === "delEntry") { if (armed(b, t("confirmDel"))) { await delDoc("entries", id); closeSheet(); } }
  } catch (err) { flash(t("saveFail")); }
});
document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !$("scrim").hidden) closeSheet(); });
$("siteSel").addEventListener("change", function (e) { S.site = e.target.value; draw(); });
function setLang(l) { S.lang = l; try { localStorage.setItem("pl_lang", l); } catch (e) {} $("siteSel").setAttribute("data-k", ""); if ($("loginForm")) $("view").innerHTML = ""; draw(); }
$("lEn").addEventListener("click", function () { setLang("en"); });
$("lHi").addEventListener("click", function () { setLang("hi"); });

draw();
boot();
