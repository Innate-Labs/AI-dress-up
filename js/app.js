/* ============ 公共逻辑：状态存储 / 组件渲染 / 交互 ============ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* 任意页面 URL 带 ?reset=1 → 清空演示数据回到全新状态 */
if (new URLSearchParams(location.search).get("reset") === "1") {
  localStorage.removeItem("aiwd-state");
  location.replace("login.html");
}

/* 重置演示数据（我的页设置入口调用） */
function resetDemoData() {
  localStorage.removeItem("aiwd-state");
  location.href = "login.html";
}

/* ---------- 本地状态（localStorage） ---------- */
const Store = {
  KEY: "aiwd-state",
  _cache: null,
  defaults() {
    return {
      wardrobe: [...STARTER_WARDROBE],   // 衣橱里的单品 id（新用户=基础款）
      customItems: [],                   // 用户上传的单品 {id,name,cat,dataUrl}
      deletedItems: [],                  // 被删除的系统单品 id（其所在搭配全站隐藏）
      favorites: [],                     // 收藏的搭配 id
      history: [],                       // 试衣历史 {id,outfitId,items,scene,time}
      models: PRESET_MODELS.map(p => ({ ...p, dataUrl: null })),
      curModel: "m1",
      profile: { gender: "", job: "", pref: [] },
      onboarded: false,
    };
  },
  get() {
    if (!this._cache) {
      try { this._cache = { ...this.defaults(), ...JSON.parse(localStorage.getItem(this.KEY) || "{}") }; }
      catch { this._cache = this.defaults(); }
      /* 迁移：虚拟模特只保留默认款（高个/微胖/小个子已下线），用户上传的照片模特保留 */
      this._cache.models = this._cache.models.filter(m => m.dataUrl || m.id === "m1");
      if (!this._cache.models.find(m => m.id === "m1")) {
        this._cache.models.unshift({ ...PRESET_MODELS[0], dataUrl: null });
      }
      if (!this._cache.models.find(m => m.id === this._cache.curModel)) {
        this._cache.curModel = "m1";
      }
      /* 迁移：旧演示数据的单品/搭配 id 已随素材库更换，清掉失效引用 */
      const validItem = new Set(ITEMS.map(i => i.id));
      this._cache.wardrobe = (this._cache.wardrobe || []).filter(id => validItem.has(id));
      if (!this._cache.wardrobe.length) this._cache.wardrobe = [...STARTER_WARDROBE];
      const validOutfit = new Set(OUTFITS.map(o => o.id));
      this._cache.favorites = (this._cache.favorites || []).filter(id => validOutfit.has(id));
      if (!Array.isArray(this._cache.deletedItems)) this._cache.deletedItems = [];
    }
    return this._cache;
  },
  set(patch) {
    this._cache = { ...this.get(), ...patch };
    /* localStorage 约 5MB 且每次整份重写，塞满时 setItem 会抛异常中断当前操作。
       兜底：从最老的试衣间快照开始丢（占空间的主要是图），腾出地方再存；
       全丢完还存不下就提示用户，页面继续用内存数据跑，不再中断流程。
       （经产品负责人授权添加，刘倩已确认为正式方案 2026-07-08）
       返回保存结果给关键调用方（入橱/上传）决定后续提示与跳转：
       true=正常保存  "evicted"=清理旧快照后保存  false=没存下（仅内存） */
    const save = () => localStorage.setItem(this.KEY, JSON.stringify(this._cache));
    try { save(); return true; }
    catch {
      const orig = this._cache.history || [];
      const h = [...orig];
      while (h.length) {
        h.pop();                            /* history 新的在前，pop 丢的是最老一条 */
        this._cache.history = h;
        try { save(); toast("存储空间不足，已自动清理最早的试衣记录"); return "evicted"; }
        catch {}
      }
      this._cache.history = orig;           /* 丢光也没存下：内存里的历史别白丢 */
      toast("手机存储空间已满，本次内容未能保存");
      return false;
    }
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
  /* 用户自己上传的衣服排在最前面 */
  return [...s.customItems, ...ITEMS.filter(i => s.wardrobe.includes(i.id))];
}
function inWardrobe(id) {
  const s = Store.get();
  return s.wardrobe.includes(id) || s.customItems.some(c => c.id === id);
}
/* 引导问卷选的服饰性别偏好 → 展示哪些性别的搭配（没选=全部） */
function prefGenders() {
  const pref = Store.get().profile.pref || [];
  const g = new Set();
  if (pref.includes("女装")) g.add("f");
  if (pref.includes("男装")) g.add("m");
  return g.size ? g : new Set(["f", "m"]);
}
/* 可展示的搭配：性别符合偏好 + 不含被删除的衣服（删衣服→相关搭配全站隐藏） */
function availableOutfits() {
  const genders = prefGenders();
  const deleted = new Set(Store.get().deletedItems);
  return OUTFITS.filter(o =>
    genders.has(o.gender) && !o.items.some(id => deleted.has(id)));
}

/* 单品 <img>：优先找 assets/real/<id>.png → .jpg → 占位剪影 */
function itemImg(item, cls = "ph-img") {
  if (item.dataUrl) return `<img class="${cls}" src="${item.dataUrl}" alt="${item.name}" loading="lazy">`;
  return `<img class="${cls}" src="assets/real/${item.id}.png" alt="${item.name}" loading="lazy"
    onerror="phFallback(this,'${item.ph}')">`;
}
function phFallback(el, ph) {
  if (el.dataset.step === "2") { el.onerror = null; el.src = `assets/ph/${ph}.svg`; return; }
  el.dataset.step = "2";
  el.src = el.src.replace(/\.png$/, ".jpg");
}

/* 假 iOS 状态栏已移除（手机自带真状态栏）；保留空函数兼容各页面的调用 */
function renderStatusbar() {}

/* 手机浏览器状态栏/工具条颜色与页面顶部渐变统一
   （页面 head 里自带 theme-color 时以页面的为准，如添加衣服的深色页） */
if (!document.querySelector('meta[name="theme-color"]')) {
  const themeMeta = document.createElement("meta");
  themeMeta.name = "theme-color";
  themeMeta.content = "#e9f5ee";
  document.head.appendChild(themeMeta);
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
    ? `<div class="fab-slot"><a class="fab" href="${t.href}"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 4.5v15M4.5 12h15"/></svg></a></div>`
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

/* 默认虚拟模特图：按性别偏好选 assets/real/model-f.png 或 model-m.png，没图自动回退剪影 */
function defaultModelSrc() {
  const g = prefGenders();
  const gender = (g.size === 1 && g.has("m")) ? "m" : "f";
  return `assets/real/model-${gender}.png`;
}

/* 搭配整图：找 assets/real/<搭配id>.png → .jpg → 都没有则移除自己（露出下面的拼贴） */
function outfitCover(id) {
  return `<img class="ocover" src="assets/real/${id}.png" alt="" loading="lazy"
    onload="this.style.visibility='visible'"
    onerror="coverFallback(this)" data-step="1">`;
}
function coverFallback(el) {
  if (el.dataset.step === "1") { el.dataset.step = "2"; el.src = el.src.replace(/\.png$/, ".jpg"); }
  else el.remove();
}

/* 预设模特剪影的体型差异（CSS transform） */
function modelShapeCss(m) {
  return {
    tall:   "transform:scaleY(1.08);transform-origin:bottom center;",
    wide:   "transform:scaleX(1.24);transform-origin:bottom center;",
    petite: "transform:scale(.85);transform-origin:bottom center;",
  }[m && m.shape] || "";
}

/* 压缩图片：限制最大边长并转 JPEG，防止 localStorage 超限 */
function compressImage(dataUrl, maxW = 800, quality = 0.8) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxW / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

const fmtTime = ts => {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
};
