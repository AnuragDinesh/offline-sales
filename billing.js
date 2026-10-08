/* Ten x You Offline Sales - Billing module (orders, dealers, billing desk, ERP linking).
   Talks to /api/billing. Shared state lives in the server database; localStorage only keeps
   "who am I" and an unsent order draft on this device. */
(function(){
const B = window.BILL = {};
let ITEMS = null, ITEM = {}, GROUPS = {}, GLIST = [], itemsP = null;
let ORDERS = null, OMETA = {}, OAT = 0;
let ORD = null;
const WHO_KEY = "txy_who";

/* ---------- plumbing ---------- */
const ss = (k, v) => { try { if (v === undefined) return sessionStorage.getItem(k) || ""; sessionStorage.setItem(k, v); } catch (e) { return ""; } };
const ls = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { return null; } };
B.who = null;
B.curMode = "billing";
const viewer = () => B.curMode === "dash";
B.api = async function (a, body) {
  const opt = { method: body ? "POST" : "GET", headers: { "X-Key": ss("txy_key"), "X-User": viewer() ? "dash" : (B.who || ""), "X-Pin": ss("txy_pin") } };
  if (body) { opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
  const r = await fetch("/api/billing?a=" + a, opt);
  let j = {}; try { j = await r.json(); } catch (e) {}
  if (!r.ok) { const err = new Error(j.error || ("Request failed (HTTP " + r.status + ")")); err.data = j; err.status = r.status; throw err; }
  return j;
};
const isBE = () => !viewer() && B.who === "backend";
const isMgr = () => !viewer() && B.who === "dugout";   /* The Dugout: the sales manager's view-only seat */
const seeAll = () => isBE() || isMgr();
const meId = () => (B.who && B.who.startsWith("tm:")) ? +B.who.slice(3) : null;
const units = n => Math.round(n || 0).toLocaleString("en-IN");
const money = n => inr(n || 0);
const num = v => typeof v === "number" ? v : parseFloat(String(v == null ? "" : v).replace(/[₹,\s]/g, ""));
const attr = s => esc(s == null ? "" : s);
const initials = n => String(n).trim().split(/\s+/).slice(0, 2).map(w => w[0] || "").join("").toUpperCase();
const fmtCol = c => String(c || "").replace(/(_NA|_)+$/i, "").split("_").filter(Boolean).join(" / ");
const SZO = ["XS", "S", "M", "L", "XL", "XXL", "2XL", "XXXL", "3XL", "XXXXL", "4XL", "XXXXXL", "5XL"];
function szKey(z) { z = String(z || "").trim().toUpperCase(); if (/^\d+(\.\d+)?$/.test(z)) return [0, +z]; const i = SZO.indexOf(z); return i >= 0 ? [1, i] : [2, z]; }
function szCmp(a, b) { const x = szKey(a), y = szKey(b); return x[0] - y[0] || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0); }
const item = sku => ITEM[String(sku || "").toUpperCase()] || { code: sku, name: sku, col: "", size: "", gk: "~" + sku };
const dShort = s => s ? shortDate(String(s).slice(0, 10)) : "";
const dLong = s => { if (!s) return ""; try { return new Date(s).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); } catch (e) { return s; } };
const teamName = id => { const t = BOOT.team.find(x => x.id === id); return t ? t.name : null; };
const teamCol = id => { const t = BOOT.team.find(x => x.id === id); return t && t.colour || "#96a4ab"; };
const dealerById = id => BOOT.dealers.find(d => d.id === id);
function myDealers() { return BOOT.dealers.filter(d => !d.excluded && (isBE() || d.team_id === meId())).sort((a, b) => a.name.localeCompare(b.name)); }

function toast(msg, kind) {
  let t = document.getElementById("toast"); if (!t) { t = document.createElement("div"); t.id = "toast"; document.body.appendChild(t); }
  t.className = "toast " + (kind || ""); t.textContent = msg; t.hidden = false;
  clearTimeout(t._h); t._h = setTimeout(() => t.hidden = true, kind === "err" ? 6000 : 3200);
}
function modal(html, opts) {
  opts = opts || {}; const r = document.getElementById("modal-root");
  r.innerHTML = `<div class="modal"><div class="box ${opts.wide ? "wide" : ""}">${html}</div></div>`;
  const m = r.firstElementChild;
  m.addEventListener("mousedown", e => { if (e.target === m) closeModal(); });
  m.querySelectorAll("[data-close]").forEach(b => b.onclick = closeModal);
  return m;
}
function closeModal() { document.getElementById("modal-root").innerHTML = ""; }
document.addEventListener("keydown", e => { if (e.key === "Escape" && document.querySelector("#modal-root .modal")) closeModal(); });
const loading = t => `<div class="card bempty"><div class="spin"></div>${esc(t)}</div>`;
const errCard = t => `<div class="card bempty"><b style="color:var(--neg)">${esc(t)}</b></div>`;
function stagePill(s) { const m = STG[s] || [s, ""]; return `<span class="stg ${m[1]}">${m[0]}</span>`; }
const STG = { draft: ["Draft", "s-draft"], tobill: ["To bill", "s-tobill"], sheet: ["To bill", "s-tobill"], linked: ["To bill", "s-tobill"], partial: ["Partially billed", "s-partial"], billed: ["Closed", "s-billed"], closed: ["Closed", "s-billed"], cancelled: ["Cancelled", "s-cancel"] };
/* small detail under the status */
const STN = { tobill: "billing sheet not created", sheet: "sheet sent &#183; awaiting ERP order ID", linked: "ERP order linked &#183; nothing matched yet", billed: "fully billed", closed: "pending short-closed" };
const CAT = o => o.stage === "sheet" || o.stage === "linked" ? "tobill" : o.stage === "billed" ? "closed" : o.stage;
const ACTION = ["tobill", "sheet", "linked", "partial"];

/* ---------- avatars (drawn inline, on the person's colour) ---------- */
const SK = { l: "#e9bb8f", m: "#d39b6a", t: "#b57a4c", d: "#8a5733" }, HR = "#2a1c14";
const aEyes = (y, dx) => `<circle cx="${32 - dx}" cy="${y}" r="1.7" fill="#22160f"/><circle cx="${32 + dx}" cy="${y}" r="1.7" fill="#22160f"/>`;
const aSmile = (y, w) => `<path d="M${32 - w} ${y}q${w} ${w * .75} ${2 * w} 0" stroke="#5b2d1c" stroke-width="1.6" fill="none" stroke-linecap="round"/>`;
const aLips = y => `<path d="M28.4 ${y}q3.6 3 7.2 0" stroke="#b03e5a" stroke-width="1.8" fill="none" stroke-linecap="round"/>`;
const aEars = (x, y, c) => `<ellipse cx="${32 - x}" cy="${y}" rx="2.6" ry="3.6" fill="${c}"/><ellipse cx="${32 + x}" cy="${y}" rx="2.6" ry="3.6" fill="${c}"/>`;
const aLean = c => `<path d="M11 64c1-11 9-17 21-17s20 6 21 17z" fill="${c}"/>`;
const aNeck = (c, y) => `<rect x="28" y="${y}" width="8" height="9" fill="${c}"/><rect x="28" y="${y}" width="8" height="3" fill="#000" opacity=".08"/>`;
const aBlush = (y, dx, o) => `<circle cx="${32 - dx}" cy="${y}" r="2.8" fill="#e0695a" opacity="${o}"/><circle cx="${32 + dx}" cy="${y}" r="2.8" fill="#e0695a" opacity="${o}"/>`;
const AVATARS = {
  boss: `<path d="M-1 64c1-13 13-20 33-20s32 7 33 20z" fill="#33508a"/><path d="M26 44.5l6 6.5 6-6.5z" fill="#f2f2f2"/>${aEars(18.5, 31, SK.m)}<ellipse cx="32" cy="30" rx="18" ry="17" fill="${SK.m}"/><path d="M21 42q11 7 22 0" stroke="#000" stroke-opacity=".16" stroke-width="1.5" fill="none"/><path d="M14.6 33q-.8-6 2.2-10.5M49.4 33q.8-6-2.2-10.5" stroke="${HR}" stroke-width="3" stroke-linecap="round" fill="none"/><ellipse cx="25" cy="18" rx="6" ry="2.4" fill="#fff" opacity=".35" transform="rotate(-18 25 18)"/><path d="M23 25.5h5M36 25.5h5" stroke="${HR}" stroke-width="1.6" stroke-linecap="round"/>${aEyes(29.5, 6.5)}${aBlush(35, 11, .25)}<path d="M25 36.5q7 6.5 14 0" stroke="#5b2d1c" stroke-width="1.7" fill="none" stroke-linecap="round"/>`,
  specs: `<path d="M3 64c1-12 12-18 29-18s28 6 29 18z" fill="#2f7a6a"/>${aNeck(SK.t, 40)}${aEars(15.5, 31, SK.t)}<ellipse cx="32" cy="30.5" rx="15.5" ry="15.5" fill="${SK.t}"/><path d="M16.6 29q-1.5-15.5 15.4-15.8 16.9.3 15.4 15.8-1.6-6.8-6.5-8.6-7.4 2.6-17.3.6-5.2 2-7 8z" fill="${HR}"/>${aEyes(31.5, 6.5)}<g fill="rgba(200,228,255,.28)" stroke="#1d1d1d" stroke-width="1.7"><circle cx="25.5" cy="31.2" r="4.9"/><circle cx="38.5" cy="31.2" r="4.9"/></g><path d="M30.4 31h3.2M20.6 30.4h-4M43.4 30.4h4" stroke="#1d1d1d" stroke-width="1.6"/>${aBlush(37, 10.5, .2)}${aSmile(39, 4.5)}`,
  hattrick: `${aLean("#8a4f2a")}${aNeck(SK.m, 41)}${aEars(11.5, 33, SK.m)}<ellipse cx="32" cy="33" rx="11.5" ry="13.8" fill="${SK.m}"/>${aEyes(32.5, 5)}<path d="M29.4 39.6q2.6 1.6 5.2 0" stroke="#5b2d1c" stroke-width="1.5" fill="none" stroke-linecap="round"/><g fill="${HR}" opacity=".8"><ellipse cx="23.3" cy="37.5" rx="1.4" ry="2.6"/><ellipse cx="40.7" cy="37.5" rx="1.4" ry="2.6"/><ellipse cx="25.8" cy="42.6" rx="1.7" ry="1.6"/><ellipse cx="38.2" cy="42.6" rx="1.7" ry="1.6"/><ellipse cx="31" cy="45.6" rx="2" ry="1.3"/><ellipse cx="35" cy="44.8" rx="1" ry="1"/><ellipse cx="29.4" cy="37.4" rx="1.6" ry=".8"/><ellipse cx="35.2" cy="37.6" rx="1.2" ry=".7"/></g><ellipse cx="32" cy="23.2" rx="18.5" ry="3.6" fill="#3a3a3a"/><path d="M21 23.2q0-12.6 11-13 11 .4 11 13z" fill="#4b4b4b"/><path d="M21.2 19.3h21.6v3H21.2z" fill="#c8a24a"/>`,
  pocket: `<path d="M55 12v48M53 12h4M53 24h3M53 36h4M53 48h3M53 60h4" stroke="#fff" stroke-opacity=".45" stroke-width="1.2"/><g transform="translate(8.96 17.92) scale(.72)">${aLean("#e2a33b")}${aNeck(SK.l, 41)}${aEars(12, 33, SK.l)}<ellipse cx="32" cy="33" rx="12" ry="13.2" fill="${SK.l}"/><path d="M20 30l1.5-9 3.2 3.4 2.6-7 3.2 5.6 3.2-6.2 2.8 6 3.4-4.4.9 8.6q-5-4-10.4-4-6.4 0-10.4 7z" fill="${HR}"/>${aEyes(33, 5)}<path d="M27 38.5q5 6 10 0z" fill="#5b2d1c"/></g>`,
  rockstar: `${aLean("#262626")}<path d="M19.2 33q-1.4-21 12.8-21 14.2 0 12.8 21l1.4 16q-4 2.4-7.2-.6l-.8-12.4H25.8l-.8 12.4q-3.2 3-7.2.6z" fill="#3b2617"/>${aNeck(SK.t, 41)}<ellipse cx="32" cy="32.5" rx="11" ry="13.2" fill="${SK.t}"/><path d="M20.8 31q.4-13.6 11.2-13.8 10.8.2 11.2 13.8-4.2-7.6-10.2-8.6-1.6 3.4-4.4 4.6-3.8 1.6-7.8 4z" fill="#3b2617"/>${aEyes(33, 5)}${aSmile(38.5, 3.6)}`,
  curly: `${aLean("#c2593a")}${aNeck(SK.d, 41)}${aEars(12.5, 33, SK.d)}<ellipse cx="32" cy="33" rx="12.5" ry="14" fill="${SK.d}"/><g fill="${HR}">${[[20.5, 27], [21.5, 21.5], [25.5, 17.5], [31, 15.5], [36.5, 16.5], [41, 19.5], [43.5, 25], [27, 22], [33, 20.5], [38.5, 22.5]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="5"/>`).join("")}</g>${aEyes(33, 5)}${aSmile(39, 4)}`,
  tash: `<path d="M7 64c1-12 11-18 25-18s24 6 25 18z" fill="#5b4a9a"/>${aNeck(SK.m, 41)}<path d="M26.5 46l5.5 6 5.5-6z" fill="#fff"/>${aEars(13, 32.5, SK.m)}<ellipse cx="32" cy="32" rx="13" ry="14.5" fill="${SK.m}"/><path d="M19 30q-1.2-15.6 13-15.8 14.2.2 13 15.8-1.4-8-5.6-9.6-9.4 1.6-16.4-1.4-3 2.6-4 11z" fill="${HR}"/><path d="M24 27h5.5M34.5 27H40" stroke="${HR}" stroke-width="1.8" stroke-linecap="round"/>${aEyes(31, 5.5)}<path d="M24.5 38.6q3.6-3.4 7.5-1.2 3.9-2.2 7.5 1.2-3.4 2.4-7.5.8-4.1 1.6-7.5-.8z" fill="${HR}"/><path d="M29 42.4q3 1.4 6 0" stroke="#5b2d1c" stroke-width="1.4" fill="none" stroke-linecap="round"/>`,
  cap: `${aLean("#1f6fb2")}${aNeck(SK.d, 41)}${aEars(12.5, 33, SK.d)}<ellipse cx="32" cy="33" rx="12.5" ry="14" fill="${SK.d}"/><ellipse cx="32" cy="41" rx="9" ry="6" fill="${HR}" opacity=".14"/><path d="M19.4 28q0-14.4 12.6-14.6 12.6.2 12.6 14.6z" fill="#e4572e"/><path d="M30 27.2q13-3.4 23 1.6-11 2.4-23 .6z" fill="#b8401f"/><circle cx="32" cy="13.8" r="1.4" fill="#b8401f"/>${aEyes(33, 5)}${aSmile(38.8, 4)}`,
  bun: `${aLean("#d0577a")}${aNeck(SK.t, 41)}<circle cx="32" cy="13" r="6.2" fill="${HR}"/>${aEars(12.5, 33.5, SK.t)}<ellipse cx="32" cy="33" rx="12.5" ry="14" fill="${SK.t}"/><path d="M19.6 31q-.8-15 12.4-15.2 13.2.2 12.4 15.2-2.4-8.6-12.4-9.6-10 1-12.4 9.6z" fill="${HR}"/><circle cx="19.5" cy="38.2" r="1.3" fill="#e8c14a"/><circle cx="44.5" cy="38.2" r="1.3" fill="#e8c14a"/>${aEyes(33, 5)}${aLips(39)}`,
  flow: `${aLean("#2d8a9e")}<path d="M17 36q-2-24 15-24t15 24l2.5 22q-17.5 6-35 0z" fill="#4a2c1a"/>${aNeck(SK.m, 41)}<ellipse cx="32" cy="32.5" rx="11.8" ry="13.6" fill="${SK.m}"/><path d="M20.4 32q-.2-15.2 11.6-15.6 12 .2 12 14.6-7.6-1.4-13-8.4-3 6.4-10.6 9.4z" fill="#4a2c1a"/>${aEyes(33, 5)}${aLips(39)}`,
};
const AV_LIST = [["boss", "Big Boss"], ["specs", "Specs"], ["hattrick", "Hat-trick"], ["pocket", "Pocket Rocket"], ["rockstar", "Rockstar"], ["curly", "Curly"], ["tash", "The Tash"], ["cap", "Cap On"], ["bun", "Top Knot"], ["flow", "Free Flow"]];
const DUGOUT_AV = size => `<span class="av dgav" style="width:${size}px;height:${size}px;font-size:${Math.round(size * .5)}px">&#127951;</span>`;
function avatarHtml(t, size) {
  size = size || 42; const st = `width:${size}px;height:${size}px;background:${attr((t && t.colour) || "#7c929b")}`;
  if (t && t.avatar && AVATARS[t.avatar]) return `<span class="av avs" style="${st}"><svg viewBox="0 0 64 64" aria-hidden="true">${AVATARS[t.avatar]}</svg></span>`;
  return `<span class="av avi" style="${st};font-size:${Math.round(size * .36)}px">${esc(initials(t ? t.name : "?"))}</span>`;
}
B.avatar = (id, size) => avatarHtml(BOOT.team.find(t => t.id === id), size);
B.meId = () => meId();
B.meBadge = () => isMgr() ? DUGOUT_AV(26) : meId() ? `<button class="mebadge" id="meav" title="Change your avatar">${B.avatar(meId(), 26)}</button>` : "";
/* avatar picker: the backend team / Management for anyone, a sales person for themselves */
B.pickAvatar = function (tid, onDone) {
  const t = BOOT.team.find(x => x.id === tid); if (!t) return; let cur = t.avatar || "";
  const self = !viewer() && !isBE() && meId() === tid;
  const m = modal(`<div class="mh"><h3>Pick an avatar &#183; ${esc(t.name)}</h3><button data-close>&times;</button></div>
   <div class="mbody"><div class="avgrid">${[["", "Initials"]].concat(AV_LIST).map(([k, label]) => `<button class="avopt ${k === cur ? "on" : ""}" data-avk="${k}">${avatarHtml(Object.assign({}, t, { avatar: k }), 72)}<span>${label}</span></button>`).join("")}</div></div>
   <div class="mf"><span class="mut">Shows on the sign-in screen and the Dugout scoreboard.</span><div class="hbtns"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="av-go">Save avatar</button></div></div>`, { wide: true });
  m.querySelectorAll("[data-avk]").forEach(b => b.onclick = () => { cur = b.dataset.avk; m.querySelectorAll(".avopt").forEach(x => x.classList.toggle("on", x === b)); });
  m.querySelector("#av-go").onclick = async e => {
    e.target.disabled = true;
    try { await B.api(self ? "my_avatar" : "team_save", self ? { avatar: cur } : { id: tid, avatar: cur }); await reloadBoot(); closeModal(); toast("Avatar saved", "ok"); onDone && onDone(); }
    catch (er) { e.target.disabled = false; toast(er.message, "err"); }
  };
};

/* ---------- tables: column picker, drag-to-resize, click-to-sort — saved per user in the shared database ---------- */
let PREFS = {}, prefsP = null, prefsT = null, keepColMenu = null;
function loadPrefs() { if (!prefsP) prefsP = B.api("prefs").then(j => { PREFS = j.prefs || {}; }).catch(() => { PREFS = {}; }); return prefsP; }
function savePrefs() { clearTimeout(prefsT); prefsT = setTimeout(() => B.api("prefs", { prefs: PREFS }).catch(() => {}), 500); }
const gp = id => PREFS[id] || (PREFS[id] = {});
const gHidden = (id, cols) => gp(id).hid || cols.filter(c => c.hide).map(c => c.k);
function gSort(id, cols, rows) {
  const s = gp(id).sort, c = s && cols.find(x => x.k === s.k); if (!c || !c.sv) return rows;
  const d = s.d === "desc" ? -1 : 1;
  return rows.slice().sort((a, b) => { let x = c.sv(a), y = c.sv(b); if (x == null) x = ""; if (y == null) y = "";
    return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "en", { numeric: true })) * d; });
}
function gTable(id, cols, rows, o) {
  o = o || {}; const hid = gHidden(id, cols), vis = cols.filter(c => c.fixed || !hid.includes(c.k)), p = gp(id), w = p.w || {}, s = p.sort || {};
  const cw = c => w[c.k] || c.w || 120, tw = vis.reduce((t, c) => t + cw(c), 0);
  return `<table class="gt ${o.cls || ""}" data-grid="${id}" style="width:${tw}px"><colgroup>${vis.map(c => `<col data-c="${c.k}" style="width:${cw(c)}px">`).join("")}</colgroup>
   <thead><tr>${vis.map(c => `<th data-c="${c.k}" class="${c.num ? "num" : ""} ${c.sv ? "srt" : "nosrt"} ${s.k === c.k ? "on" : ""}" ${c.sv ? 'title="Click to sort"' : ""}>${c.h}${c.sv ? `<i class="sa">${s.k === c.k ? (s.d === "desc" ? "&#9660;" : "&#9650;") : "&#8693;"}</i>` : ""}<span class="rz" title="Drag to resize"></span></th>`).join("")}</tr></thead>
   <tbody>${rows.map(r => `<tr ${o.tr ? o.tr(r) : ""}>${vis.map(c => `<td class="${c.num ? "num tnum" : ""} ${c.tc || ""}">${c.td(r)}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="${vis.length}" class="bempty" style="padding:34px">${o.empty || "Nothing here."}</td></tr>`}${o.more ? o.more(vis.length) : ""}</tbody>
   ${o.foot && rows.length ? `<tfoot><tr>${vis.map(c => `<td class="${c.num ? "num tnum" : ""}">${c.ft ? c.ft(o.foot) : ""}</td>`).join("")}</tr></tfoot>` : ""}</table>`;
}
function gPicker(id, cols) {
  const hid = gHidden(id, cols);
  return `<div class="ms colpick"><button class="xbtn" data-colbtn>&#9638; Columns</button><div class="msmenu" hidden><div class="mut" style="font-size:11.5px;padding:2px 6px 6px">Show columns &#183; drag a header edge to resize, click a header to sort</div><div class="msopts">${cols.filter(c => !c.fixed).map(c => `<label><input type="checkbox" data-colk="${c.k}" ${hid.includes(c.k) ? "" : "checked"}> ${c.label || c.h}</label>`).join("")}</div><div class="msfoot"><button data-colreset>Reset columns, widths &amp; sort</button></div></div></div>`;
}
function gWire(host, id, cols, redraw) {
  const p = gp(id), cb = host.querySelector("[data-colbtn]");
  if (cb) {
    const menu = cb.nextElementSibling;
    cb.onclick = e => { e.stopPropagation(); const h = menu.hidden; document.querySelectorAll(".msmenu").forEach(x => x.hidden = true); menu.hidden = !h; };
    menu.onclick = e => e.stopPropagation();
    if (keepColMenu === id) { menu.hidden = false; keepColMenu = null; }
    menu.querySelectorAll("[data-colk]").forEach(x => x.onchange = () => { const hid = new Set(gHidden(id, cols)); if (x.checked) hid.delete(x.dataset.colk); else hid.add(x.dataset.colk); p.hid = [...hid]; savePrefs(); keepColMenu = id; redraw(); });
    menu.querySelector("[data-colreset]").onclick = () => { delete PREFS[id]; savePrefs(); redraw(); };
  }
  const t = host.querySelector(`table[data-grid="${id}"]`); if (!t) return;
  t.querySelectorAll("th.srt").forEach(th => th.onclick = e => {
    if (e.target.closest(".rz,input")) return;
    const k = th.dataset.c, s = p.sort, c = cols.find(x => x.k === k);
    p.sort = s && s.k === k ? { k, d: s.d === "asc" ? "desc" : "asc" } : { k, d: c.num ? "desc" : "asc" }; savePrefs(); redraw();
  });
  t.querySelectorAll(".rz").forEach(h => {
    h.onclick = e => e.stopPropagation();
    h.onmousedown = e => {
      e.preventDefault(); e.stopPropagation();
      const k = h.parentElement.dataset.c, col = t.querySelector(`col[data-c="${k}"]`), x0 = e.clientX, w0 = parseInt(col.style.width) || h.parentElement.offsetWidth, tw0 = parseInt(t.style.width) || t.offsetWidth;
      document.body.classList.add("rzing");
      const mv = ev => { const nw = Math.max(48, Math.round(w0 + ev.clientX - x0)); col.style.width = nw + "px"; t.style.width = (tw0 - w0 + nw) + "px"; };
      const up = () => { document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up); document.body.classList.remove("rzing"); p.w = p.w || {}; p.w[k] = parseInt(col.style.width) || w0; savePrefs(); };
      document.addEventListener("mousemove", mv); document.addEventListener("mouseup", up);
    };
    h.ondblclick = e => { e.stopPropagation(); const k = h.parentElement.dataset.c; if (p.w) { delete p.w[k]; savePrefs(); redraw(); } };
  });
}

/* ---------- who's in ---------- */
B.whoValid = function () {
  const w = ls(WHO_KEY);
  if (w === "backend") { if (BOOT.pin_required && !ss("txy_pin")) return false; B.who = w; return true; }
  if (w === "dugout") { if (BOOT.dugout_pin_required && !ss("txy_pin")) return false; B.who = w; return true; }
  if (w && w.startsWith("tm:") && BOOT.team.some(t => t.active && "tm:" + t.id === w)) { B.who = w; return true; }
  return false;
};
B.renderWho = function (onDone) {
  const el = document.getElementById("who"); el.hidden = false;
  const tm = BOOT.team.filter(t => t.active);
  const cnt = id => BOOT.dealers.filter(d => d.team_id === id && !d.excluded).length;
  el.innerHTML = `<div class="whocard"><div class="ovr">Ten &#215; You &#183; Offline Sales</div><h2>Who's batting?</h2>
   <p>Pick your name &#8212; you'll see your own dealers and orders.</p>
   <div class="tiles">${tm.map(t => `<button class="tile" data-w="tm:${t.id}">${avatarHtml(t, 64)}<span class="tn">${esc(t.name)}</span><span class="td">${cnt(t.id)} dealer${cnt(t.id) === 1 ? "" : "s"}</span></button>`).join("") || '<div class="tblnote" style="grid-column:1/-1">No team members yet &#8212; the backend team adds them in Backend &#8594; Sales team.</div>'}</div>
   <div class="whosep"><span>or</span></div>
   <button class="tile be dg" data-w="dugout">${DUGOUT_AV(42)}<span class="tn">The Dugout &#183; Sales manager</span><span class="td">Whole team's orders, billing &amp; scoreboard &#8212; view only</span></button>
   <button class="tile be" data-w="backend"><span class="av">BE</span><span class="tn">Backend &#183; Billing desk</span><span class="td">All orders &amp; dealers, billing sheets, ERP linking, sales team</span></button>
   <div class="pinrow" id="pinrow" hidden><input type="password" id="bepin" placeholder="PIN" autocomplete="off"><button class="btn primary" id="bepinok">Enter</button></div>
   <div class="gerr" id="whoerr" hidden></div></div>`;
  const done = w => { ls(WHO_KEY, w); B.who = w; ORD = null; ORDERS = null; el.hidden = true; el.innerHTML = ""; onDone && onDone(); };
  let pinFor = null;
  const needPin = w => (w === "backend" && BOOT.pin_required) || (w === "dugout" && BOOT.dugout_pin_required);
  el.querySelectorAll(".tile").forEach(b => b.onclick = () => {
    const w = b.dataset.w;
    if (needPin(w)) { pinFor = w; document.getElementById("pinrow").hidden = false; const pi = document.getElementById("bepin"); pi.placeholder = w === "dugout" ? "Dugout PIN" : "Backend PIN"; pi.value = ""; pi.focus(); return; }
    done(w);
  });
  const go = async () => {
    ss("txy_pin", document.getElementById("bepin").value.trim()); B.who = pinFor;
    try { await B.api("boot"); done(pinFor); } catch (e) { const er = document.getElementById("whoerr"); er.hidden = false; er.textContent = e.message; }
  };
  const ok = document.getElementById("bepinok"); if (ok) { ok.onclick = go; document.getElementById("bepin").onkeydown = e => { if (e.key === "Enter") go(); }; }
};
/* Entry screen: Billing or Sales dashboard. Only Billing asks for a name. */
const MODE_KEY = "txy_mode";
B.mode = () => { const m = ss(MODE_KEY); return m === "billing" || m === "dash" ? m : null; };
B.setMode = m => { if (m !== B.curMode) ORDERS = null; B.curMode = m; ss(MODE_KEY, m); };
B.renderMode = function (onDone) {
  const el = document.getElementById("who"); el.hidden = false;
  el.innerHTML = `<div class="whocard"><div class="ovr">Ten &#215; You &#183; Offline Sales</div><h2>What are we opening?</h2>
   <p>You can switch any time from the top bar.</p>
   <div class="modetiles">
    <button class="mtile" data-m="billing"><span class="mi"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2h9l5 5v15H6z"/><path d="M14 2v6h6"/><path d="M9 13h7M9 17h5"/></svg></span><span class="tn">Billing</span>
     <span class="td">Place orders for your dealers and track ordered &#183; billed &#183; pending. Backend: billing desk &amp; ERP order IDs. You'll pick your name next.</span></button>
    <button class="mtile" data-m="dash"><span class="mi"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg></span><span class="tn">Sales dashboard</span>
     <span class="td">Net offline sales by team member, dealer &amp; product, Dealer Lens and Management. No name needed.</span></button>
   </div></div>`;
  el.querySelectorAll("[data-m]").forEach(b => b.onclick = () => {
    const m = b.dataset.m; B.setMode(m); el.hidden = true; el.innerHTML = "";
    if (m === "billing" && !B.whoValid()) B.renderWho(onDone); else onDone && onDone();
  });
};
B.switchUser = function (onDone) { ls(WHO_KEY, null); ss("txy_pin", ""); B.who = null; B.renderWho(onDone); };
B.whoLabel = () => B.who === "backend" ? "Backend" : B.who === "dugout" ? "The Dugout" : (teamName(meId()) || "");
B.isBackend = isBE;
B.isMgr = isMgr;

/* ---------- item master ---------- */
B.loadItems = function () {
  if (!itemsP) itemsP = B.api("items").then(j => {
    ITEMS = j.items; ITEM = {}; GROUPS = {}; GLIST = [];
    ITEMS.forEach(([code, name, style, col, size, grp]) => {
      const gk = (style || name) + "|" + col; let g = GROUPS[gk];
      if (!g) { g = GROUPS[gk] = { k: gk, name, style, col: fmtCol(col), grp, skus: [] }; GLIST.push(g); }
      g.skus.push({ code, size: size || "-" });
      ITEM[code.toUpperCase()] = { code, name, style, col: fmtCol(col), size: size || "-", gk };
    });
    GLIST.forEach(g => { g.skus.sort((a, b) => szCmp(a.size, b.size)); g.hay = (g.name + " " + g.col + " " + g.style + " " + g.grp + " " + g.skus.map(s => s.code).join(" ")).toLowerCase(); });
    GLIST.sort((a, b) => a.name.localeCompare(b.name) || a.col.localeCompare(b.col));
    return ITEMS;
  }).catch(e => { itemsP = null; throw e; });
  return itemsP;
};

/* ---------- orders data ---------- */
async function ensureOrders(force) {
  if (ORDERS && !force && Date.now() - OAT < 60000) return ORDERS;
  const j = await B.api("orders" + (force === "sync" ? "&sync=1" : ""));
  ORDERS = j.orders; OMETA = j; OAT = Date.now();
  if (j.warning) toast(j.warning, "err");
  return ORDERS;
}
B.invalidate = () => { ORDERS = null; };
B.toast = (m, k) => toast(m, k);
B.getOrders = ensureOrders;
B.STG = STG; B.ACTION = ACTION; B.stagePill = stagePill; B.orders = () => ORDERS;

/* =================================================================== NEW ORDER */
const blankOrd = () => ({ id: null, ref: null, status: null, dealer_id: null, dealer_ov: null, ship_sel: null, po_ref: "", remarks: "", groups: [], lines: {}, gp: {}, bad: [] });
const dealerComplete = d => !!(d && d.phone && d.bill_street && d.bill_city && d.bill_pin && d.bill_state && (d.ship_same || (d.ship_street && d.ship_city && d.ship_pin && d.ship_state)));
/* the dealer as used on this order: master details + any edits made for this order only */
function ordDealer() {
  const d = dealerById(ORD.dealer_id); if (!d) return null;
  const m = Object.assign({}, d), ad = d.ship_addrs || [], a0 = ad[0] || {};
  Object.assign(m, { ship_gstin: a0.gstin || "", ship_label: a0.label || "", ship_country: a0.country || d.country });
  const sel = ORD.ship_sel;
  if (sel && sel.idx < 0) Object.assign(m, { ship_same: true, ship_street: d.bill_street, ship_city: d.bill_city, ship_pin: d.bill_pin, ship_state: d.bill_state, ship_gstin: "", ship_label: "Billing address", ship_country: d.country });
  else if (sel) Object.assign(m, { ship_same: false, ship_street: sel.street, ship_city: sel.city, ship_pin: sel.pin, ship_state: sel.state, ship_gstin: sel.gstin || "", ship_label: sel.label || "", ship_country: sel.country || d.country });
  Object.assign(m, ORD.dealer_ov || {}); m.complete = dealerComplete(m); return m;
}
const shipIdx = d => ORD.ship_sel ? ORD.ship_sel.idx : ((d.ship_addrs || []).length ? 0 : -1);
const aText = a => [a.street, a.city, [a.state, a.pin].filter(Boolean).join(" "), a.country && a.country !== "IN" ? a.country : ""].filter(Boolean).join(", ");
const saveLocal = () => { if (ORD && !ORD.id) ls("txy_ord_" + B.who, JSON.stringify(ORD)); };
const loadLocal = () => { try { const v = ls("txy_ord_" + B.who); return v ? Object.assign(blankOrd(), JSON.parse(v)) : null; } catch (e) { return null; } };
const clearLocal = () => ls("txy_ord_" + B.who, null);
function ordHasContent() { return ORD && (ORD.groups.length || ORD.bad.length || ORD.dealer_id); }

async function renderNew() {
  const host = document.getElementById("b-new");
  if (!ORD) ORD = loadLocal() || blankOrd();
  if (!ITEMS) {
    host.innerHTML = loading("Loading the item master from ERP…");
    try { await B.loadItems(); } catch (e) { host.innerHTML = errCard("Couldn't load the item master: " + e.message); return; }
    if (tab !== "b-new") return;
  }
  if (ORD.dealer_id && !myDealers().some(d => d.id === ORD.dealer_id)) ORD.dealer_id = null;
  const editing = !!ORD.id, submitted = ORD.status === "submitted";
  host.innerHTML = `
  <div class="ohead"><div><h2>${editing ? "Edit order " + esc(ORD.ref) : "New order"}</h2><div class="mut">Pick the dealer, add products with sizes &amp; quantities, then submit to billing.</div></div>
    <div class="hbtns">${editing ? '<button class="btn ghost" data-act="discard">Discard changes</button>' : (ordHasContent() ? '<button class="btn ghost" data-act="clear">Start over</button>' : "")}</div></div>
  ${editing && ORD.sheet_at ? `<div class="lockbox" style="margin-bottom:14px"><span class="lk">&#9888;</span><div><b>The billing sheet for this order was already created${ORD.billed ? ` and ${units(ORD.billed)} units are billed in ERP` : ""}.</b><br><span class="mut">Your changes update ordered and pending quantities here. If ERP needs them too, re-download the billing sheet after saving. Billed quantities still come from ERP.</span></div></div>` : ""}
  <div class="card"><div class="head"><h3><span class="stepn">1</span>Dealer</h3><button class="btn ghost sm" data-act="newdealer">+ New dealer</button></div>
      <div id="dcombo"></div><div id="dsum"></div></div>
  <div class="card" style="margin-top:14px"><div class="head"><h3><span class="stepn">2</span>Products &amp; sizes</h3>
      <div class="hbtns"><button class="btn primary sm" data-act="addprod">+ Add product</button><button class="btn ghost sm" data-act="tpl">&#8595; Excel template</button><label class="btn ghost sm" title="Upload a filled template">&#8593; Upload Excel<input type="file" id="oup" accept=".xlsx,.xls,.csv" hidden></label></div></div>
    <div class="psearch"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input id="ps" placeholder="Search product, style, colour or SKU and press Enter…" autocomplete="off"><div class="presults" id="pres" hidden></div></div>
    <div id="obad"></div><div id="olines"></div><div id="paddslot"></div></div>
  <div class="savebar"><div class="stot" id="otot"></div><div class="spacer"></div>
    ${submitted ? "" : '<button class="btn ghost" data-act="draft">Save draft</button>'}
    <button class="btn primary" data-act="submit">${submitted ? "Save changes" : "Submit to billing &#8594;"}</button></div>`;
  drawDealerCombo(); drawDealerSum(); drawBad(); drawLines(); wireSearch();
  host.querySelector("#oup").onchange = e => { const f = e.target.files[0]; e.target.value = ""; if (f) importFile(f); };
  host.querySelectorAll("[data-act]").forEach(b => b.onclick = () => {
    const a = b.dataset.act;
    if (a === "addprod") { const ps = document.getElementById("ps"); ps.scrollIntoView({ block: "center", behavior: "smooth" }); ps.focus(); return; }
    if (a === "newdealer") dealerForm(null, d => { ORD.dealer_id = d.id; saveLocal(); drawDealerCombo(); drawDealerSum(); });
    else if (a === "tpl") downloadTemplate();
    else if (a === "clear") { if (confirm("Clear this order and start over?")) { ORD = blankOrd(); clearLocal(); renderNew(); } }
    else if (a === "discard") { ORD = null; show("b-orders"); }
    else if (a === "draft") saveOrder("draft");
    else if (a === "submit") saveOrder("submit");
  });
}

function drawDealerCombo() {
  const host = document.getElementById("dcombo"); if (!host) return;
  const list = myDealers(), cur = dealerById(ORD.dealer_id);
  host.innerHTML = `<div class="ms" style="min-width:0"><button class="msbtn" id="dbtn"><span>${cur ? esc(cur.name) : '<span style="color:var(--muted);font-weight:500">Select an existing dealer…</span>'}</span><span class="car">&#9662;</span></button>
   <div class="msmenu" id="dmenu" hidden style="width:100%"><input type="search" id="dsrch" placeholder="Search ${list.length} dealer${list.length === 1 ? "" : "s"}…"><div class="msopts" id="dopts"></div>
   <div class="msfoot"><button id="dnew">+ New dealer</button><span style="color:var(--muted)">${isBE() ? "all dealers" : "dealers tagged to you"}</span></div></div></div>`;
  const menu = host.querySelector("#dmenu"), srch = host.querySelector("#dsrch"), opts = host.querySelector("#dopts");
  function paint(q) {
    q = (q || "").toLowerCase();
    const f = list.filter(d => (d.name + " " + (d.bill_city || "") + " " + (d.gstin || "") + " " + (d.phone || "")).toLowerCase().includes(q));
    opts.innerHTML = f.map(d => `<div class="dopt ${d.id === ORD.dealer_id ? "on" : ""}" data-d="${d.id}"><b>${esc(d.name)}</b><span>${esc([d.bill_city, d.bill_state].filter(Boolean).join(", ") || "no address yet")}${d.complete ? "" : ' &#183; <i class="wtxt">details incomplete</i>'}</span></div>`).join("")
      || `<div class="tblnote" style="padding:10px">${list.length ? "No match." : "No dealers yet — add your first one."}</div>`;
    opts.querySelectorAll(".dopt").forEach(o => o.onclick = () => { if (ORD.dealer_id !== +o.dataset.d) { ORD.dealer_ov = null; ORD.ship_sel = null; } ORD.dealer_id = +o.dataset.d; saveLocal(); menu.hidden = true; drawDealerCombo(); drawDealerSum(); });
  }
  host.querySelector("#dbtn").onclick = e => { e.stopPropagation(); menu.hidden = !menu.hidden; if (!menu.hidden) { paint(""); srch.focus(); } };
  menu.onclick = e => e.stopPropagation();
  srch.oninput = () => paint(srch.value);
  host.querySelector("#dnew").onclick = () => { menu.hidden = true; dealerForm(null, d => { ORD.dealer_id = d.id; saveLocal(); drawDealerCombo(); drawDealerSum(); }); };
}
function addrText(d, p) { return [d[p + "_street"], d[p + "_city"], [d[p + "_state"], d[p + "_pin"]].filter(Boolean).join(" ")].filter(Boolean).join(", "); }
function drawDealerSum() {
  const el = document.getElementById("dsum"); if (!el) return; const d = ordDealer();
  if (!d) { el.innerHTML = `<div class="tblnote" style="margin-top:10px">First order for a dealer? Use <b>+ New dealer</b> to add their details once &#8212; next time just pick them here.</div>`; return; }
  el.innerHTML = `<div class="dsum"><label class="chk intlchk" style="margin:0 0 8px"><input type="checkbox" id="ointl" ${d.is_intl ? "checked" : ""}> <b>International order</b> <span class="mut">&#8212; ships outside India: no GSTIN, country code on the billing sheet</span></label>${d.complete ? "" : `<div class="wbox">Some details are missing &#8212; billing needs a mobile number and address. <button class="lnk" data-ed>Add them for this order</button></div>`}
    ${ORD.dealer_ov ? `<div class="ovbox">&#9998; Edited for <b>this order only</b> &#8212; the dealer master is unchanged. <button class="lnk" data-undo>Undo</button></div>` : ""}
    ${d.is_intl ? `<div class="kv"><span>Customer</span><b>International &#183; ${esc(d.country || "")}</b></div>` : `<div class="kv"><span>GSTIN</span><b>${esc(d.gstin || "— not registered")}</b></div>`}
    <div class="kv"><span>${d.is_intl ? "Phone" : "Mobile"}</span><b>${esc(d.phone || "—")}</b></div>
    <div class="kv"><span>Bill to</span><b>${esc(addrText(d, "bill") || "—")}${d.is_intl && d.country ? ", " + esc(d.country) : ""}</b></div>
    ${(() => { const base = dealerById(ORD.dealer_id), ad = base.ship_addrs || [];
      if (!ad.length || (ORD.dealer_ov && ORD.dealer_ov.ship_street !== undefined)) return `<div class="kv"><span>Ship to</span><b>${d.ship_same ? "Same as billing" : (d.ship_label ? esc(d.ship_label) + " &#183; " : "") + esc(addrText(d, "ship") || "—")}${d.ship_gstin ? " &#183; GSTIN " + esc(d.ship_gstin) : ""}</b></div>`;
      const cur = shipIdx(base);
      return `<div class="kv"><span>Ship to</span><select id="oship" class="shipsel"><option value="-1" ${cur < 0 ? "selected" : ""}>Billing address &#8212; ${esc(base.bill_city || "")}</option>${ad.map((a, i) => `<option value="${i}" ${cur === i ? "selected" : ""}>${esc((a.label ? a.label + " — " : "") + aText(a))}</option>`).join("")}</select></div>${cur >= 0 && ad[cur] && ad[cur].gstin ? `<div class="kv"><span></span><span class="mut">Shipping GSTIN ${esc(ad[cur].gstin)}</span></div>` : ""}`; })()}
    ${d.complete ? '<button class="lnk" data-ed>Edit details for this order</button>' : ""}</div>`;
  el.querySelectorAll("[data-ed]").forEach(b => b.onclick = () => editOrdDealer());
  const ic = el.querySelector("#ointl"); if (ic) ic.onchange = () => editOrdDealer({ is_intl: ic.checked });
  const u = el.querySelector("[data-undo]"); if (u) u.onclick = () => { ORD.dealer_ov = null; saveLocal(); drawDealerSum(); };
  const sh = el.querySelector("#oship"); if (sh) sh.onchange = () => { const i = +sh.value, ad = dealerById(ORD.dealer_id).ship_addrs || []; ORD.ship_sel = i < 0 ? { idx: -1 } : Object.assign({ idx: i }, ad[i]); saveLocal(); drawDealerSum(); };
}
function editOrdDealer(preset) {
  const d = ordDealer(); if (!d) return;
  const before = ordDealer();
  dealerForm(Object.assign({}, d, preset || {}), cd => { const ov = {}; ["gstin", "phone", "contact", "email", "bill_street", "bill_city", "bill_pin", "bill_state", "country", "is_intl", "ship_same", "ship_street", "ship_city", "ship_pin", "ship_state", "ship_gstin", "ship_label", "ship_country"].forEach(k => ov[k] = cd[k]);
    const norm = v => String(v == null ? "" : v === true ? 1 : v === false ? 0 : v);
    const same = Object.keys(ov).every(k => norm(ov[k]) === norm(before[k])) && !ORD.dealer_ov;
    ORD.dealer_ov = same ? null : ov; saveLocal(); drawDealerSum(); }, { orderOnly: true, onCancel: drawDealerSum });
}

/* product search */
function wireSearch() {
  const inp = document.getElementById("ps"), res = document.getElementById("pres"); let hits = [], hi = 0;
  function find(q) {
    q = q.trim().toLowerCase(); if (!q) return [];
    const ex = ITEM[q.toUpperCase()]; const toks = q.split(/\s+/);
    let out = GLIST.filter(g => toks.every(t => g.hay.includes(t)));
    if (ex) out = [GROUPS[ex.gk]].concat(out.filter(g => g.k !== ex.gk));
    return out.slice(0, 14);
  }
  function paint() {
    if (!hits.length) { res.innerHTML = inp.value.trim() ? `<div class="pr none">No product matches &#8220;${esc(inp.value.trim())}&#8221;</div>` : ""; res.hidden = !inp.value.trim(); return; }
    res.innerHTML = hits.map((g, i) => `<div class="pr ${i === hi ? "hi" : ""}" data-i="${i}"><div><b>${esc(g.name)}</b>${g.col ? ` <span class="pc">${esc(g.col)}</span>` : ""}</div><div class="mut">${esc(g.style || g.skus[0].code)} &#183; ${g.skus.length > 1 ? "sizes " + esc(g.skus[0].size) + "–" + esc(g.skus[g.skus.length - 1].size) : esc(g.skus[0].code)}${ORD.groups.includes(g.k) ? ' &#183; <b class="ptxt">in order</b>' : ""}</div></div>`).join("");
    res.hidden = false;
    res.querySelectorAll(".pr[data-i]").forEach(r => r.onmousedown = e => { e.preventDefault(); pick(+r.dataset.i); });
  }
  function pick(i) {
    const g = hits[i]; if (!g) return;
    const ex = ITEM[inp.value.trim().toUpperCase()];
    if (!ORD.groups.includes(g.k)) ORD.groups.push(g.k);
    saveLocal(); inp.value = ""; hits = []; res.hidden = true; drawLines();
    const sel = ex && ex.gk === g.k ? `input[data-sku="${CSS.escape(ex.code)}"]` : `tr[data-g="${CSS.escape(g.k)}"] input.q`;
    const t = document.querySelector("#olines " + sel); if (t) { t.scrollIntoView({ block: "center", behavior: "smooth" }); t.focus(); }
  }
  inp.oninput = () => { hits = find(inp.value); hi = 0; paint(); };
  inp.onkeydown = e => {
    if (e.key === "ArrowDown") { e.preventDefault(); hi = Math.min(hits.length - 1, hi + 1); paint(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); hi = Math.max(0, hi - 1); paint(); }
    else if (e.key === "Enter") { e.preventDefault(); pick(hi); }
    else if (e.key === "Escape") { res.hidden = true; }
  };
  inp.onblur = () => setTimeout(() => res.hidden = true, 120);
  inp.onfocus = () => { if (hits.length) res.hidden = false; };
}

/* lines grid */
function groupOf(gk) { return GROUPS[gk] || { k: gk, name: gk.replace(/^~/, ""), col: "", style: "", skus: [{ code: gk.replace(/^~/, ""), size: "-" }] }; }
function grpPrice(g) {
  const ps = [...new Set(g.skus.map(s => ORD.lines[s.code]).filter(Boolean).map(l => l.price))];
  if (ps.length === 1) return ps[0] || "";
  if (ps.length > 1) return null;
  return ORD.gp[g.k] || "";
}
function grpTot(g) { let q = 0, v = 0; g.skus.forEach(s => { const l = ORD.lines[s.code]; if (l) { q += l.qty; v += l.qty * (l.price || 0); } }); return [q, v]; }
function drawLines() {
  const el = document.getElementById("olines"); if (!el) return;
  placeSearch();
  if (!ORD.groups.length) { el.innerHTML = `<div class="lempty"><b>No products yet.</b><br>Click <b>+ Add product</b> or search above &#8212; each product opens a size run so you can type quantities straight across &#8212; or fill the Excel template and upload it.</div>`; updTot(); return; }
  el.innerHTML = `<div class="scroll"><table class="ltbl"><thead><tr><th>Product</th><th>Sizes &amp; quantity</th><th class="num">Price / unit<br><span style="text-transform:none;letter-spacing:0;font-weight:500">incl. GST</span></th><th class="num">Units</th><th class="num">Value</th><th></th></tr></thead><tbody>
   ${ORD.groups.map(gk => { const g = groupOf(gk), p = grpPrice(g), [q, v] = grpTot(g);
     return `<tr data-g="${attr(gk)}"><td class="pcell"><b>${esc(g.name)}</b><div class="mut">${esc([g.col, g.style].filter(Boolean).join(" · "))}</div></td>
      <td><div class="szs">${g.skus.map(s => { const l = ORD.lines[s.code]; return `<label class="sz ${l ? "has" : ""}" title="${attr(s.code)}"><span>${esc(s.size)}</span><input class="q" data-sku="${attr(s.code)}" inputmode="numeric" value="${l ? l.qty : ""}" autocomplete="off"></label>`; }).join("")}</div></td>
      <td class="num"><div class="pin"><span>&#8377;</span><input class="pr" inputmode="decimal" value="${p === null ? "" : p}" placeholder="${p === null ? "mixed" : "0"}"></div></td>
      <td class="num tnum gq">${units(q)}</td><td class="num tnum gv">${money(v)}</td>
      <td><button class="rm" title="Remove product">&times;</button></td></tr>`; }).join("")}
   </tbody></table></div>`;
  el.querySelectorAll("tr[data-g]").forEach(tr => {
    const gk = tr.dataset.g, g = groupOf(gk);
    tr.querySelectorAll("input.q").forEach(inp => {
      inp.oninput = () => {
        const v = inp.value.replace(/[^\d]/g, ""); if (v !== inp.value) inp.value = v;
        const sku = inp.dataset.sku, n = parseInt(v || "0", 10);
        if (n > 0) { const pv = grpPrice(g); ORD.lines[sku] = { qty: n, price: ORD.lines[sku] ? ORD.lines[sku].price : (pv || ORD.gp[gk] || 0) }; }
        else delete ORD.lines[sku];
        inp.parentElement.classList.toggle("has", n > 0); updRow(tr, g); saveLocal();
      };
      inp.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); const all = [...document.querySelectorAll("#olines input.q")], i = all.indexOf(inp); if (all[i + 1]) all[i + 1].focus(); else document.getElementById("ps").focus(); } };
    });
    const pr = tr.querySelector("input.pr");
    pr.oninput = () => { const v = num(pr.value); ORD.gp[gk] = isNaN(v) ? 0 : v; g.skus.forEach(s => { if (ORD.lines[s.code]) ORD.lines[s.code].price = ORD.gp[gk]; }); pr.classList.remove("miss"); pr.placeholder = "0"; updRow(tr, g); saveLocal(); };
    tr.querySelector(".rm").onclick = () => {
      const [q] = grpTot(g); if (q && !confirm("Remove " + g.name + (g.col ? " (" + g.col + ")" : "") + " from the order?")) return;
      g.skus.forEach(s => delete ORD.lines[s.code]); ORD.groups = ORD.groups.filter(x => x !== gk); delete ORD.gp[gk]; saveLocal(); drawLines();
    };
  });
  updTot();
}
/* the product search sits above the table while empty, then moves below it as the "+ Add product" row */
function placeSearch() {
  const box = document.querySelector(".psearch"), slot = document.getElementById("paddslot"), lines = document.getElementById("olines"); if (!box || !slot) return;
  const has = ORD.groups.length > 0, inp = box.querySelector("#ps");
  if (has && box.parentElement !== slot) slot.appendChild(box); else if (!has && box.parentElement === slot) lines.parentElement.insertBefore(box, document.getElementById("obad"));
  box.classList.toggle("padd", has);
  inp.placeholder = has ? "+ Add another product — search style, colour or SKU and press Enter…" : "Search product, style, colour or SKU and press Enter…";
}
function updRow(tr, g) { const [q, v] = grpTot(g); tr.querySelector(".gq").textContent = units(q); tr.querySelector(".gv").textContent = money(v); updTot(); }
function updTot() {
  const el = document.getElementById("otot"); if (!el) return;
  let q = 0, v = 0, n = 0; Object.values(ORD.lines).forEach(l => { q += l.qty; v += l.qty * (l.price || 0); n++; });
  el.innerHTML = `<b class="tnum">${units(q)}</b> units &#183; <b class="tnum">${money(v)}</b> <span class="mut">&#183; ${ORD.groups.length} product${ORD.groups.length === 1 ? "" : "s"}, ${n} SKU${n === 1 ? "" : "s"}${ORD.bad.length ? ` &#183; <b class="wtxt">${ORD.bad.length} row${ORD.bad.length === 1 ? "" : "s"} need attention</b>` : ""}</span>`;
}
function addLine(code, qty, price) {
  const it = ITEM[code.toUpperCase()]; if (!it) return "SKU not found in the item master";
  const cur = ORD.lines[it.code];
  if (cur && price && cur.price && Math.abs(cur.price - price) > 0.001) return `Already in the order at ₹${cur.price} — different price`;
  ORD.lines[it.code] = { qty: (cur ? cur.qty : 0) + qty, price: price || (cur && cur.price) || ORD.gp[it.gk] || 0 };
  if (!ORD.groups.includes(it.gk)) ORD.groups.push(it.gk);
  return null;
}

/* rows needing attention (unknown SKUs etc.) */
function drawBad() {
  const el = document.getElementById("obad"); if (!el) return;
  if (!ORD.bad.length) { el.innerHTML = ""; updTot(); return; }
  el.innerHTML = `<div class="badbox"><div class="bh"><b>${ORD.bad.length} row${ORD.bad.length === 1 ? "" : "s"} need attention</b><span class="mut">Fix the SKU and press Apply, or remove the row. The order can't be submitted until these are cleared.</span><button class="lnk" data-clrbad>Remove all</button></div>
   <table class="ltbl"><thead><tr><th>SKU</th><th class="num">Qty</th><th class="num">Price</th><th>Problem</th><th></th></tr></thead><tbody>
   ${ORD.bad.map((b, i) => `<tr data-b="${i}"><td><input class="bs" value="${attr(b.sku)}"></td><td class="num"><input class="bq" value="${attr(b.qty)}" inputmode="numeric"></td><td class="num"><input class="bp" value="${attr(b.price)}" inputmode="decimal"></td><td class="wtxt">${esc(b.why)}</td><td style="white-space:nowrap"><button class="btn sm" data-ap>Apply</button> <button class="rm" data-rmb>&times;</button></td></tr>`).join("")}
   </tbody></table></div>`;
  el.querySelector("[data-clrbad]").onclick = () => { ORD.bad = []; saveLocal(); drawBad(); };
  el.querySelectorAll("tr[data-b]").forEach(tr => {
    const i = +tr.dataset.b;
    tr.querySelector("[data-rmb]").onclick = () => { ORD.bad.splice(i, 1); saveLocal(); drawBad(); };
    tr.querySelector("[data-ap]").onclick = () => {
      const sku = tr.querySelector(".bs").value.trim().toUpperCase(), q = num(tr.querySelector(".bq").value), p = num(tr.querySelector(".bp").value);
      let why = null;
      if (!(q > 0) || q !== Math.round(q)) why = "Quantity must be a whole number above 0";
      else why = addLine(sku, q, p > 0 ? p : 0);
      if (why) { ORD.bad[i] = { sku, qty: tr.querySelector(".bq").value, price: tr.querySelector(".bp").value, why }; }
      else ORD.bad.splice(i, 1);
      saveLocal(); drawBad(); drawLines();
    };
  });
  updTot();
}

/* Excel template + upload */
function downloadTemplate() {
  if (!window.XLSX) { toast("Excel library didn't load — check your connection", "err"); return; }
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([["SKU Code", "Quantity", "Price per unit (incl. GST)"]]);
  ws["!cols"] = [{ wch: 18 }, { wch: 10 }, { wch: 24 }];
  XLSX.utils.book_append_sheet(wb, ws, "Order");
  const how = XLSX.utils.aoa_to_sheet([
    ["How to fill this order template"], [""],
    ["1. One row per SKU (each size is its own SKU). Use the 'Catalogue' sheet to find SKU codes."],
    ["2. Quantity = whole number of units. Price = per unit, INCLUDING GST."],
    ["3. Keep the column headers on the 'Order' sheet as they are."],
    ["4. In the app: New order > pick the dealer > Upload Excel. Unknown SKUs are flagged for you to fix."],
  ]); how["!cols"] = [{ wch: 100 }];
  XLSX.utils.book_append_sheet(wb, how, "How to fill");
  const cat = [["SKU Code", "Product", "Colour", "Size", "Style", "Category"]];
  GLIST.forEach(g => g.skus.forEach(s => cat.push([s.code, g.name, g.col, s.size, g.style, g.grp])));
  const cws = XLSX.utils.aoa_to_sheet(cat); cws["!cols"] = [{ wch: 18 }, { wch: 30 }, { wch: 28 }, { wch: 8 }, { wch: 12 }, { wch: 16 }];
  XLSX.utils.book_append_sheet(wb, cws, "Catalogue");
  XLSX.writeFile(wb, "TenXYou_Order_Template.xlsx");
}
async function importFile(file) {
  if (!window.XLSX) { toast("Excel library didn't load — check your connection", "err"); return; }
  let rows;
  try {
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const ws = wb.Sheets["Order"] || wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: true });
  } catch (e) { toast("Couldn't read that file: " + e.message, "err"); return; }
  const hi = rows.findIndex(r => r.some(c => /sku|variant/i.test(String(c))));
  if (hi < 0) { toast("Couldn't find a 'SKU Code' column — please use the Excel template", "err"); return; }
  const h = rows[hi].map(c => String(c).toLowerCase());
  const ci = h.findIndex(c => /sku|variant/.test(c)), qi = h.findIndex(c => /qty|quantity/.test(c)), pi = h.findIndex(c => /price|rate/.test(c));
  if (qi < 0) { toast("Couldn't find a 'Quantity' column — please use the Excel template", "err"); return; }
  let ok = 0, bad = 0;
  rows.slice(hi + 1).forEach(r => {
    const sku = String(r[ci] == null ? "" : r[ci]).trim().toUpperCase(); if (!sku) return;
    const q = num(r[qi]), p = pi >= 0 ? num(r[pi]) : NaN;
    let why = null;
    if (!(q > 0) || q !== Math.round(q)) why = "Quantity must be a whole number above 0";
    else if (!(p > 0)) why = ITEM[sku] ? "Price missing" : "SKU not found in the item master";
    else why = addLine(sku, q, p);
    if (why) { ORD.bad.push({ sku, qty: r[qi], price: pi >= 0 ? r[pi] : "", why }); bad++; } else ok++;
  });
  saveLocal(); drawBad(); drawLines();
  toast(`Imported ${ok} line${ok === 1 ? "" : "s"}` + (bad ? ` · ${bad} need attention` : ""), bad ? "warn" : "ok");
}

let saving = false;
async function saveOrder(action, confirmed) {
  if (!ORD || saving) return;
  const d = dealerById(ORD.dealer_id);
  if (!d) { toast("Pick a dealer first", "err"); document.getElementById("dbtn").focus(); return; }
  const lines = Object.entries(ORD.lines).filter(([, l]) => l.qty > 0).map(([sku, l]) => ({ sku, qty: l.qty, price: l.price }));
  if (action === "submit") {
    if (ORD.bad.length) { toast("Clear the rows that need attention first", "err"); document.getElementById("obad").scrollIntoView({ block: "center" }); return; }
    if (!lines.length) { toast("Add at least one size with a quantity", "err"); return; }
    let miss = 0;
    document.querySelectorAll("#olines tr[data-g]").forEach(tr => { const g = groupOf(tr.dataset.g); if (g.skus.some(s => ORD.lines[s.code] && !(ORD.lines[s.code].price > 0))) { tr.querySelector("input.pr").classList.add("miss"); miss++; } });
    if (miss) { toast(`Enter the price for ${miss} product${miss === 1 ? "" : "s"}`, "err"); document.querySelector("#olines input.pr.miss").focus(); return; }
    if (!ordDealer().complete) { toast("Add the dealer's mobile and address before submitting", "err"); editOrdDealer(); return; }
    if (!confirmed) { submitSummary(() => saveOrder("submit", true)); return; }
  }
  closeModal();
  const btns = document.querySelectorAll(".savebar .btn"); btns.forEach(b => b.disabled = true); saving = true;
  try {
    const r = await B.api("order_save", { id: ORD.id, dealer_id: ORD.dealer_id, dealer_ov: ORD.dealer_ov, ship_sel: ORD.ship_sel, po_ref: ORD.po_ref, remarks: ORD.remarks, lines, action });
    const wasEdit = !!ORD.id; clearLocal(); ORD = null; ORDERS = null;
    toast(action === "submit" ? `${r.ref} ${wasEdit ? "updated" : "submitted to billing"}` : `${r.ref} saved as draft`, "ok");
    show("b-orders");
  } catch (e) {
    if (e.data && e.data.unknown) {
      e.data.unknown.forEach(s => { const l = ORD.lines[s]; delete ORD.lines[s]; ORD.bad.push({ sku: s, qty: l ? l.qty : "", price: l ? l.price : "", why: "SKU not found in the item master" }); });
      saveLocal(); drawBad(); drawLines();
    }
    toast(e.message, "err");
  } finally { saving = false; btns.forEach(b => b.disabled = false); }
}
/* the review call-out shown before an order is placed */
function submitSummary(go) {
  const d = ordDealer(), rows = [];
  ORD.groups.forEach(gk => { const g = groupOf(gk), sz = g.skus.filter(x => ORD.lines[x.code] && ORD.lines[x.code].qty > 0); if (!sz.length) return; const [q, v] = grpTot(g); rows.push({ g, sz, q, v, p: grpPrice(g) }); });
  const Q = rows.reduce((t, r) => t + r.q, 0), V = rows.reduce((t, r) => t + r.v, 0), N = rows.reduce((t, r) => t + r.sz.length, 0);
  const ship = d.ship_same ? "Same as billing address" : [d.ship_label, addrText(d, "ship")].filter(Boolean).join(" · ");
  const m = modal(`<div class="mh"><h3>Review your order before placing it</h3><button data-close>&times;</button></div>
   <div class="mbody">
    <div class="meta3"><div class="kv"><span>Dealer</span><b>${esc(d.name)}${d.is_intl ? " &#183; International" : ""}</b></div><div class="kv" style="grid-column:span 2"><span>Ship to</span><b style="font-weight:500">${esc(ship || "—")}</b></div></div>
    <div class="prog"><div><span>Products</span><b class="tnum">${rows.length}</b></div><div><span>SKUs</span><b class="tnum">${N}</b></div><div><span>Units</span><b class="tnum">${units(Q)}</b></div><div style="flex:1.6"><span>Order value &#183; incl. GST</span><b class="tnum">${money(V)}</b></div></div>
    <h4>Product summary</h4>
    <div class="scroll"><table class="ltbl"><thead><tr><th>Product</th><th>Sizes &#215; quantity</th><th class="num">Units</th><th class="num">Price / unit</th><th class="num">Value</th><th class="num">Share</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td class="pcell"><b>${esc(r.g.name)}</b><div class="mut">${esc([r.g.col, r.g.style].filter(Boolean).join(" · "))}</div></td><td class="wrapc"><div class="szsum">${r.sz.map(x => `<span><b>${esc(x.size)}</b> &#215; ${units(ORD.lines[x.code].qty)}</span>`).join("")}</div></td><td class="num tnum">${units(r.q)}</td><td class="num tnum">${r.p === null ? '<span class="mut">mixed</span>' : money(r.p)}</td><td class="num tnum">${money(r.v)}</td><td class="num tnum mut">${V ? (r.v / V * 100).toFixed(0) : 0}%</td></tr>`).join("")}
    </tbody><tfoot><tr><td>Total</td><td class="mut" style="font-weight:500">${rows.length} product${rows.length === 1 ? "" : "s"} &#183; ${N} SKU${N === 1 ? "" : "s"}</td><td class="num tnum">${units(Q)}</td><td></td><td class="num tnum">${money(V)}</td><td></td></tr></tfoot></table></div>
    <div class="lockbox"><span class="lk">&#128274;</span><div><b>Once placed, this order can only be changed or cancelled by the backend team.</b><br><span class="mut">Check the dealer, sizes, quantities and prices now${isBE() ? "." : " &#8212; after you place it, any change has to go through the backend team."}</span></div></div>
   </div>
   <div class="mf"><span></span><div class="hbtns"><button class="btn ghost" data-close>&#8592; Back to edit</button><button class="btn primary" id="sum-go">Confirm &amp; place order &#8594;</button></div></div>`, { wide: true });
  m.querySelector("#sum-go").onclick = e => { e.target.disabled = true; go(); };
}
function editOrder(o) {
  ORD = blankOrd(); Object.assign(ORD, { id: o.id, ref: o.ref, status: o.status, sheet_at: o.sheet_at || null, billed: o.tot.bq + (o.tot.eq || 0), dealer_id: o.dealer_id, dealer_ov: o.dealer_ov || null, ship_sel: o.ship_sel || null, po_ref: o.po_ref || "", remarks: o.remarks || "" });
  o.lines.forEach(l => { const it = item(l.sku); ORD.lines[it.code] = { qty: l.qty, price: l.price }; if (!ORD.groups.includes(it.gk)) ORD.groups.push(it.gk); });
  closeModal(); show("b-new");
}

/* =================================================================== ORDERS (tracker + desk) */
const OV = { "b-orders": { f: "all", q: "", team: "", dealer: "", sel: new Set(), pm: "MTD" }, "b-desk": { f: "all", q: "", team: "", dealer: "", sel: new Set(), pm: "YTD" },
  "b-score": { f: "all", q: "", team: "", dealer: "", sel: new Set(), pm: "MTD" } };
async function renderOrders(id) {
  const host = document.getElementById(id);
  if (!ORDERS || Date.now() - OAT > 60000) {
    if (!ORDERS) host.innerHTML = loading("Loading orders…");
    try { await Promise.all([ensureOrders(), loadPrefs()]); } catch (e) { host.innerHTML = errCard(e.message); return; }
    if (tab !== id) return;
  }
  await loadPrefs(); if (tab !== id) return;
  B.loadItems().catch(() => {});
  drawOrders(id);
}
/* period: MTD / YTD (financial year from 1 April) / custom — on the order date */
const todayStr = () => (typeof TODAY !== "undefined" && TODAY) || new Date().toISOString().slice(0, 10);
const fyStart = t => (+t.slice(5, 7) >= 4 ? +t.slice(0, 4) : +t.slice(0, 4) - 1) + "-04-01";
function oRange(st) { const t = todayStr(); if (st.pm === "MTD") return [t.slice(0, 7) + "-01", t]; if (st.pm === "YTD") return [fyStart(t), t]; return [st.pf || fyStart(t), st.pt || t]; }
const oday = o => String(o.submitted_at || o.created_at || "").slice(0, 10);
function orderFilters(desk) {
  const f = [["all", "All", o => true]];
  if (!isBE()) f.push(["draft", "Draft", o => o.stage === "draft"]);
  f.push(["tobill", "To bill", o => CAT(o) === "tobill"], ["partial", "Partially billed", o => CAT(o) === "partial"], ["closed", "Closed", o => CAT(o) === "closed"], ["cancelled", "Cancelled", o => CAT(o) === "cancelled"]);
  return f;
}
function visibleOrders(id, noDealer) {
  const st = OV[id];
  let list = ORDERS.filter(o => !(seeAll() && o.stage === "draft"));
  { const [f, t] = oRange(st); list = list.filter(o => oday(o) >= f && oday(o) <= t); }
  if (st.team) list = list.filter(o => String(o.team_id || "none") === st.team);
  if (!noDealer && st.dealer) list = list.filter(o => String(o.dealer_id) === st.dealer);
  if (st.q) { const q = st.q.toLowerCase(); list = list.filter(o => [o.ref, o.dealer, o.po_ref, o.team, o.links.map(l => l.no).join(" ")].join(" ").toLowerCase().includes(q)); }
  return list;
}
/* why an order was cancelled: stored on the order (older ones: from the activity log) */
const cancelWhy = o => o.cancel_reason || ((o.events || []).slice().reverse().map(e => /^Order cancelled[^:]*: (.+)$/.exec(e.what || "")).find(Boolean) || [])[1] || "";
const statusCell = o => `${stagePill(o.stage)}${o.stage === "cancelled" ? (cancelWhy(o) ? `<div class="mut">${esc(cancelWhy(o))}</div>` : "") : STN[o.stage] ? `<div class="mut">${o.stage === "closed" && o.close_reason ? "short-closed: " + esc(o.close_reason) : STN[o.stage]}</div>` : ""}`;
function orderKpis(base) {
  const sum = (arr, k) => arr.reduce((s, o) => s + (o.tot[k] || 0), 0), n = (x, w) => x + " " + w + (x === 1 ? "" : "s");
  const placed = base.filter(o => o.stage !== "draft"), canc = placed.filter(o => o.stage === "cancelled");
  const billed = placed.filter(o => o.tot.bq > 0), full = placed.filter(o => o.stage === "billed"), pend = placed.filter(o => o.tot.pq > 0), part = pend.filter(o => o.tot.bq > 0);
  const short = placed.filter(o => o.stage === "closed");
  const P = sum(placed, "ov"), Bv = sum(placed, "bvo"), Ev = sum(placed, "ev"), Eq = sum(placed, "eq"), Pv = sum(placed, "pv"), Cv = sum(placed, "cv"), den = P - sum(canc, "cv");
  const fill = den > 0 ? Bv / den * 100 : 0;
  const tiles = [
    { l: "Orders placed", big: lakh(P), sub: `${n(placed.length, "order")} &#183; ${units(sum(placed, "oq"))} units`, c: "hero" },
    { l: "Billed", big: lakh(Bv + Ev), sub: `${n(billed.length, "order")} (${full.length} fully) &#183; ${units(sum(placed, "bq") + Eq)} units${Eq ? ` (${units(Eq)} extra*)` : ""}` },
    { l: "Pending to bill", big: lakh(Pv), sub: `${n(pend.length, "order")} (${part.length} partially billed) &#183; ${units(sum(placed, "pq"))} units` },
    { l: "Cancelled / closed", big: lakh(Cv), sub: `${canc.length} cancelled &#183; ${short.length} short-closed &#183; ${units(sum(placed, "cq"))} units` },
    { l: "Fill rate (value)", big: fill.toFixed(0) + "%", sub: "billed &#247; (placed &#8722; cancelled)" }];
  return `<div class="kpis k5">${tiles.map(k => `<div class="kpi ${k.c || ""}"><div class="lab">${k.l}</div><div class="big tnum">${k.big}</div><div class="sub tnum">${k.sub}</div></div>`).join("")}</div>
   <div class="recon tnum">Placed ${money(P)} = Billed against order ${money(Bv)} + Pending ${money(Pv)} + Cancelled / closed ${money(Cv)} &#183; values at the order price${Ev ? ` &#183; plus ${money(Ev)} billed as extra*` : ""}</div>${Eq ? `<div class="recon">* Extra = units billed in ERP that were not in the original order (substitutions or add-ons).</div>` : ""}`;
}
function periodBar(st) {
  const [f, t] = oRange(st);
  return `<div class="periodbar obar"><span class="lbl">Period</span><div class="seg" data-per>${["MTD", "YTD", "custom"].map(m => `<button data-pm="${m}" class="${st.pm === m ? "on" : ""}">${m === "custom" ? "Custom" : m}</button>`).join("")}</div>
   ${st.pm === "custom" ? `<span class="dates"><input type="date" data-pf value="${f}"> <span>to</span> <input type="date" data-pt value="${t}" max="${todayStr()}"></span>` : ""}<span class="range-note">${shortDate(f)} &#8211; ${shortDate(t)}${st.pm === "YTD" ? " &#183; financial year" : ""} &#183; by order date</span></div>`;
}
function wirePeriod(host, st, redraw) {
  host.querySelectorAll("[data-pm]").forEach(b => b.onclick = () => { if (b.dataset.pm === "custom" && st.pm !== "custom") { const [f, t] = oRange(st); st.pf = f; st.pt = t; } st.pm = b.dataset.pm; st.lim = 0; redraw(); });
  const pf = host.querySelector("[data-pf]"), pt = host.querySelector("[data-pt]");
  if (pf) pf.onchange = () => { st.pf = pf.value; redraw(); };
  if (pt) pt.onchange = () => { st.pt = pt.value; redraw(); };
}
/* searchable dealer filter (dealers with orders in the current period / team view) */
function dealerPick(st, base0) {
  const m = new Map(); base0.forEach(o => { const e = m.get(o.dealer_id) || { id: o.dealer_id, name: o.dealer, n: 0 }; e.n++; m.set(o.dealer_id, e); });
  let cur = null; if (st.dealer) { cur = m.get(+st.dealer); if (!cur) { cur = { id: +st.dealer, name: (dealerById(+st.dealer) || {}).name || "Dealer", n: 0 }; m.set(cur.id, cur); } }
  const list = [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { list, html: `<div class="ms fpick"><button class="msbtn ${cur ? "set" : ""}" data-dfbtn title="Filter by dealer"><span class="lbl">${cur ? esc(cur.name) : "All dealers"}</span><span class="car">&#9662;</span></button><div class="msmenu" hidden><input type="search" data-dfq placeholder="Search ${list.length} dealer${list.length === 1 ? "" : "s"}&#8230;"><div class="msopts" data-dfo></div></div></div>` };
}
function wireDealerPick(host, st, list, redraw) {
  const b = host.querySelector("[data-dfbtn]"); if (!b) return;
  const menu = b.nextElementSibling, q = menu.querySelector("[data-dfq]"), opts = menu.querySelector("[data-dfo]");
  const paint = () => {
    const s = q.value.toLowerCase(), f = list.filter(d => d.name.toLowerCase().includes(s));
    opts.innerHTML = (s ? "" : `<div class="dopt ${st.dealer ? "" : "on"}" data-dv=""><b>All dealers</b><span>${list.length} with orders in this view</span></div>`) + (f.map(d => `<div class="dopt ${String(d.id) === st.dealer ? "on" : ""}" data-dv="${d.id}"><b>${esc(d.name)}</b><span>${d.n} order${d.n === 1 ? "" : "s"}</span></div>`).join("") || '<div class="tblnote" style="padding:10px">No match.</div>');
    opts.querySelectorAll("[data-dv]").forEach(o => o.onclick = () => { st.dealer = o.dataset.dv; st.lim = 0; redraw(); });
  };
  b.onclick = e => { e.stopPropagation(); const h = menu.hidden; document.querySelectorAll(".msmenu").forEach(x => x.hidden = true); menu.hidden = !h; if (!menu.hidden) { q.value = ""; paint(); q.focus(); } };
  menu.onclick = e => e.stopPropagation(); q.oninput = paint;
  q.onkeydown = e => { if (e.key === "Enter") { const first = opts.querySelector("[data-dv]"); if (first) first.click(); } };
}
const STAGE_ORD = { draft: 0, tobill: 1, sheet: 1, linked: 1, partial: 2, billed: 3, closed: 3, cancelled: 4 };
const dCity = o => { const d = dealerById(o.dealer_id); return d ? d.bill_city || "" : ""; };
function orderCols(desk, st, allSel) {
  const sum = (L, k) => L.reduce((t, o) => t + (o.tot[k] || 0), 0), pctOf = o => o.tot.ov ? Math.min(100, o.tot.bvo / o.tot.ov * 100) : 0;
  const qv = (q, v, cls) => `<span class="${cls || ""}">${units(q)}</span><div class="mut">${money(v)}</div>`;
  const bqv = (q, e, v) => `${units(q + e)}${e ? ` <span class="wtxt" title="Units billed in ERP that were not in the original order">(${units(e)} extra*)</span>` : ""}<div class="mut">${money(v)}</div>`;
  const c = [];
  if (desk) c.push({ k: "ck", fixed: true, w: 42, tc: "ck", h: `<input type="checkbox" data-all ${allSel.length && allSel.every(o => st.sel.has(o.id)) ? "checked" : ""} ${allSel.length ? "" : "disabled"} title="Select all without a billing sheet">`, td: o => `<input type="checkbox" data-sel="${o.id}" ${st.sel.has(o.id) ? "checked" : ""} ${o.stage === "tobill" ? "" : "disabled"}>` });
  c.push(
    { k: "ref", h: "Order", w: 124, sv: o => o.id, td: o => `<b>${esc(o.ref)}</b>`, ft: L => `Total <span class="mut" style="font-weight:500">&#183; ${L.length}</span>` },
    { k: "date", h: "Date", w: 92, tc: "tnum", sv: oday, td: o => dShort(o.submitted_at || o.created_at) },
    { k: "dealer", h: "Dealer", w: 230, tc: "wrapc", sv: o => o.dealer.toLowerCase(), td: o => `${esc(o.dealer)}${o.dealer_complete ? "" : ' <span class="pill untagged">details missing</span>'}` },
    { k: "city", h: "City", label: "Dealer city", hide: true, w: 120, sv: o => dCity(o).toLowerCase(), td: o => esc(dCity(o)) },
    { k: "team", h: "Team member", w: 150, sv: o => o.team || "~", td: o => o.team ? `<span class="pill tagged"><span class="sw" style="background:${attr(teamCol(o.team_id))}"></span>${esc(o.team)}</span>` : '<span class="pill untagged">Untagged</span>' },
    { k: "ord", h: "Ordered", num: true, w: 110, sv: o => o.tot.ov, td: o => qv(o.tot.oq, o.tot.ov), ft: L => qv(sum(L, "oq"), sum(L, "ov")) },
    { k: "bil", h: "Billed", num: true, w: 130, sv: o => o.tot.bvo + (o.tot.ev || 0), td: o => bqv(o.tot.bq, o.tot.eq || 0, o.tot.bvo + (o.tot.ev || 0)), ft: L => bqv(sum(L, "bq"), sum(L, "eq"), sum(L, "bvo") + sum(L, "ev")) },
    { k: "pen", h: "Pending", num: true, w: 110, sv: o => o.tot.pv, td: o => qv(o.tot.pq, o.tot.pv, o.tot.pq ? "wtxt" : ""), ft: L => qv(sum(L, "pq"), sum(L, "pv")) },
    { k: "cxl", h: "Cancelled / closed", num: true, hide: true, w: 140, sv: o => o.tot.cv, td: o => qv(o.tot.cq, o.tot.cv), ft: L => qv(sum(L, "cq"), sum(L, "cv")) },
    { k: "fill", h: "Fill", w: 112, sv: pctOf, td: o => { const pct = pctOf(o), t = o.tot; return `<div class="fill"><span style="width:${pct}%"></span></div><div class="mut tnum">${pct.toFixed(0)}%</div>`; } },
    { k: "status", h: "Status", w: 190, tc: "wrapc", sv: o => STAGE_ORD[o.stage], td: statusCell },
    { k: "erp", h: "ERP order IDs", w: 140, tc: "tnum wrapc", sv: o => o.links.map(l => l.no).join(" "), td: o => o.links.map(l => `<span class="erpid ${l.found === false || l.cancelled ? "bad" : ""}">${esc(l.no)}</span>`).join(" ") || '<span class="mut">&#8212;</span>' },
    { k: "by", h: "Entered by", hide: true, w: 120, sv: o => o.created_by || "", td: o => esc(o.created_by || "") },
    { k: "sheet", h: "Billing sheet", hide: true, w: 110, sv: o => o.sheet_at || "", td: o => o.sheet_at ? dShort(o.sheet_at) : '<span class="mut">&#8212;</span>' });
  if (desk) c.push({ k: "act", fixed: true, w: 128, h: "", tc: "acts", td: o => o.stage === "tobill" ? `<button class="btn sm" data-sheet="${o.id}">Billing sheet</button>` : ACTION.includes(o.stage) ? `<button class="btn sm" data-link="${o.id}">+ ERP ID</button>` : "" });
  return c;
}
let qT = 0;
function drawOrders(id) {
  const host = document.getElementById(id), st = OV[id], desk = id === "b-desk";
  const base0 = visibleOrders(id, true), base = st.dealer ? base0.filter(o => String(o.dealer_id) === st.dealer) : base0;
  const filters = orderFilters(desk), fdef = filters.find(f => f[0] === st.f) || filters[0];
  const teams = BOOT.team.filter(t => t.active);
  const selectable = o => desk && o.stage === "tobill";
  [...st.sel].forEach(i => { const o = ORDERS.find(x => x.id === i); if (!o || !selectable(o)) st.sel.delete(i); });
  const gid = desk ? "desk" : "orders", list0 = base.filter(fdef[2]), allSel = list0.filter(selectable);
  const cols = orderCols(desk, st, allSel), list = gSort(gid, cols, list0), shown = list.slice(0, st.lim || 300);
  const dp = dealerPick(st, base0);
  const title = desk ? "Billing desk" : isBE() ? "All orders" : isMgr() ? "Team orders" : "My orders";
  host.innerHTML = `
   <div class="ohead"><div><h2>${title}</h2><div class="mut">${desk ? "Select orders &#8594; create the billing sheet &#8594; upload it to ERP &#8594; enter the ERP order ID here. Tick orders marked <b>To bill</b> to create their sheet." : isMgr() ? "Every order the team has placed &#8212; ordered vs billed vs pending, live from ERP. View only." : "Ordered vs billed vs pending for every order, live from ERP."}</div></div>
    <div class="hbtns">${!desk && !isMgr() ? '<button class="btn primary sm" data-new>+ New order</button>' : ""}</div></div>
   ${periodBar(st)}
   ${orderKpis(base)}
   <div class="card"><div class="toolbar">
     <div class="seg fseg">${filters.map(f => { const n = base.filter(f[2]).length; return `<button data-f="${f[0]}" class="${f[0] === fdef[0] ? "on" : ""}">${f[1]}<span class="fc">${n}</span></button>`; }).join("")}</div>
     ${seeAll() ? `<select data-team><option value="">All team members</option>${teams.map(t => `<option value="${t.id}" ${st.team === String(t.id) ? "selected" : ""}>${esc(t.name)}</option>`).join("")}<option value="none" ${st.team === "none" ? "selected" : ""}>&#8212; Untagged</option></select>` : ""}
     ${dp.html}
     <input type="search" class="tsearch" data-q placeholder="Search order, dealer, ERP ID…" value="${attr(st.q)}">
     <div class="spacer"></div>${gPicker(gid, cols)}<button class="xbtn" data-x="csv">Export CSV</button><button class="xbtn" data-x="xls">Export XLS</button><button class="xbtn" data-x="lines" title="One row per SKU with ordered / billed / pending">Export SKU lines</button></div>
   <div class="scroll">${gTable(gid, cols, shown, { cls: "otbl", tr: o => `class="orow" data-o="${o.id}"`, foot: list,
      empty: base.length ? "No orders in this view." : desk ? "No orders in this period." : ORDERS.length ? "No orders in this period &#8212; try YTD or a custom range." : "No orders yet &#8212; create your first one.",
      more: n => list.length > shown.length ? `<tr><td colspan="${n}" style="text-align:center;padding:12px"><button class="btn ghost sm" data-more>Show ${Math.min(300, list.length - shown.length)} more of ${list.length - shown.length}</button></td></tr>` : "" })}</div>
   <div class="tblnote">Billed = quantity on the linked ERP Sales Orders (cancelled ones ignored), valued at the order price; units billed outside the original order are added and shown in brackets as extra* (valued at the ERP rate). Fill rate counts only what was ordered. Pending = ordered &#8722; billed until the order is fully billed, short-closed or cancelled. Closed = fully billed or pending short-closed.<br><b>* Extra = units billed in ERP that were not in the original order (substitutions or add-ons).</b></div></div>
   ${desk && st.sel.size ? `<div class="bulkbar"><b>${st.sel.size} order${st.sel.size === 1 ? "" : "s"} selected</b><span class="mut">${money([...st.sel].reduce((t, i) => t + ORDERS.find(o => o.id === i).tot.ov, 0))}</span><div class="spacer"></div><button class="btn ghost sm" data-clrsel>Clear</button><button class="btn primary" data-bulk>Create billing sheet &#8594;</button></div>` : ""}`;
  const redraw = () => drawOrders(id);
  host.querySelectorAll("[data-f]").forEach(b => b.onclick = () => { st.f = b.dataset.f; st.lim = 0; redraw(); });
  wirePeriod(host, st, redraw);
  wireDealerPick(host, st, dp.list, redraw);
  gWire(host, gid, cols, redraw);
  const tsel = host.querySelector("[data-team]"); if (tsel) tsel.onchange = () => { st.team = tsel.value; st.lim = 0; redraw(); };
  const q = host.querySelector("[data-q]"); q.oninput = () => { st.q = q.value; clearTimeout(qT); qT = setTimeout(() => { const p = q.selectionStart; redraw(); const n = document.querySelector(`#${id} [data-q]`); n.focus(); n.setSelectionRange(p, p); }, 180); };
  const nb = host.querySelector("[data-new]"); if (nb) nb.onclick = () => { if (ORD && ORD.id) ORD = null; show("b-new"); };
  host.querySelectorAll("[data-x]").forEach(b => b.onclick = () => exportOrders(list, b.dataset.x, desk ? "Billing desk" : "Orders"));
  host.querySelectorAll("tr.orow").forEach(tr => tr.onclick = e => { if (e.target.closest("input,button")) return; openOrder(+tr.dataset.o); });
  const more = host.querySelector("[data-more]"); if (more) more.onclick = () => { st.lim = (st.lim || 300) + 300; redraw(); };
  host.querySelectorAll("[data-sel]").forEach(c => c.onchange = () => { const i = +c.dataset.sel; if (c.checked) st.sel.add(i); else st.sel.delete(i); redraw(); });
  const all = host.querySelector("[data-all]"); if (all) all.onchange = () => { allSel.forEach(o => all.checked ? st.sel.add(o.id) : st.sel.delete(o.id)); redraw(); };
  host.querySelectorAll("[data-sheet]").forEach(b => b.onclick = () => openSheet([+b.dataset.sheet]));
  host.querySelectorAll("[data-link]").forEach(b => b.onclick = () => openLink(+b.dataset.link));
  const bulk = host.querySelector("[data-bulk]"); if (bulk) bulk.onclick = () => openSheet([...st.sel]);
  const cs = host.querySelector("[data-clrsel]"); if (cs) cs.onclick = () => { st.sel.clear(); redraw(); };
}

/* =================================================================== THE DUGOUT — team scoreboard (view only) */
async function renderScore() {
  const host = document.getElementById("b-score");
  if (!ORDERS || Date.now() - OAT > 60000) {
    if (!ORDERS) host.innerHTML = loading("Loading the team's orders…");
    try { await Promise.all([ensureOrders(), loadPrefs()]); } catch (e) { host.innerHTML = errCard(e.message); return; }
    if (tab !== "b-score") return;
  }
  await loadPrefs(); if (tab !== "b-score") return;
  drawScore();
}
function drawScore() {
  const host = document.getElementById("b-score"), st = OV["b-score"];
  const base0 = visibleOrders("b-score", true), base = st.dealer ? base0.filter(o => String(o.dealer_id) === st.dealer) : base0;
  const placed = base.filter(o => o.stage !== "draft"), sum = (arr, k) => arr.reduce((t, o) => t + (o.tot[k] || 0), 0);
  const act = BOOT.team.filter(t => t.active);
  const rows = act.map(t => ({ t, id: String(t.id), name: t.name, os: placed.filter(o => o.team_id === t.id) }));
  const un = placed.filter(o => !act.some(t => t.id === o.team_id)); if (un.length) rows.push({ t: null, id: "none", name: "Untagged", os: un });
  rows.forEach(r => {
    const os = r.os, canc = os.filter(o => o.stage === "cancelled"), live = os.length - canc.length;
    Object.assign(r, { n: os.length, nc: canc.length, P: sum(os, "ov"), Bo: sum(os, "bvo"), E: sum(os, "ev"), eq: sum(os, "eq"), Pe: sum(os, "pv"), C: sum(os, "cv"), q: sum(os, "oq"), bq: sum(os, "bq") + sum(os, "eq"),
      ad: new Set(os.map(o => o.dealer_id)).size, dl: r.t ? BOOT.dealers.filter(d => d.team_id === r.t.id && !d.excluded).length : 0,
      last: os.reduce((m, o) => oday(o) > m ? oday(o) : m, "") });
    r.B = r.Bo + r.E; const den = r.P - sum(canc, "cv"); r.fill = den > 0 ? r.Bo / den * 100 : 0; r.aov = live ? (r.P - sum(canc, "ov")) / live : 0;
  });
  const ranked = rows.filter(r => r.t).sort((a, b) => b.B - a.B || b.P - a.P), pre = ranked.concat(rows.filter(r => !r.t));
  const rankOf = r => r.t ? ranked.indexOf(r) + 1 : 999, medal = ["&#129351;", "&#129352;", "&#129353;"];
  const T = k => rows.reduce((t, r) => t + r[k], 0);
  const bar = r => { const d = Math.max(r.P, r.B + r.Pe + r.C) || 1; return `<div class="mix" title="Billed ${money(r.B)} · Pending ${money(r.Pe)} · Cancelled / closed ${money(r.C)}"><span class="b" style="width:${r.B / d * 100}%"></span><span class="p" style="width:${r.Pe / d * 100}%"></span><span class="c" style="width:${r.C / d * 100}%"></span></div>`; };
  const cols = [
    { k: "rank", h: "#", w: 56, sv: rankOf, td: r => r.t ? (rankOf(r) <= 3 && r.B > 0 ? medal[rankOf(r) - 1] : rankOf(r)) : '<span class="mut">&#8212;</span>' },
    { k: "name", h: "Team member", w: 210, sv: r => r.name.toLowerCase(), td: r => `<span class="tmcell">${r.t ? avatarHtml(r.t, 30) : '<span class="av avi" style="width:30px;height:30px;background:#96a4ab;font-size:12px">?</span>'}<b>${esc(r.name)}</b></span>`, ft: () => "Team total" },
    { k: "orders", h: "Orders", num: true, w: 90, sv: r => r.n, td: r => `${units(r.n)}${r.nc ? `<div class="mut">${r.nc} cancelled</div>` : ""}`, ft: () => units(T("n")) },
    { k: "placed", h: "Placed", num: true, w: 120, sv: r => r.P, td: r => `${money(r.P)}<div class="mut">${units(r.q)} units</div>`, ft: () => money(T("P")) },
    { k: "billed", h: "Billed", num: true, w: 120, sv: r => r.B, td: r => `<b>${money(r.B)}</b><div class="mut">${units(r.bq)} units${r.eq ? ` <span class="wtxt">(${units(r.eq)} extra*)</span>` : ""}</div>`, ft: () => money(T("B")) },
    { k: "pending", h: "Pending to bill", num: true, w: 124, sv: r => r.Pe, td: r => `<span class="${r.Pe ? "wtxt" : ""}">${money(r.Pe)}</span>`, ft: () => money(T("Pe")) },
    { k: "cxl", h: "Cancelled / closed", num: true, w: 130, sv: r => r.C, td: r => money(r.C), ft: () => money(T("C")) },
    { k: "fill", h: "Fill rate", w: 120, sv: r => r.fill, td: r => `<div class="fill"><span style="width:${Math.min(100, r.fill)}%"></span></div><div class="mut tnum">${r.fill.toFixed(0)}%</div>` },
    { k: "mix", h: "Billed &#183; pending &#183; cancelled", label: "Split bar (billed · pending · cancelled)", w: 190, td: bar },
    { k: "ad", h: "Dealers ordering", num: true, w: 116, sv: r => r.ad, td: r => `${r.ad}${r.t ? `<div class="mut">of ${r.dl} tagged</div>` : ""}` },
    { k: "aov", h: "Avg order value", num: true, hide: true, w: 124, sv: r => r.aov, td: r => money(r.aov) },
    { k: "last", h: "Last order", hide: true, w: 100, sv: r => r.last, td: r => r.last ? shortDate(r.last) : '<span class="mut">&#8212;</span>' }];
  const list = gSort("score", cols, pre), podium = ranked.filter(r => r.P > 0).slice(0, 3), dp = dealerPick(st, base0);
  host.innerHTML = `
   <div class="ohead"><div><h2>Scoreboard</h2><div class="mut">How the team is batting &#8212; placed, billed, pending and fill rate for every sales person. Click anyone to see their orders.</div></div>
    </div>
   ${periodBar(st)}
   ${orderKpis(base)}
   ${podium.length ? `<div class="podh">Top of the table <span class="mut">&#183; by billed value</span></div><div class="podium">${podium.map((r, i) => `<button class="pod p${i + 1}" data-tm="${r.id}">${r.B > 0 ? `<span class="medal">${medal[i]}</span>` : ""}${avatarHtml(r.t, 64)}<span class="pn">${esc(r.name)}</span><span class="pv tnum">${lakh(r.B)} <i>billed</i></span><span class="mut tnum">${r.fill.toFixed(0)}% fill &#183; ${r.n} order${r.n === 1 ? "" : "s"} &#183; ${lakh(r.Pe)} pending</span></button>`).join("")}</div>` : ""}
   <div class="card"><div class="toolbar"><h3 style="margin:0 6px 0 0;font-size:14px">Team members</h3>${dp.html}<div class="spacer"></div>${gPicker("score", cols)}<button class="xbtn" data-xs>Export XLS</button></div>
    <div class="scroll">${gTable("score", cols, list, { cls: "otbl", tr: r => `class="orow" data-tm="${r.id}"`, foot: rows, empty: "No sales people yet." })}</div>
    <div class="tblnote">Values at the order price (incl. GST), by order date. Billed = quantity on linked ERP orders. Fill rate = billed against the order &#247; (placed &#8722; cancelled).${T("eq") ? `<br><b>* Extra = units billed in ERP that were not in the original order (substitutions or add-ons).</b>` : ""} <span class="mix-key"><i class="b"></i>billed <i class="p"></i>pending <i class="c"></i>cancelled / closed</span></div></div>`;
  const redraw = () => drawScore();
  wirePeriod(host, st, redraw); wireDealerPick(host, st, dp.list, redraw); gWire(host, "score", cols, redraw);
  host.querySelectorAll("[data-tm]").forEach(el => el.onclick = () => { const o = OV["b-orders"]; Object.assign(o, { team: el.dataset.tm, dealer: st.dealer, pm: st.pm, pf: st.pf, pt: st.pt, f: "all", lim: 0 }); show("b-orders"); });
  host.querySelector("[data-xs]").onclick = () => downloadXLS("Scoreboard", ["Rank", "Team member", "Orders", "Cancelled orders", "Placed value", "Units ordered", "Billed value", "Units billed", "Extra units billed", "Pending value", "Cancelled / closed value", "Fill rate %", "Dealers ordering", "Dealers tagged", "Avg order value", "Last order"],
    pre.map(r => [r.t ? rankOf(r) : "", r.name, r.n, r.nc, Math.round(r.P), r.q, Math.round(r.B), r.bq, r.eq, Math.round(r.Pe), Math.round(r.C), Math.round(r.fill), r.ad, r.dl, Math.round(r.aov), r.last]));
}
function exportOrders(list, kind, title) {
  if (kind === "lines") {
    const head = ["Order", "Date", "Dealer", "Team member", "Status", "SKU", "Product", "Colour", "Size", "Ordered", "Price", "Billed", "Pending", "Billed value", "Pending value"];
    const rows = []; list.forEach(o => o.lines.forEach(l => { const it = item(l.sku); rows.push([o.ref, (o.submitted_at || o.created_at || "").slice(0, 10), o.dealer, o.team || "", (STG[o.stage] || [o.stage])[0], l.sku, it.name, it.col, it.size, l.qty, l.price, l.billed, l.pending, Math.round(l.billed * l.price), Math.round(l.pending * l.price)]); }));
    downloadXLS(title + " SKU lines", head, rows); return;
  }
  const head = ["Order", "Date", "Dealer", "Team member", "Status", "Ordered units", "Ordered value", "Billed units", "Billed value", "Extra billed units", "Extra billed value", "Pending units", "Pending value", "Cancelled / closed value", "ERP order IDs"];
  const rows = list.map(o => [o.ref, (o.submitted_at || o.created_at || "").slice(0, 10), o.dealer, o.team || "", (STG[o.stage] || [o.stage])[0], o.tot.oq, Math.round(o.tot.ov), o.tot.bq, Math.round(o.tot.bvo), o.tot.eq || 0, Math.round(o.tot.ev || 0), o.tot.pq, Math.round(o.tot.pv), Math.round(o.tot.cv), o.links.map(l => l.no).join(" ")]);
  if (kind === "xls") downloadXLS(title, head, rows); else downloadCSV(title, head, rows);
}

/* ---------- order detail ---------- */
async function openOrder(id) {
  const o = ORDERS && ORDERS.find(x => x.id === id); if (!o) return;
  try { await B.loadItems(); } catch (e) {}
  const t = o.tot, pct = t.ov ? Math.min(100, t.bvo / t.ov * 100) : 0;
  const lines = o.lines.map(l => Object.assign({}, l, { it: item(l.sku) })).sort((a, b) => a.it.name.localeCompare(b.it.name) || a.it.col.localeCompare(b.it.col) || szCmp(a.it.size, b.it.size));
  const ro = viewer() || isMgr();
  const editable = !ro && (isBE() ? (o.status === "draft" || o.status === "submitted") : (!o.sheet_at && o.status === "draft" && o.team_id === meId()));
  const acts = [];
  if (editable) acts.push(`<button class="btn ghost" data-a="edit">Edit order</button>`);
  const canCancel = !ro && o.stage !== "cancelled" && (isBE() ? o.stage !== "billed" : o.status === "draft");
  if (canCancel) acts.push(`<button class="btn ghost danger" data-a="cancel">${o.links.length ? "Cancel full order" : "Cancel order"}</button>`);
  if (isBE()) {
    if (o.status === "submitted" && !o.closed_at) acts.push(`<button class="btn ${o.stage === "tobill" ? "primary" : "ghost"}" data-a="sheet">${o.sheet_at ? "Re-download billing sheet" : "Create billing sheet"}</button>`);
    if (o.status === "submitted" && !o.closed_at && o.sheet_at) acts.push(`<button class="btn primary" data-a="link">+ Link ERP order ID</button>`);
    if (o.closed_at) acts.push(`<button class="btn ghost" data-a="reopen">Reopen pending</button>`);
    else if (o.links.length && t.pq > 0) acts.push(`<button class="btn ghost" data-a="close">Close pending&#8230;</button>`);
  }
  const m = modal(`<div class="mh"><h3>${esc(o.ref)} &nbsp;${stagePill(o.stage)}${STN[o.stage] ? ` <span class="mut" style="font-size:12px;font-weight:500">${STN[o.stage]}</span>` : ""}</h3><button data-close>&times;</button></div>
   <div class="mbody">${cancelBox(o)}
    <div class="meta3">
     <div class="kv"><span>Dealer</span><b>${esc(o.dealer)}</b></div><div class="kv"><span>Team member</span><b>${esc(o.team || "Untagged")}</b></div><div class="kv"><span>Entered by</span><b>${esc(o.created_by || "")}</b></div>
     <div class="kv"><span>Submitted</span><b>${o.submitted_at ? dLong(o.submitted_at) : "— draft"}</b></div><div class="kv" style="grid-column:span 2"><span>Billing sheet</span><b>${o.sheet_at ? dLong(o.sheet_at) + (o.warehouse ? " · " + esc(o.warehouse) : "") : "—"}</b></div>
     <div class="kv" style="grid-column:1/-1"><span>Ship to</span><b style="font-weight:500">${o.ship_to && o.ship_to.label ? "<b>" + esc(o.ship_to.label) + "</b> &#183; " : ""}${esc(o.ship_to ? o.ship_to.text : "")}${o.ship_to && o.ship_to.gstin ? " &#183; GSTIN " + esc(o.ship_to.gstin) : ""}</b></div>
     ${o.dealer_ov ? `<div class="kv" style="grid-column:1/-1"><span>Dealer details &#8212; edited for this order only</span><b style="font-weight:500">${esc([o.dealer_ov.gstin || "No GSTIN", o.dealer_ov.phone, addrText(o.dealer_ov, "bill")].filter(Boolean).join(" · "))}${o.dealer_ov.ship_same ? "" : " &#183; ship to " + esc(addrText(o.dealer_ov, "ship"))}</b></div>` : ""}
     ${o.remarks ? `<div class="kv" style="grid-column:1/-1"><span>Remarks</span><b style="font-weight:500">${esc(o.remarks)}</b></div>` : ""}
     ${o.closed_at ? `<div class="kv" style="grid-column:1/-1"><span>Pending closed</span><b style="font-weight:500">${esc(o.close_reason || "")} &#8212; ${esc(o.closed_by || "")}, ${dLong(o.closed_at)} (${units(t.cq)} units)</b></div>` : ""}
    </div>
    <div class="prog"><div><span>Ordered</span><b class="tnum">${units(t.oq)}</b><i class="tnum">${money(t.ov)}</i></div><div><span>Billed${t.eq ? ` <span class="wtxt">(${units(t.eq)} extra*)</span>` : ""}</span><b class="tnum">${units(t.bq + (t.eq || 0))}</b><i class="tnum">${money(t.bvo + (t.ev || 0))}</i></div><div><span>Pending</span><b class="tnum ${t.pq ? "wtxt" : ""}">${units(t.pq)}</b><i class="tnum">${money(t.pv)}</i></div>${t.cq ? `<div><span>${o.stage === "cancelled" ? "Cancelled" : "Short-closed"}</span><b class="tnum">${units(t.cq)}</b><i class="tnum">${money(t.cv)}</i></div>` : ""}<div style="flex:2;min-width:160px"><span>Fill rate (value) &#183; ${pct.toFixed(0)}%</span><div class="fill big"><span style="width:${pct}%"></span></div></div></div>${t.eq ? `<div class="tblnote" style="margin:4px 0 12px">* Extra = units billed in ERP that were not in the original order (substitutions or add-ons).</div>` : ""}
    <h4>Order lines</h4>
    <div class="scroll"><table class="ltbl"><thead><tr><th>Product</th><th>Colour</th><th>Size</th><th>SKU</th><th class="num">Ordered</th><th class="num">Price</th><th class="num">Billed</th><th class="num">Pending</th></tr></thead><tbody>
     ${lines.map(l => `<tr><td>${esc(l.it.name)}</td><td>${esc(l.it.col)}</td><td>${esc(l.it.size)}</td><td class="mut">${esc(l.sku)}</td><td class="num tnum">${units(l.qty)}</td><td class="num tnum">${money(l.price)}</td><td class="num tnum">${units(l.billed)}</td><td class="num tnum ${l.pending ? "wtxt" : ""}">${units(l.pending)}${l.short_closed ? ` <span class="mut">(${units(l.short_closed)} closed)</span>` : ""}</td></tr>`).join("") || '<tr><td colspan="8" class="bempty">No lines.</td></tr>'}
    </tbody></table></div>
    ${o.extras.length ? `<h4 class="wtxt">Billed in ERP but not in this order <span class="mut" style="font-weight:500">&#8212; ${units(t.eq)} units (substitutions or extras)</span></h4>
     <div class="scroll"><table class="ltbl"><thead><tr><th>Product</th><th>Colour</th><th>Size</th><th>SKU</th><th class="num">Qty</th><th class="num">Rate</th><th>ERP order ID</th></tr></thead><tbody>
     ${o.extras.map(x => { const it = item(x.sku); return `<tr><td>${esc(it.name)}</td><td>${esc(it.col)}</td><td>${esc(it.size)}</td><td class="mut">${esc(x.sku)}</td><td class="num tnum">${units(x.qty)}</td><td class="num tnum">${money(x.rate)}</td><td>${esc(x.no)}</td></tr>`; }).join("")}</tbody></table></div>` : ""}
    <h4>Linked ERP orders</h4>
    ${o.links.length ? `<div class="scroll"><table class="ltbl"><thead><tr><th>Order ID</th><th>ERP Sales Order</th><th>Customer in ERP</th><th>Date</th><th>ERP status</th><th class="num">Units</th><th class="num">Value</th><th>Notes</th>${isBE() && !ro ? "<th></th>" : ""}</tr></thead><tbody>
     ${o.links.map(l => `<tr><td><b>${esc(l.no)}</b></td><td>${l.found ? esc(l.so) : '<span class="neg">not found</span>'}</td><td>${esc(l.customer || "")}</td><td>${dShort(l.date)}</td><td>${l.cancelled ? '<span class="neg">Cancelled</span>' : esc(l.status || "")}</td><td class="num tnum">${units(l.qty)}</td><td class="num tnum">${money(l.amount)}</td>
       <td class="ncell">${(l.flags || []).map(f => `<div class="wtxt">&#9888; ${esc(f)}</div>`).join("")}${l.shared_with.length ? `<div class="mut">Shared with ${esc(l.shared_with.join(", "))}</div>` : ""}${l.note ? `<div>${esc(l.note)}</div>` : ""}<div class="mut">by ${esc(l.linked_by || "")}, ${dLong(l.linked_at)}</div></td>
       ${isBE() ? `<td><button class="lnk" data-unlink="${attr(l.no)}">Unlink</button></td>` : ""}</tr>`).join("")}</tbody></table></div>` : `<div class="tblnote">None yet. ${o.sheet_at ? "Once the sheet is uploaded, the backend team enters the ERP order ID here." : "Billing creates the sheet first."}</div>`}
    <h4>Activity</h4><div class="evts">${o.events.slice().reverse().map(e => `<div><span class="mut tnum">${dLong(e.at)}</span> &#183; <b>${esc(e.who)}</b> &#8212; ${esc(e.what)}</div>`).join("") || '<div class="mut">—</div>'}</div>
   </div>
   <div class="mf"><span>${!ro && !isBE() && o.status === "submitted" && o.stage !== "cancelled" ? "&#128274; Placed orders can only be changed or cancelled by the backend team." : ""}</span><div class="hbtns">${acts.join("")}</div></div>`, { wide: true });
  const after = async (msg) => { ORDERS = null; await ensureOrders(true); toast(msg, "ok"); refresh(); openOrder(id); };
  m.querySelectorAll("[data-a]").forEach(b => b.onclick = async () => {
    const a = b.dataset.a;
    try {
      if (a === "edit") editOrder(o);
      else if (a === "sheet") openSheet([o.id]);
      else if (a === "link") openLink(o.id);
      else if (a === "close") openClose(o);
      else if (a === "reopen") { await B.api("order_close", { id: o.id, reopen: true }); await after("Pending reopened"); }
      else if (a === "cancel") { if (o.status === "draft") { if (!confirm("Cancel draft " + o.ref + "?")) return; await B.api("order_cancel", { id: o.id }); await after(o.ref + " cancelled"); } else openCancel(o); }
    } catch (e) { toast(e.message, "err"); }
  });
  m.querySelectorAll("[data-unlink]").forEach(b => b.onclick = async () => {
    if (!confirm("Unlink ERP order " + b.dataset.unlink + " from " + o.ref + "?")) return;
    try { await B.api("unlink", { order_id: o.id, no: b.dataset.unlink }); await after("Unlinked " + b.dataset.unlink); } catch (e) { toast(e.message, "err"); }
  });
}

function cancelBox(o) {
  if (o.stage !== "cancelled") return "";
  const ev = (o.events || []).slice().reverse().find(e => /^Order cancelled/.test(e.what || "")), why = cancelWhy(o);
  const by = o.cancelled_by || (ev && ev.who), at = o.cancelled_at || (ev && ev.at);
  return `<div class="cxbox"><div class="cxh">Cancellation reason</div><div class="cxr">${why ? esc(why) : '<span class="mut">No reason was recorded &#8212; this order was cancelled before reasons were captured.</span>'}</div>${by ? `<div class="mut">Cancelled by ${esc(by)}${at ? " &#183; " + dLong(at) : ""}</div>` : ""}</div>`;
}
const CX_REASONS = ["Dealer cancelled the order", "Out of stock", "Credit / payment issue", "Price / scheme issue", "Duplicate order", "Wrong entry", "Replaced by another order"];
function openCancel(o) {
  const t = o.tot;
  const m = modal(`<div class="mh"><h3>Cancel ${esc(o.ref)}</h3><button data-close>&times;</button></div>
   <div class="mbody"><p style="margin-top:0">${o.links.length ? `<b>${units(t.bq)} units</b> already billed in ERP stay billed there; the <b>${units(t.pq)} pending units</b> will no longer be pending.` : `The whole order &#8212; ${units(t.oq)} units, ${money(t.ov)} &#8212; will be cancelled.`} The reason shows on the order for the sales person and the Dugout.</p>
    <label class="field"><span>Why is it being cancelled? <b class="req">*</b></span><select id="cx-r"><option value="">Select a reason&#8230;</option>${CX_REASONS.map(r => `<option>${esc(r)}</option>`).join("")}<option value="__o">Other&#8230;</option></select></label>
    <label class="field"><span>Details <i id="cx-ti">optional</i></span><input id="cx-t" placeholder="e.g. dealer asked to hold till next season"></label></div>
   <div class="mf"><span></span><div class="hbtns"><button class="btn ghost" data-close>Back</button><button class="btn primary" id="cx-go">Cancel order</button></div></div>`);
  m.querySelectorAll("[data-close]").forEach(b => b.onclick = () => openOrder(o.id));
  const sel = m.querySelector("#cx-r"), det = m.querySelector("#cx-t");
  sel.onchange = () => { m.querySelector("#cx-ti").textContent = sel.value === "__o" ? "required" : "optional"; if (sel.value === "__o") det.focus(); };
  m.querySelector("#cx-go").onclick = async e => {
    const other = sel.value === "__o", d = det.value.trim();
    if (!sel.value) { toast("Pick the reason for cancelling", "err"); sel.focus(); return; }
    if (other && !d) { toast("Write the reason in Details", "err"); det.focus(); return; }
    const r = other ? d : [sel.value, d].filter(Boolean).join(" — ");
    e.target.disabled = true;
    try { await B.api("order_cancel", { id: o.id, reason: r }); ORDERS = null; await ensureOrders(true); refresh(); openOrder(o.id); toast(o.ref + " cancelled", "ok"); }
    catch (er) { e.target.disabled = false; toast(er.message, "err"); }
  };
}

/* ---------- billing sheet ---------- */
function openSheet(ids) {
  const os = ids.map(i => ORDERS.find(o => o.id === i)).filter(Boolean), s = BOOT.settings;
  const blocked = os.filter(o => !o.dealer_complete);
  const m = modal(`<div class="mh"><h3>Create billing sheet</h3><button data-close>&times;</button></div>
   <div class="mbody"><p class="mut" style="margin-top:0">Generates the <b>Saleor bulk order import</b> file for ${os.length === 1 ? "this order" : os.length + " orders"} &#8212; one order block per order. Upload it to ERP as usual, then enter the ERP order ID${os.length === 1 ? "" : "s"} back here.</p>
    <div class="scroll"><table class="ltbl"><thead><tr><th>Order</th><th>Dealer</th><th class="num">Units</th><th class="num">Value</th><th>Dealer details</th></tr></thead><tbody>
    ${os.map(o => `<tr><td><b>${esc(o.ref)}</b>${o.sheet_count ? `<div class="mut">sheet made ${o.sheet_count}&#215; before</div>` : ""}</td><td>${esc(o.dealer)}</td><td class="num tnum">${units(o.tot.oq)}</td><td class="num tnum">${money(o.tot.ov)}</td><td>${o.dealer_complete ? '<span class="ptxt">&#10003; complete</span>' : `<span class="neg">&#10007; incomplete</span> <button class="lnk" data-fix="${o.dealer_id}">Fix</button>`}</td></tr>`).join("")}
    </tbody></table></div>
    <div class="ogrid" style="margin-top:14px"><label class="field"><span>Warehouse</span><select id="sh-wh">${s.warehouses.map(w => `<option value="${attr(w.code)}" ${w.code === s.default_warehouse ? "selected" : ""}>${esc(w.code)}${w.label ? " — " + esc(w.label) : ""}</option>`).join("")}</select></label>
     <label class="field"><span>Transaction type</span><select id="sh-tx">${s.transaction_types.map(x => `<option ${x === s.default_txn ? "selected" : ""}>${esc(x)}</option>`).join("")}</select></label></div>
   </div>
   <div class="mf"><span>${blocked.length ? `<span class="neg">Fix ${blocked.length} dealer${blocked.length === 1 ? "" : "s"} first.</span>` : "Channel slug: <b>" + esc(s.channel_slug) + "</b>"}</span><div class="hbtns"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="sh-go" ${blocked.length ? "disabled" : ""}>&#8595; Download billing sheet</button></div></div>`);
  m.querySelectorAll("[data-close]").forEach(b => b.onclick = closeModal);
  m.querySelectorAll("[data-fix]").forEach(b => b.onclick = () => dealerForm(dealerById(+b.dataset.fix), async () => { ORDERS = null; await ensureOrders(true); openSheet(ids); }));
  m.querySelector("#sh-go").onclick = async e => {
    e.target.disabled = true;
    try {
      const r = await B.api("sheet", { order_ids: ids, warehouse: m.querySelector("#sh-wh").value, transaction_type: m.querySelector("#sh-tx").value });
      dlBlob(r.filename, new Blob([r.csv], { type: "text/csv;charset=utf-8" }));
      OV["b-desk"].sel.clear(); ORDERS = null; await ensureOrders(true); closeModal(); refresh();
      toast("Billing sheet downloaded — " + os.map(o => o.ref).join(", ") + " now awaiting ERP order ID", "ok");
    } catch (er) { e.target.disabled = false; toast(er.message, "err"); }
  };
}

/* ---------- link ERP order IDs ---------- */
function openLink(id) {
  const o = ORDERS.find(x => x.id === id); if (!o) return;
  const m = modal(`<div class="mh"><h3>Link ERP order ID &#183; ${esc(o.ref)}</h3><button data-close>&times;</button></div>
   <div class="mbody"><p class="mut" style="margin-top:0">${esc(o.dealer)} &#183; ${units(o.tot.oq)} units ordered${o.links.length ? " &#183; already linked: " + o.links.map(l => esc(l.no)).join(", ") : ""}</p>
    <label class="field"><span>Front-end order ID(s) &#8212; one or more, separated by comma, space or new line</span><textarea id="lk-in" rows="3" placeholder="e.g. 90378, 90391"></textarea></label>
    <div style="text-align:right"><button class="btn" id="lk-chk">Check in ERP</button></div>
    <div id="lk-res"></div></div>
   <div class="mf"><span id="lk-msg"></span><div class="hbtns"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="lk-go" disabled>Link</button></div></div>`);
  m.querySelectorAll("[data-close]").forEach(b => b.onclick = closeModal);
  const inp = m.querySelector("#lk-in"), res = m.querySelector("#lk-res"), go = m.querySelector("#lk-go"), msg = m.querySelector("#lk-msg");
  let okNos = [], warn = false;
  inp.focus(); inp.oninput = () => { go.disabled = true; okNos = []; };
  inp.onkeydown = e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) m.querySelector("#lk-chk").click(); };
  m.querySelector("#lk-chk").onclick = async e => {
    e.target.disabled = true; e.target.textContent = "Checking…"; res.innerHTML = "";
    try {
      const r = await B.api("link_check", { order_id: id, numbers: inp.value });
      okNos = r.results.filter(x => !x.errors.length).map(x => x.no); warn = r.results.some(x => !x.errors.length && x.warnings.length);
      res.innerHTML = `${r.invalid.length ? `<div class="wbox" style="margin-top:12px">Ignored &#8212; not valid order IDs: <b>${r.invalid.map(esc).join(", ")}</b></div>` : ""}
       ${r.results.length ? `<div class="scroll" style="margin-top:12px"><table class="ltbl"><thead><tr><th>Order ID</th><th>ERP Sales Order</th><th>Customer in ERP</th><th>Date</th><th class="num">Units</th><th class="num">Value</th><th>Check</th></tr></thead><tbody>
       ${r.results.map(x => `<tr><td><b>${esc(x.no)}</b></td><td>${esc(x.so || "")}</td><td>${esc(x.customer || "")}</td><td>${dShort(x.date)}</td><td class="num tnum">${x.found ? units(x.qty) : ""}</td><td class="num tnum">${x.found ? money(x.amount) : ""}</td>
         <td class="ncell">${x.errors.map(er => `<div class="neg">&#10007; ${esc(er)}</div>`).join("")}${x.warnings.map(w => `<div class="wtxt">&#9888; ${esc(w)}</div>`).join("")}${!x.errors.length && !x.warnings.length ? '<span class="ptxt">&#10003; OK</span>' : ""}</td></tr>`).join("")}</tbody></table></div>` : ""}
       ${warn ? `<div class="wbox" style="margin-top:12px"><label class="chk" style="white-space:normal"><input type="checkbox" id="lk-cf"> I've checked the exceptions above and confirm these ERP orders belong to ${esc(o.ref)}.</label><input id="lk-note" class="tsearch" style="width:100%;margin-top:8px" placeholder="Note for the record (e.g. 'one ERP order for B2B-1004 + B2B-1005, confirmed with Ravi')"></div>` : ""}`;
      go.textContent = okNos.length ? `Link ${okNos.length} order ID${okNos.length === 1 ? "" : "s"}` : "Link";
      go.disabled = !okNos.length || warn;
      msg.innerHTML = r.results.some(x => x.errors.length) && okNos.length ? '<span class="mut">IDs with &#10007; will be skipped.</span>' : "";
      const cf = m.querySelector("#lk-cf"); if (cf) cf.onchange = () => go.disabled = !cf.checked || !okNos.length;
    } catch (er) { toast(er.message, "err"); }
    e.target.disabled = false; e.target.textContent = "Check in ERP";
  };
  go.onclick = async () => {
    go.disabled = true;
    try {
      const n = m.querySelector("#lk-note");
      await B.api("link_commit", { order_id: id, numbers: okNos, confirm: warn, note: n ? n.value : "" });
      ORDERS = null; await ensureOrders(true); refresh(); openOrder(id); toast("Linked " + okNos.join(", ") + " to " + o.ref, "ok");
    } catch (er) { go.disabled = false; toast(er.message, "err"); }
  };
}
function openClose(o) {
  const m = modal(`<div class="mh"><h3>Close pending &#183; ${esc(o.ref)}</h3><button data-close>&times;</button></div>
   <div class="mbody"><p style="margin-top:0">${units(o.tot.pq)} units (${money(o.tot.pv)}) are still pending. Closing marks them as <b>not going to be billed</b> &#8212; the order drops out of the pending list. You can reopen it later.</p>
   <label class="field"><span>Reason</span><select id="cl-r"><option>Out of stock</option><option>Dealer cancelled the balance</option><option>Price / scheme issue</option><option>Replaced by another order</option><option value="">Other&#8230;</option></select></label>
   <label class="field"><span>Details <i>optional</i></span><input id="cl-t" placeholder="Add a note"></label></div>
   <div class="mf"><span></span><div class="hbtns"><button class="btn ghost" data-close>Back</button><button class="btn primary" id="cl-go">Close pending</button></div></div>`);
  m.querySelectorAll("[data-close]").forEach(b => b.onclick = () => openOrder(o.id));
  m.querySelector("#cl-go").onclick = async () => {
    const r = [m.querySelector("#cl-r").value, m.querySelector("#cl-t").value.trim()].filter(Boolean).join(" — ");
    if (!r) { toast("Give a reason", "err"); return; }
    try { await B.api("order_close", { id: o.id, reason: r }); ORDERS = null; await ensureOrders(true); refresh(); openOrder(o.id); toast("Pending closed", "ok"); } catch (e) { toast(e.message, "err"); }
  };
}

/* =================================================================== DEALERS */
const DV = { q: "", team: "" };
function renderDealers() {
  const host = document.getElementById("b-dealers");
  const ocount = {}; (ORDERS || []).forEach(o => { if (o.stage !== "cancelled" && o.stage !== "draft") ocount[o.dealer_id] = (ocount[o.dealer_id] || 0) + 1; });
  if (!ORDERS) ensureOrders().then(() => { if (tab === "b-dealers") renderDealers(); }).catch(() => {});
  if (!prefsP) { loadPrefs().then(() => { if (tab === "b-dealers") renderDealers(); }); }
  let list = BOOT.dealers.filter(d => seeAll() ? (d.source === "app" || d.complete || d.team_id) : d.team_id === meId());
  if (DV.team) list = list.filter(d => DV.team === "exc" ? d.excluded : DV.team === "none" ? !d.team_id && !d.excluded : String(d.team_id) === DV.team);
  if (DV.q) { const q = DV.q.toLowerCase(); list = list.filter(d => [d.name, d.gstin, d.phone, d.bill_city, d.bill_state].join(" ").toLowerCase().includes(q)); }
  list.sort((a, b) => a.name.localeCompare(b.name));
  const teams = BOOT.team.filter(t => t.active);
  const cols = [
    { k: "name", h: "Dealer", w: 270, tc: "wrapc", sv: d => d.name.toLowerCase(), td: d => `<b>${esc(d.name)}</b>${d.is_intl ? ` <span class="pill tagged">International &#183; ${esc(d.country || "")}</span>` : ""}${d.contact ? `<div class="mut">${esc(d.contact)}</div>` : ""}${(d.ship_addrs || []).length ? `<div class="mut">${d.ship_addrs.length} shipping address${d.ship_addrs.length === 1 ? "" : "es"}</div>` : ""}` },
    { k: "gstin", h: "GSTIN", w: 150, tc: "tnum", sv: d => d.gstin || "", td: d => esc(d.is_intl ? "n/a" : d.gstin || "—") },
    { k: "city", h: "City", w: 120, sv: d => (d.bill_city || "").toLowerCase(), td: d => esc(d.bill_city || "") },
    { k: "state", h: "State", w: 130, sv: d => d.bill_state || "", td: d => esc(d.bill_state || "") },
    { k: "phone", h: "Mobile", w: 124, tc: "tnum", sv: d => d.phone || "", td: d => esc(d.phone || "") },
    { k: "email", h: "Email", hide: true, w: 170, sv: d => d.email || "", td: d => esc(d.email || "") },
    { k: "team", h: "Team member", w: 170, sv: d => d.excluded ? "~~" : teamName(d.team_id) || "~", td: d => isBE() ? `<select data-tag="${d.id}"><option value="">&#8212; Untagged</option>${teams.map(t => `<option value="${t.id}" ${d.team_id === t.id && !d.excluded ? "selected" : ""}>${esc(t.name)}</option>`).join("")}<option value="exc" ${d.excluded ? "selected" : ""}>Exclude</option></select>` : esc(teamName(d.team_id) || "") },
    { k: "orders", h: "Orders", num: true, w: 84, sv: d => ocount[d.id] || 0, td: d => ocount[d.id] || 0 },
    { k: "det", h: "Details", w: 110, sv: d => d.complete ? 1 : 0, td: d => d.complete ? '<span class="pill tagged">Complete</span>' : '<span class="pill untagged">Incomplete</span>' }];
  if (isBE()) cols.push({ k: "ed", fixed: true, w: 70, h: "", td: d => `<button class="lnk" data-ed="${d.id}">Edit</button>` });
  const shown = gSort("dealers", cols, list);
  host.innerHTML = `<div class="ohead"><div><h2>${isBE() ? "All dealers" : isMgr() ? "Team dealers" : "My dealers"}</h2><div class="mut">${isBE() ? "Dealer details used on billing sheets. Re-tag a dealer to move it (and its orders) to another team member." : isMgr() ? "Every dealer and who it is tagged to. View only." : "Dealers tagged to you. Add a dealer once &#8212; pick them from the list on every order after that."}</div></div><div class="hbtns">${isMgr() ? "" : '<button class="btn primary sm" data-nd>+ New dealer</button>'}</div></div>
   <div class="card"><div class="toolbar"><input type="search" class="tsearch" data-q placeholder="Search name, GSTIN, mobile, city…" value="${attr(DV.q)}">
    ${seeAll() ? `<select data-team><option value="">All team members</option>${teams.map(t => `<option value="${t.id}" ${DV.team === String(t.id) ? "selected" : ""}>${esc(t.name)}</option>`).join("")}<option value="none" ${DV.team === "none" ? "selected" : ""}>&#8212; Untagged</option><option value="exc" ${DV.team === "exc" ? "selected" : ""}>&#8212; Excluded</option></select>` : ""}
    <div class="spacer"></div><span class="mut" style="font-size:12px">${list.length} dealer${list.length === 1 ? "" : "s"}</span>${gPicker("dealers", cols)}</div>
   <div class="scroll">${gTable("dealers", cols, shown, { empty: BOOT.dealers.length ? "No dealers match." : "No dealers yet." })}</div>
   <div class="tblnote">${isBE() ? "Edits here change the dealer permanently (every future order and billing sheet). Dealers that only appear in ERP sales are tagged in Backend &#8594; Dealer tagging." : isMgr() ? "Dealer details and tags are changed by the backend team." : "To change a dealer's details for one order, use <b>Edit details for this order</b> on the order. Permanent changes are made by the backend team."}</div></div>`;
  const nd = host.querySelector("[data-nd]"); if (nd) nd.onclick = () => dealerForm(null, () => renderDealers());
  gWire(host, "dealers", cols, renderDealers);
  const q = host.querySelector("[data-q]"); q.oninput = () => { DV.q = q.value; const p = q.selectionStart; renderDealers(); const n = document.querySelector("#b-dealers [data-q]"); n.focus(); n.setSelectionRange(p, p); };
  const ts = host.querySelector("[data-team]"); if (ts) ts.onchange = () => { DV.team = ts.value; renderDealers(); };
  host.querySelectorAll("[data-ed]").forEach(b => b.onclick = () => dealerForm(dealerById(+b.dataset.ed), () => renderDealers()));
  host.querySelectorAll("[data-tag]").forEach(s => s.onchange = async () => {
    const d = dealerById(+s.dataset.tag), v = s.value;
    try { await B.api("dealer_tag", { name: d.name, team_id: v && v !== "exc" ? +v : null, excluded: v === "exc" }); await reloadBoot(); ORDERS = null; toast(d.name + (v === "exc" ? " excluded" : v ? " tagged to " + teamName(+v) : " untagged"), "ok"); renderDealers(); }
    catch (e) { toast(e.message, "err"); renderDealers(); }
  });
}
async function reloadBoot() { BOOT = await B.api("boot"); initData(); }
B.reloadBoot = reloadBoot;

const COUNTRIES = [["US", "United States"], ["GB", "United Kingdom"], ["CA", "Canada"], ["AU", "Australia"], ["NZ", "New Zealand"], ["AE", "United Arab Emirates"], ["SG", "Singapore"], ["ZA", "South Africa"], ["LK", "Sri Lanka"], ["BD", "Bangladesh"], ["NP", "Nepal"], ["SA", "Saudi Arabia"], ["QA", "Qatar"], ["OM", "Oman"], ["KW", "Kuwait"], ["BH", "Bahrain"], ["DE", "Germany"], ["NL", "Netherlands"], ["IE", "Ireland"], ["MY", "Malaysia"]];
const AF = ["label", "street", "city", "pin", "state", "country", "gstin"];
/* dealer master form (several shipping addresses) — or, with {orderOnly}, the details used on one order (one ship-to) */
function dealerForm(d, onSaved, fopts) {
  fopts = fopts || {}; const only = !!fopts.orderOnly;
  d = d || {}; const states = Object.values(BOOT.states).sort(), isNew = !d.id && !only, teams = BOOT.team.filter(t => t.active);
  const F = {}; ["name", "gstin", "phone", "contact", "email", "bill_street", "bill_city", "bill_pin", "bill_state", "country"].forEach(k => F[k] = d[k] || "");
  F.is_intl = !!d.is_intl; F.team_id = d.team_id || "";
  if (F.country === "IN" && !F.is_intl) F.country = "";
  if (only) { F.ship_same = d.ship_same !== false; F.ship = { label: d.ship_label || "", street: d.ship_street || "", city: d.ship_city || "", pin: d.ship_pin || "", state: d.ship_state || "", country: d.ship_country && d.ship_country !== "IN" ? d.ship_country : "", gstin: d.ship_gstin || "" }; }
  else F.addrs = (d.ship_addrs || []).map(a => Object.assign({}, a));
  const fld = (k, label, v, extra) => `<label class="field" data-w="${k}"><span>${label}</span><input data-k="${k}" value="${attr(v)}" ${extra || ""}><em class="ferr"></em></label>`;
  const req = " <b class='req'>*</b>";
  const stF = (k, v) => F.is_intl ? fld(k, "State / province" + req, v) : `<label class="field" data-w="${k}"><span>State${req}</span><select data-k="${k}"><option value="">Select state…</option>${states.map(s => `<option ${s === v ? "selected" : ""}>${esc(s)}</option>`).join("")}</select><em class="ferr"></em></label>`;
  const pinF = (k, v) => F.is_intl ? fld(k, "Postal / ZIP code" + req, v, 'maxlength="12"') : fld(k, "PIN code" + req, v, 'inputmode="numeric" maxlength="6"');
  const ctF = (k, v) => F.is_intl ? fld(k, "Country code" + req + " <i>2 letters, e.g. US, GB, AE</i>", v, 'maxlength="2" list="ctrylist" style="text-transform:uppercase"') : "";
  const addrBlock = (p, a) => `${fld(p + "street", "Street address" + req, a.street)}<div class="ogrid3">${fld(p + "city", "City" + req, a.city)}${pinF(p + "pin", a.pin)}${stF(p + "state", a.state)}</div>${ctF(p + "country", a.country)}`;
  const shipExtra = (p, a) => `<div class="ogrid">${fld(p + "label", "Label <i>e.g. Bhiwandi warehouse</i>", a.label)}${F.is_intl ? "" : fld(p + "gstin", "Shipping GSTIN <i>optional</i>", a.gstin, 'maxlength="15" style="text-transform:uppercase"')}</div>`;
  const m = modal(`<div class="mh"><h3>${only ? "Dealer details &#8212; this order only" : isNew ? "New dealer" : "Dealer details"}</h3><button data-close>&times;</button></div>
   <div class="mbody" id="dfbody"></div><datalist id="ctrylist">${COUNTRIES.map(([c, n]) => `<option value="${c}">${n}</option>`).join("")}</datalist>
   <div class="mf"><span class="mut">${isNew ? (isBE() ? "" : "This dealer will be tagged to you.") : ""}</span><div class="hbtns"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="df-save">${only ? "Use for this order" : isNew ? "Add dealer" : "Save"}</button></div></div>`);
  m.querySelectorAll("[data-close]").forEach(b => b.onclick = () => { closeModal(); fopts.onCancel && fopts.onCancel(); });
  m.addEventListener("mousedown", e => { if (e.target === m && fopts.onCancel) fopts.onCancel(); });
  const body = m.querySelector("#dfbody");
  function paint() {
    body.innerHTML = `${only ? `<div class="ovbox" style="margin-bottom:12px">Changes here apply to <b>this order's billing sheet only</b>. The dealer master isn't changed &#8212; permanent changes are made in <b>All dealers</b> by the backend team.</div>` : ""}
    <label class="chk intlchk"><input type="checkbox" data-intl ${F.is_intl ? "checked" : ""}> <b>${only ? "International order" : "International customer"}</b> <span class="mut">&#8212; outside India: no GSTIN; postal code, state / province and country code instead</span></label>
    ${fld("name", "Dealer / firm name" + req + " <i>exactly as it should appear on the invoice</i>", F.name, !only && (isBE() || isNew) ? "" : "readonly title='The name stays as in the dealer master'")}
    <div class="ogrid">${F.is_intl ? "" : fld("gstin", "GSTIN <i>leave blank if not registered</i>", F.gstin, 'maxlength="15" style="text-transform:uppercase"')}${fld("phone", (F.is_intl ? "Phone <i>with country code</i>" : "Mobile") + req, F.phone, F.is_intl ? 'inputmode="tel" maxlength="18"' : 'inputmode="numeric" maxlength="13"')}</div>
    <div class="ogrid">${fld("contact", "Contact person", F.contact)}${fld("email", "Email", F.email, 'type="email"')}</div>
    <h4>Billing address</h4>${addrBlock("bill_", { street: F.bill_street, city: F.bill_city, pin: F.bill_pin, state: F.bill_state, country: F.country }).replace('data-k="bill_country"', 'data-k="country"').replace('data-w="bill_country"', 'data-w="bill_country"')}
    ${only ? `<h4>Shipping address</h4><label class="chk" style="margin:4px 0 6px"><input type="checkbox" data-shipsame ${F.ship_same ? "checked" : ""}> Same as billing</label>${F.ship_same ? "" : `<div class="shipcard">${shipExtra("ship_", F.ship)}${addrBlock("ship_", F.ship)}</div>`}`
      : `<h4>Shipping addresses</h4>${F.addrs.length ? F.addrs.map((a, i) => `<div class="shipcard"><div class="shiph"><b>Shipping address ${i + 1}</b>${i === 0 && F.addrs.length > 1 ? '<span class="mut">default on new orders</span>' : ""}<button class="lnk" data-rm="${i}">Remove</button></div>${shipExtra("ship_" + i + "_", a)}${addrBlock("ship_" + i + "_", a)}</div>`).join("") : '<div class="tblnote" style="margin:0 0 6px">Ships to the billing address.</div>'}
        <button class="lnk" data-addship>+ Add ${F.addrs.length ? "another" : "a"} shipping address</button>${F.addrs.length ? '<div class="mut" style="font-size:11.5px;margin-top:4px">Each new order asks which address to ship to (billing address or one of these).</div>' : ""}`}
    ${isBE() && !only ? `<label class="field" style="margin-top:10px"><span>Team member</span><select data-k="team_id"><option value="">&#8212; Untagged</option>${teams.map(t => `<option value="${t.id}" ${+F.team_id === t.id ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</select></label>` : ""}
    <div id="dupbox"></div>`;
    const ic = body.querySelector("[data-intl]"); ic.onchange = () => { F.is_intl = ic.checked; paint(); };
    const ss2 = body.querySelector("[data-shipsame]"); if (ss2) ss2.onchange = () => { F.ship_same = ss2.checked; paint(); };
    const add = body.querySelector("[data-addship]"); if (add) add.onclick = () => { F.addrs.push({ country: F.is_intl ? F.country : "" }); paint(); const c = body.querySelectorAll(".shipcard"); c[c.length - 1].querySelector("input").focus(); };
    body.querySelectorAll("[data-rm]").forEach(b => b.onclick = () => { F.addrs.splice(+b.dataset.rm, 1); paint(); });
    const gi = body.querySelector('[data-k="gstin"]'); if (gi) gi.addEventListener("input", () => { const v = gi.value.toUpperCase().replace(/\s/g, ""), s = BOOT.states[v.slice(0, 2)], bs = body.querySelector('[data-k="bill_state"]'); if (v.length >= 2 && s && bs && !bs.value) { bs.value = s; F.bill_state = s; } });
  }
  const setV = (k, v) => { let mm = k.match(/^ship_(\d+)_(\w+)$/); if (mm) { F.addrs[+mm[1]][mm[2]] = v; return; } mm = k.match(/^ship_(\w+)$/); if (only && mm && AF.includes(mm[1])) { F.ship[mm[1]] = v; return; } F[k] = v; };
  body.addEventListener("input", e => { const k = e.target.dataset.k; if (k) setV(k, e.target.value); });
  body.addEventListener("change", e => { const k = e.target.dataset.k; if (k) setV(k, e.target.value); });
  paint();
  if (!d.id && !only) body.querySelector('[data-k="name"]').focus();
  async function save(force) {
    body.querySelectorAll(".ferr").forEach(e => e.textContent = ""); body.querySelectorAll(".field.err").forEach(e => e.classList.remove("err"));
    const req = { id: d.id || null, force: !!force, is_intl: F.is_intl };
    ["name", "gstin", "phone", "contact", "email", "bill_street", "bill_city", "bill_pin", "bill_state", "country"].forEach(k => req[k] = F[k]);
    if (only) { req.ship_same = F.ship_same; AF.forEach(f => req["ship_" + f] = F.ship[f]); }
    else req.ship_addrs = F.addrs;
    if (isBE() && !only) req.team_id = F.team_id ? +F.team_id : null;
    const btn = m.querySelector("#df-save"); btn.disabled = true;
    try {
      if (only) { const r = await B.api("dealer_check", req); closeModal(); onSaved && onSaved(r.dealer); toast("Dealer details updated for this order", "ok"); return; }
      const r = await B.api("dealer_save", req);
      await reloadBoot(); closeModal(); toast(r.dealer.name + (isNew ? " added" : " saved"), "ok"); onSaved && onSaved(r.dealer);
    } catch (e) {
      btn.disabled = false;
      if (e.data && e.data.fields) {
        Object.entries(e.data.fields).forEach(([k, v]) => { const w = body.querySelector(`[data-w="${k === "bill_country" ? "bill_country" : k}"]`) || (k === "bill_country" ? body.querySelector('[data-k="country"]').closest(".field") : null); if (w) { w.classList.add("err"); w.querySelector(".ferr").textContent = v; } });
        const fe = body.querySelector(".field.err input,.field.err select"); if (fe) fe.focus(); toast(e.message, "err"); return;
      }
      if (e.data && e.data.duplicates) {
        const mine = x => isBE() || x.team_id === meId();
        body.querySelector("#dupbox").innerHTML = `<div class="wbox" style="margin-top:12px"><b>${esc(e.message)}</b>${e.data.duplicates.map(x => `<div class="duprow"><div><b>${esc(x.name)}</b><div class="mut">${esc([x.gstin, x.phone, x.bill_city].filter(Boolean).join(" · "))} &#183; ${esc(teamName(x.team_id) || "untagged")}</div></div>${mine(x) && onSaved ? `<button class="btn sm" data-use="${x.id}">Use this dealer</button>` : (mine(x) ? "" : '<span class="mut">tagged to someone else &#8212; ask backend</span>')}</div>`).join("")}
          ${e.data.hard ? "" : `<div style="margin-top:8px"><button class="btn ghost sm" id="df-force">It's a different dealer &#8212; save anyway</button></div>`}</div>`;
        body.querySelectorAll("[data-use]").forEach(b => b.onclick = () => { closeModal(); onSaved(dealerById(+b.dataset.use)); });
        const fb = body.querySelector("#df-force"); if (fb) fb.onclick = () => save(true);
        body.querySelector("#dupbox").scrollIntoView({ block: "nearest" });
        return;
      }
      toast(e.message, "err");
    }
  }
  m.querySelector("#df-save").onclick = () => save(false);
}
B.dealerForm = dealerForm;
B.openOrder = async id => {
  try { await ensureOrders(); } catch (e) { toast(e.message, "err"); return; }
  openOrder(+id);
};

/* =================================================================== SETTINGS (Billing → Backend → Billing sheet settings) */
B.renderSettings = function (host) {
  const s = JSON.parse(JSON.stringify(BOOT.settings));
  function paint() {
    host.innerHTML = `<div class="card"><div class="head"><h3>Billing sheet settings</h3><span class="note">values written into the Saleor bulk order import file</span></div>
     <div class="ogrid"><div><div class="wlbl" style="margin-bottom:6px">Warehouses &#183; code as used in the upload file</div>
       <div class="whl">${s.warehouses.map((w, i) => `<div class="whr"><input data-wc="${i}" value="${attr(w.code)}" placeholder="Code e.g. GGNER"><input data-wl="${i}" value="${attr(w.label)}" placeholder="Label e.g. Gurgaon ER"><label class="chk" title="Default"><input type="radio" name="whd" data-wd="${i}" ${w.code === s.default_warehouse ? "checked" : ""}>default</label><button class="rm" data-wr="${i}" ${s.warehouses.length < 2 ? "disabled" : ""}>&times;</button></div>`).join("")}</div>
       <button class="lnk" id="wh-add" style="margin-top:6px">+ Add warehouse</button></div>
      <div><div class="ogrid"><label class="field"><span>Channel slug</span><input id="s-ch" value="${attr(s.channel_slug)}"></label><label class="field"><span>Default transaction type</span><select id="s-dtx">${s.transaction_types.map(x => `<option ${x === s.default_txn ? "selected" : ""}>${esc(x)}</option>`).join("")}</select></label></div>
       <label class="field"><span>Transaction types <i>comma separated</i></span><input id="s-tx" value="${attr(s.transaction_types.join(", "))}"></label>
       <div class="ogrid"><label class="field"><span>Order number prefix</span><input id="s-px" value="${attr(s.ref_prefix)}"></label><label class="field"><span>Numbering starts at</span><input id="s-st" type="number" value="${attr(s.ref_start)}"></label></div></div></div>
     <div style="display:flex;justify-content:flex-end;gap:8px;align-items:center"><span class="mut" style="font-size:12px">Next new order looks like <b>${esc(s.ref_prefix)}${esc(s.ref_start)}&#8230;</b></span><button class="btn primary" id="s-save">Save settings</button></div></div>`;
    host.querySelectorAll("[data-wc]").forEach(i => i.oninput = () => { const k = +i.dataset.wc, old = s.warehouses[k].code; s.warehouses[k].code = i.value.trim(); if (s.default_warehouse === old) s.default_warehouse = s.warehouses[k].code; });
    host.querySelectorAll("[data-wl]").forEach(i => i.oninput = () => s.warehouses[+i.dataset.wl].label = i.value);
    host.querySelectorAll("[data-wd]").forEach(i => i.onchange = () => s.default_warehouse = s.warehouses[+i.dataset.wd].code);
    host.querySelectorAll("[data-wr]").forEach(b => b.onclick = () => { s.warehouses.splice(+b.dataset.wr, 1); paint(); });
    host.querySelector("#wh-add").onclick = () => { s.warehouses.push({ code: "", label: "" }); paint(); };
    host.querySelector("#s-tx").oninput = e => { s.transaction_types = e.target.value.split(",").map(x => x.trim()).filter(Boolean); };
    host.querySelector("#s-save").onclick = async () => {
      s.channel_slug = host.querySelector("#s-ch").value; s.default_txn = host.querySelector("#s-dtx").value;
      s.ref_prefix = host.querySelector("#s-px").value; s.ref_start = +host.querySelector("#s-st").value;
      try { const r = await B.api("settings_save", s); BOOT.settings = r.settings; Object.assign(s, JSON.parse(JSON.stringify(r.settings))); paint(); toast("Settings saved", "ok"); } catch (e) { toast(e.message, "err"); }
    };
  }
  paint();
};

/* =================================================================== router */
B.render = function (id) {
  if (id === "b-new") renderNew();
  else if (id === "b-orders" || id === "b-desk") renderOrders(id);
  else if (id === "b-dealers") renderDealers();
  else if (id === "b-score") renderScore();
};
B.resetForUser = function () { ORD = null; ORDERS = null; PREFS = {}; prefsP = null; Object.values(OV).forEach(st => { st.sel.clear(); st.team = ""; st.dealer = ""; st.q = ""; st.lim = 0; }); };
})();
