import {categories, mapUrl} from "./rules.js";

export function communityUI({request, esc, grade, onListChange, onReviewChange}) {
  const $ = id => document.getElementById(id);
  const catalogDialog = $("catalog-dialog"), reviewDialog = $("ratings-dialog");
  const custom = $("new-shop"), review = $("review-form");
  const selector = $("review-shop");
  let wishlist = [], catalog = [], loading = false, adding = false, posting = false;
  let reviewSequence = 0, catalogSequence = 0, displayedCount = -1, pendingVote;
  const title = r => r.nameZh || r.name;
  const normalized = text => text.normalize("NFKC").toLowerCase().replace(/[\s.'’&-]+/g, "");
  const message = (id, text) => { $(id).textContent = text; };
  for (const dialog of [catalogDialog, reviewDialog]) {
    dialog.querySelector(".close").onclick = () => dialog.close();
    dialog.addEventListener("cancel", event => { if (adding || posting) event.preventDefault(); });
  }
  for (const cat of categories) {
    $("lookup-category").add(new Option(cat, cat));
    custom.elements.category.add(new Option(cat, cat));
  }
  function renderMatches() {
    const target = $("matches");
    if (loading) { target.textContent = "正在读取餐厅库……"; return; }
    const q = normalized($("lookup").value.trim()), cat = $("lookup-category").value;
    const joined = new Set(wishlist.map(r => r.id));
    const rows = catalog.filter(r => (!cat || r.category === cat) &&
      [r.nameZh, r.nameEn, r.name, r.area, r.type, r.address].some(s => normalized(s).includes(q)));
    rows.sort((a,b) => Number(joined.has(a.id)) - Number(joined.has(b.id)));
    target.innerHTML = rows.map(r => {
      const source = r.source ? ` · <a href="${esc(r.source)}" target="_blank" rel="noopener">门店资料</a>` : "";
      const added = Boolean(r.inList) || joined.has(r.id);
      return `<div class="catalog-row"><div><strong>${esc(title(r))}</strong>
        <span class="second-name">${esc(r.nameEn || "英文名待补充")}</span>
        <small>${esc(r.category)} · ${esc(r.area)} · 预计人均 ${esc(r.perPerson)}</small>
        <small>${r.address ? `<a href="${esc(mapUrl(r))}" target="_blank" rel="noopener" aria-label="导航到 ${esc(title(r))}">${esc(r.address)}</a>` : "地址待确认"}</small>
        <small>${esc(r.type)} · ${esc(r.opening)}${source}</small>
        ${r.nameNote ? `<small>${esc(r.nameNote)}</small>` : ""}</div>
        <button type="button" class="btn" data-join="${r.id}" aria-label="${added ? "已加入" : "加入"} ${esc(title(r))}" ${added || adding ? "disabled" : ""}>${added ? "已加入" : "加入"}</button></div>`;
    }).join("") || '<p class="empty">没有匹配的餐厅，可以在下方手动添加。</p>';
  }
  async function loadCatalog() {
    const seq = ++catalogSequence;
    loading = true;
    renderMatches();
    try {
      const rows = await request("/api/catalog");
      if (seq !== catalogSequence) return;
      catalog = rows;
      loading = false;
      renderMatches();
    } catch {
      if (seq !== catalogSequence) return;
      loading = false;
      $("matches").innerHTML = '<button class="btn" type="button" id="retry-catalog">重新加载餐厅库</button>';
      $("retry-catalog").onclick = loadCatalog;
    }
  }
  $("add-shop").onclick = () => {
    $("lookup").value = "";
    $("lookup-category").value = "";
    $("custom").open = false;
    message("add-feedback", "");
    message("custom-feedback", "");
    catalogDialog.showModal();
    loadCatalog();
  };
  $("lookup").oninput = renderMatches;
  $("lookup-category").onchange = renderMatches;
  async function join(body, name, manual) {
    if (adding) return;
    adding = true;
    catalogDialog.querySelector(".close").disabled = true;
    custom.inert = true;
    $("matches").inert = true;
    const feedback = manual ? "custom-feedback" : "add-feedback";
    try {
      const next = await request("/api/wishlist", body);
      if (manual) {
        custom.reset();
        $("custom").open = false;
        $("lookup").value = name;
        $("lookup-category").value = "";
      }
      onListChange(next);
      message("add-feedback", "已加入想吃清单：" + name);
    } catch (err) { message(feedback, err.message); }
    finally {
      adding = false;
      custom.inert = false;
      $("matches").inert = false;
      catalogDialog.querySelector(".close").disabled = false;
      renderMatches();
    }
  }
  $("matches").onclick = e => {
    const btn = e.target.closest("[data-join]");
    if (!btn) return;
    const r = catalog.find(r => r.id === Number(btn.dataset.join));
    if (r) join({id:r.id}, title(r), false);
  };
  custom.onsubmit = e => {
    e.preventDefault();
    const f = custom.elements;
    const meals = [f.lunch.checked && "l", f.dinner.checked && "d"].filter(Boolean);
    if (!meals.length) { message("custom-feedback","请选择午饭或晚饭。"); return; }
    join({nameZh:f.nameZh.value, nameEn:f.nameEn.value, area:f.area.value,
      address:f.address.value, phone:f.phone.value, type:f.type.value, opening:f.opening.value, note:f.note.value,
      category:f.category.value, budgetUsd:f.budgetUsd.value ? Number(f.budgetUsd.value) : null, meals}, f.nameZh.value.trim(), true);
  };

  $("star-options").innerHTML = [1,2,3,4,5].map(score =>
    `<label><input type="radio" name="score" value="${score}" required aria-label="${score} 星"><span aria-hidden="true"></span></label>`).join("");
  function displayReviews(result) {
    displayedCount = result.voteCount;
    message("review-average", grade(result));
    $("review-list").innerHTML = result.entries.map(v =>
      `<li><span>${esc(v.author)}</span><strong>${v.score} / 5</strong></li>`).join("")
      || '<li class="empty">还没有人给这家店打分。</li>';
  }
  async function loadReviews() {
    const id = selector.value, seq = ++reviewSequence;
    if (!id) return;
    try {
      const result = await request("/api/ratings/" + id);
      if (seq === reviewSequence && reviewDialog.open && id === selector.value) displayReviews(result);
    } catch {
      if (seq === reviewSequence) message("review-average", "评分读取失败，请重新选择餐厅。");
    }
  }
  function selectReview() {
    pendingVote = null;
    review.reset();
    displayedCount = -1;
    review.hidden = !selector.value;
    $("review-list").replaceChildren();
    message("review-feedback", "");
    message("review-average", selector.value ? "正在读取评分……" : "先选择一家吃过的餐厅。");
    loadReviews();
  }
  function openReviews(id) {
    selector.replaceChildren(new Option("请选择餐厅", ""), ...wishlist.map(r =>
      new Option([title(r),r.nameEn].filter(Boolean).join(" · "),r.id)));
    selector.value = id == null ? "" : String(id);
    reviewDialog.showModal();
    selectReview();
  }
  $("open-ratings").onclick = () => openReviews();
  selector.onchange = selectReview;
  review.oninput = () => { pendingVote = null; message("review-feedback", ""); };
  review.onsubmit = async e => {
    e.preventDefault();
    if (posting || !selector.value) return;
    posting = true;
    review.inert = true;
    selector.disabled = true;
    reviewDialog.querySelector(".close").disabled = true;
    ++reviewSequence;
    const restaurantId = Number(selector.value);
    pendingVote ??= Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2,"0")).join("");
    try {
      const result = await request("/api/ratings", {restaurantId, requestId:pendingVote,
        score:Number(review.elements.score.value), author:review.elements.author.value.trim()});
      displayReviews(result);
      onReviewChange(restaurantId,result);
      pendingVote = null;
      review.reset();
      message("review-feedback","评分已保存。");
    } catch (err) { message("review-feedback",err.message); }
    finally {
      posting = false;
      review.inert = false;
      selector.disabled = false;
      reviewDialog.querySelector(".close").disabled = false;
    }
  };
  return {openReviews, sync(rows) {
    const changed = rows.length !== wishlist.length || rows.some((r,i) =>
      r.id !== wishlist[i].id || r.revision !== wishlist[i].revision);
    wishlist = rows;
    if (catalogDialog.open && !loading && changed) {
      const byId = new Map(catalog.map(r => [r.id,r]));
      for (const r of rows) byId.set(r.id,r);
      catalog = [...byId.values()];
      renderMatches();
    }
    if (reviewDialog.open && selector.value && !posting) {
      const row = rows.find(r => String(r.id) === selector.value);
      if (row && row.voteCount !== displayedCount) loadReviews();
    }
  }};
}
