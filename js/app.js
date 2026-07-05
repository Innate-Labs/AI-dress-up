/* ============ 公共逻辑：状态存储 / 组件渲染 / 交互 ============ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ---------- 本地状态（localStorage） ---------- */
const Store = {
  KEY: "aiwd-state",
  _cache: null,
  defaults() {
    return {
      wardrobe: ITEMS.map(i => i.id),   // 衣橱里的单品 id
      customItems: [],                   // 用户上传的单品 {id,name,cat,dataUrl}
      favorites: [],                     // 收藏的搭配 id
      history: [],                       // 试衣历史 {id,outfitId,items,scene,time}
      models: [{ id: "m1", name: "默认模特", dataUrl: null }],
      curModel: "m1",
      profile: { gender: "", job: "", pref: [] },
      onboarded: false,
    };
  },
  get() {
    if (!this._cache) {
      try { this._cache = { ...this.defaults(), ...JSON.parse(localStorage.getItem(this.KEY) || "{}") }; }
      catch { this._cache = this.defaults(); }
    }
    return this._cache;
  },
  set(patch) {
    this._cache = { ...this.get(), ...patch };
    localStorage.setItem(this.KEY, JSON.stringify(this._cache));
  },
};

/* ---------- 单品工具 ---------- */
function allItems() {
  return [...ITEMS, ...Store.get().customItems];
}
function itemById(id) {
  return allItems().find(i => i.id === id);
}
function wardrobeItems() {
  const s = Store.get();
  return [...ITEMS.filter(i => s.wardrobe.includes(i.id)), ...s.customItems];
}
function inWardrobe(id) {
  const s = Store.get();
  return s.wardrobe.includes(id) || s.customItems.some(c => c.id === id);
}
/* 搭配里只要有一件衣服被删，该搭配整套不再展示 */
function availableOutfits() {
  return OUTFITS.filter(o => o.items.every(inWardrobe));
}

/* 单品 <img>：优先找 assets/real/<id>.png → .jpg → 占位剪影 */
function itemImg(item, cls = "ph-img") {
  if (item.dataUrl) return `<img class="${cls}" src="${item.dataUrl}" alt="${item.name}">`;
  return `<img class="${cls}" src="assets/real/${item.id}.png" alt="${item.name}"
    onerror="phFallback(this,'${item.ph}')">`;
}
function phFallback(el, ph) {
  if (el.dataset.step === "2") { el.onerror = null; el.src = `assets/ph/${ph}.svg`; return; }
  el.dataset.step = "2";
  el.src = el.src.replace(/\.png$/, ".jpg");
}

/* ---------- 假 iOS 状态栏 ---------- */
function renderStatusbar() {
  const el = document.createElement("div");
  el.className = "statusbar";
  el.innerHTML = `<span>9:41</span>
    <span class="sb-right">5G <i class="sb-batt"></i></span>`;
  document.querySelector(".app").prepend(el);
}

/* ---------- 底部导航 ---------- */
const TABS = [
  { key: "home",     label: "首页",     href: "home.html",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/></svg>' },
  { key: "wardrobe", label: "衣橱",     href: "wardrobe.html",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M12 3v18M9 11v2M15 11v2"/></svg>' },
  { key: "upload",   label: "上传",     href: "add-clothes.html", fab: true },
  { key: "history",  label: "试衣间",   href: "history.html",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>' },
  { key: "me",       label: "我的",     href: "profile.html",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>' },
];
function renderTabbar(active) {
  const nav = document.createElement("nav");
  nav.className = "tabbar";
  nav.innerHTML = TABS.map(t => t.fab
    ? `<div class="fab-slot"><a class="fab" href="${t.href}">+</a><span class="fab-label">${t.label}</span></div>`
    : `<a href="${t.href}" class="${t.key === active ? "active" : ""}">${t.icon}<span>${t.label}</span></a>`
  ).join("");
  document.querySelector(".app").append(nav);
}

/* ---------- Sheet / Modal / Toast ---------- */
function openSheet(id) {
  $("#mask-" + id)?.classList.add("show");
  $("#" + id)?.classList.add("show");
}
function closeSheet(id) {
  $("#mask-" + id)?.classList.remove("show");
  $("#" + id)?.classList.remove("show");
}
function openModal(id) { $("#" + id)?.classList.add("show"); }
function closeModal(id) { $("#" + id)?.classList.remove("show"); }

let toastTimer;
function toast(msg) {
  let el = $(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    document.body.append(el);
  }
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 1800);
}

/* ---------- 通用：场景/分类 chips ---------- */
function renderChips(container, list, onPick, active = 0) {
  container.innerHTML = list.map((c, i) => {
    const label = typeof c === "string" ? c : `${c.icon} ${c.key}`;
    return `<button class="chip ${i === active ? "active" : ""}" data-i="${i}">${label}</button>`;
  }).join("");
  $$(".chip", container).forEach(chip => chip.addEventListener("click", () => {
    $$(".chip", container).forEach(c => c.classList.remove("active"));
    chip.classList.add("active");
    const c = list[+chip.dataset.i];
    onPick(typeof c === "string" ? c : c.key);
  }));
}

const fmtTime = ts => {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
};
