import {categories, prices, defaults, eligible, mapUrl} from "./rules.js";

import {communityUI} from "./community.js";

const $ = id => document.getElementById(id);
const editor = $("editor");
const colors = ["#fffaf2", "#f7e3c6", "#fde7e1", "#f2d4a8"];
const esc = value => String(value).replace(/[&<>"]/g, c => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;"}[c]));
function preferences() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem("eatpick")); } catch {}
  return {
    cat: categories.includes(saved?.cat) ? saved.cat : defaults.cat,
    price: prices.includes(saved?.price) ? saved.price : defaults.price,
    meal: ["l", "d"].includes(saved?.meal) ? saved.meal : defaults.meal,
    off: Array.isArray(saved?.off) ? saved.off.filter(Number.isSafeInteger) : [],
    norep: saved?.norep === true
  };
}
const prefs = preferences();
let resultId = null;
let data, busy = false, epoch = 0, rotation = 0, draftRevision, pendingDraw;
const candidates = () => eligible(data.restaurants, data.history, prefs);
const option = (value, label) => new Option(label, value);

function chips(id, items, key) {
  $(id).innerHTML = items.map(([v, label]) =>
    `<button type="button" class="chip" data-key="${key}" data-value="${esc(v)}" aria-pressed="${v === prefs[key]}">${esc(label)}</button>`).join("");
}
function renderFilters() {
  chips("cats", ["全部", ...categories].map(v => [v,v]), "cat");
  chips("prices", ["不限", ...prices].map(v => [v,v === "不限" ? v : v + " 美元以内"]), "price");
  chips("meals", [["any","都行"],["l","午饭"],["d","晚饭"]], "meal");
  $("norepeat").checked = prefs.norep;
}
function renderList() {
  $("list").innerHTML = data.restaurants.map(r =>
    `<label><input type="checkbox" data-id="${r.id}" ${prefs.off.includes(r.id) ? "" : "checked"}> ${esc(r.nameZh || r.name)}</label>`).join("");
}
function applyState(next) {
  const menuChanged = !data || JSON.stringify(data.restaurants) !== JSON.stringify(next.restaurants);
  data = {restaurants: next.restaurants, history: next.history, management: next.management};
  if (menuChanged) {
    renderList();
    $("total").textContent = ` ${data.restaurants.length} 家`;
    const editing = $("editing").value;
    $("editing").replaceChildren(option("", "添加新店"), ...data.restaurants.map(r => option(r.id, r.nameZh || r.name)));
    $("editing").value = editing;
  }
  const graded = data.restaurants.filter(r => r.voteCount > 0).length;
  $("graded-count").textContent = graded ? `已有 ${graded} 家店收到评分` : "还没有评分";
  community.sync(data.restaurants);
  if ($("result-grade")) {
    const r = data.restaurants.find(r => r.id === resultId);
    if (r) $("result-grade").textContent = grade(r);
  }
  $("manager").hidden = !data.management;
  $("hist").innerHTML = data.history.length
    ? data.history.map(h => `<li><button class="history-link" type="button" data-review="${h.restaurantId}" title="查看与评分">${esc(h.name)}</button></li>`).join("")
    : '<li class="empty" style="background:none;padding:0">还没有记录</li>';
}
const updateCount = () => {
  const n = candidates().length;
  $("count").textContent = n ? `符合条件的有 ${n} 家` : "没有符合条件的店，试试放宽筛选或取消排除。";
  $("spin").disabled = busy || !n;
  if ($("again")) $("again").disabled = busy || !n;
};
function drawWheel(pool) {
  const g = $("wheel"), n = pool.length;
  g.style.transition = "none";
  rotation = 0;
  g.style.transform = "rotate(0deg)";
  if (n <= 1) {
    g.innerHTML = `<circle cx="200" cy="200" r="182" fill="#fffaf2"/><text x="200" y="120" text-anchor="middle" font-size="16" fill="#7a5a4c">${n ? esc(shortName(pool[0].nameZh || pool[0].name, 16)) : "没有符合条件的店"}</text>`;
    return;
  }
  const angle = 2 * Math.PI / n;
  const point = a => [(200 + 182 * Math.sin(a)).toFixed(3), (200 - 182 * Math.cos(a)).toFixed(3)].join(" ");
  g.innerHTML = pool.map((r, i) => {
    const mid = (i + .5) * 360 / n;
    const path = `M200 200L${point(i * angle)}A182 182 0 0 1 ${point((i + 1) * angle)}Z`;
    const label = n <= 16
      ? `<text transform="rotate(${mid-90} 200 200)" x="370" y="200" dy="5" text-anchor="end" font-size="${n > 10 ? 13 : 15}" fill="#2a1a14">${esc(shortName(r.nameZh || r.name, 7))}</text>`
      : `<circle transform="rotate(${mid} 200 200)" cx="200" cy="34" r="4" fill="#b3121f"/>`;
    return `<path d="${path}" fill="${colors[i % colors.length]}" stroke="#b3121f" stroke-width="1"/>` + label;
  }).join("") + '<circle cx="200" cy="200" r="66" fill="#8a0d18"/>';
}
function shortName(name, max) {
  return name.length > max ? name.slice(0, max-1) + "…" : name;
}
function updatePreferences() {
  pendingDraw = null;
  try { localStorage.setItem("eatpick", JSON.stringify(prefs)); } catch {}
  renderFilters();
  drawWheel(candidates());
  updateCount();
}
function lock(value) {
  busy = value;
  epoch++;
  for (const id of ["cats", "prices", "meals", "list", "manager"]) $(id).inert = value;
  $("add-shop").disabled = value;
  $("open-ratings").disabled = value;
  $("hist").inert = value;
  if ($("rate-result")) $("rate-result").disabled = value;
  $("norepeat").disabled = value;
  if ($("ban")) $("ban").disabled = value || prefs.off.includes(Number($("ban").dataset.id));
  updateCount();
}
const grade = r => r.voteCount ? `★ ${r.average.toFixed(1)} / 5 · ${r.voteCount} 条评分` : "还没有评分";
function showResult(r) {
  resultId = r.id;
  $("status").textContent = "就吃这家！";
  $("live").textContent = r.nameZh || r.name;
  const fields = [["英文名",r.nameEn || "待补充"],["类型",r.type],["区域",r.area],
    ["门店地址",r.address || "地址待确认"],["营业时间",r.opening],["预计人均",r.perPerson]];
  if (r.phone) fields.push(["电话", r.phone]);
  if (r.nameNote) fields.push(["店名说明",r.nameNote]);
  if (r.note) fields.push(["备注",r.note]);
  const source = r.source ? `<dt>资料来源</dt><dd><a href="${esc(r.source)}" target="_blank" rel="noopener">查看门店资料</a></dd>` : "";
  const alternative = !r.address && r.nearbyAddress ? `<a class="btn" target="_blank" rel="noopener" href="${esc(mapUrl({address:r.nearbyAddress}))}">备选 · 导航到${esc(r.nearbyName)}</a>` : "";
  $("detail").innerHTML = "<dl>" + fields.map(([k,v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("") + source + '<dt>大家的评分</dt><dd id="result-grade"></dd></dl><div class="acts">' +
    `<a class="btn main" href="${esc(mapUrl(r))}" target="_blank" rel="noopener">${r.address ? "Google Maps 导航" : "在 Google Maps 搜索"}</a>` + alternative +
    '<button type="button" class="btn" id="again">不想吃，再转</button><button type="button" class="btn" id="ban">以后别转到它</button><button type="button" class="btn" id="rate-result">给这家评分</button></div>';
  $("result-grade").textContent = grade(r);
  $("rate-result").onclick = () => community.openReviews(r.id);
  $("again").onclick = spin;
  $("ban").dataset.id = r.id;
  $("ban").onclick = () => {
    prefs.off = [...new Set([...prefs.off, r.id])];
    updatePreferences();
    renderList();
    $("ban").disabled = true;
    $("status").textContent = "已排除 " + r.name;
  };
}
async function request(path, body, token) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = "Bearer " + token;
  const res = await fetch(path, {method: body ? "POST" : "GET", headers,
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(12000)});
  const value = await res.json();
  if (!res.ok && !(res.status === 409 && value.winner === null)) throw Error(value.error || "服务暂时不可用。");
  return value;
}
async function animate(pool, winner) {
  const g = $("wheel"), n = pool.length;
  const pick = pool.findIndex(r => r.id === winner);
  drawWheel(pool);
  if (n === 1) return;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  rotation = (reduce ? 0 : 6 * 360) + 360 - (pick + .5) * 360/n;
  g.getBoundingClientRect();
  g.style.transition = reduce ? "none" : "transform 4.2s cubic-bezier(.12,.75,.12,1)";
  g.style.transform = `rotate(${rotation}deg)`;
  if (reduce) return;
  let frame;
  const tick = () => {
    const m = new DOMMatrixReadOnly(getComputedStyle(g).transform);
    const degrees = (360 - Math.atan2(m.b,m.a) * 180/Math.PI) % 360;
    const r = pool[Math.floor(degrees/(360/n)) % n];
    $("live").textContent = r.nameZh || r.name;
    frame = requestAnimationFrame(tick);
  };
  tick();
  await new Promise(resolve => setTimeout(resolve, 4250));
  cancelAnimationFrame(frame);
}
async function spin() {
  if (busy || !data) return;
  lock(true);
  $("status").textContent = "转呀转……";
  pendingDraw ??= Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2,"0")).join("");
  try {
    const next = await request("/api/draws", {requestId: pendingDraw, prefs});
    pendingDraw = null;
    applyState(next);
    if (next.winner === null) {
      drawWheel([]);
      $("status").textContent = "没有符合条件的店，请调整筛选。";
      return;
    }
    const menu = new Map(data.restaurants.map(r => [r.id, r]));
    await animate(next.pool.map(id => menu.get(id)), next.winner);
    showResult(menu.get(next.winner));
  } catch {
    $("status").textContent = "未能取得结果，请再按一次「转」。";
  } finally { lock(false); }
}

document.addEventListener("click", e => {
  const chip = e.target.closest(".chip");
  if (!chip || busy || !data) return;
  prefs[chip.dataset.key] = chip.dataset.value;
  updatePreferences();
  document.querySelector(`.chip[data-key="${chip.dataset.key}"][aria-pressed="true"]`)?.focus({preventScroll:true});
});
$("list").onchange = e => {
  const id = Number(e.target.dataset.id);
  prefs.off = e.target.checked ? prefs.off.filter(v => v !== id) : [...new Set([...prefs.off,id])];
  if ($("ban") && Number($("ban").dataset.id) === id) $("ban").disabled = !e.target.checked;
  updatePreferences();
};
$("norepeat").onchange = e => { prefs.norep = e.target.checked; updatePreferences(); };
$("spin").onclick = spin;

const form = editor.elements;
form.category.replaceChildren(...categories.map(v => option(v,v)));
const fields = ["nameZh", "nameEn", "type", "category", "area", "address", "phone", "opening", "budgetUsd", "note"];
function loadEditor() {
  const r = data.restaurants.find(v => String(v.id) === $("editing").value);
  for (const f of fields) {
    const el = form.namedItem(f);
    el.value = r?.[f] ?? (el.tagName === "SELECT" ? el.options[0].value : "");
  }
  form.lunch.checked = !r || r.meals.includes("l");
  form.dinner.checked = !r || r.meals.includes("d");
  draftRevision = r?.revision;
  $("edit-status").textContent = "";
}
$("editing").onchange = loadEditor;
editor.onsubmit = async e => {
  e.preventDefault();
  if (busy) return;
  const inputs = Object.fromEntries(fields.map(f => [f, form.namedItem(f).value]));
  inputs.budgetUsd = inputs.budgetUsd ? Number(inputs.budgetUsd) : null;
  inputs.meals = [form.lunch.checked && "l", form.dinner.checked && "d"].filter(Boolean);
  if (!inputs.meals.length) { $("edit-status").textContent = "请选择午饭或晚饭。"; return; }
  inputs.id = $("editing").value === "" ? null : Number($("editing").value);
  inputs.revision = draftRevision;
  lock(true);
  try {
    applyState(await request("/api/restaurants", inputs, form.token.value));
    $("editing").value = "";
    loadEditor();
    drawWheel(candidates());
    $("edit-status").textContent = "已保存到大家的清单。";
  } catch (err) {
    $("edit-status").textContent = err.message;
  } finally { lock(false); }
};

async function refresh() {
  if (busy || document.hidden) return;
  const serial = ++epoch;
  try {
    const next = await request("/api/state");
    if (serial !== epoch) return;
    const first = !data;
    const before = data ? JSON.stringify(candidates().map(r => [r.id, r.revision])) : "";
    applyState(next);
    if (before !== JSON.stringify(candidates().map(r => [r.id, r.revision]))) drawWheel(candidates());
    if (first) {
      $("add-shop").disabled = false;
      $("open-ratings").disabled = false;
      renderFilters();
      $("status").textContent = "准备好了";
      $("detail").innerHTML = '<p class="empty">转一下，结果和店铺信息会显示在这里。</p>';
    }
    $("norepeat").disabled = false;
    updateCount();
  } catch {
    if (serial !== epoch || data) return;
    $("status").textContent = "清单暂时无法读取";
    $("detail").innerHTML = '<button class="btn" id="retry">重新加载</button>';
    $("retry").onclick = refresh;
  }
}
const community = communityUI({request, esc, grade, onListChange(next) {
  epoch++;
  applyState(next);
  drawWheel(candidates());
  updateCount();
}, onReviewChange(id, summary) {
  epoch++;
  const row = data?.restaurants.find(r => r.id === id);
  if (row) {
    Object.assign(row, {average: summary.average, voteCount: summary.voteCount});
    $("graded-count").textContent = `已有 ${data.restaurants.filter(r => r.voteCount > 0).length} 家店收到评分`;
  }
  if (resultId === id && $("result-grade")) $("result-grade").textContent = grade(summary);
}});
$("hist").onclick = event => {
  const button = event.target.closest("[data-review]");
  if (button && !busy) community.openReviews(Number(button.dataset.review));
};
$("norepeat").disabled = true;
refresh();
window.addEventListener("focus", refresh);
document.addEventListener("visibilitychange", refresh);
setInterval(refresh, 20000);
