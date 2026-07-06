/* ============================================================
   前端 AI 服务层
   页面只调用 AI.segment / AI.tryon / AI.recommend 三个函数，
   不关心背后是真模型还是占位实现。
   优先请求后端 /api/*（后端里可替换成真模型 API）；
   后端不在线时（比如双击 HTML 打开）自动回退到浏览器本地模拟，
   保证任何情况下产品都能用。
   ============================================================ */

const AI = {
  _online: null,   // 后端是否在线（null=未探测）

  async _post(path, body, timeout = 30000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const resp = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      return await resp.json();
    } finally {
      clearTimeout(timer);
    }
  },

  /* 探测后端是否在线（只探测一次，结果缓存） */
  async available() {
    if (this._online !== null) return this._online;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1500);
      const resp = await fetch("/api/health", { signal: ctrl.signal });
      clearTimeout(timer);
      this._online = resp.ok;
    } catch {
      this._online = false;
    }
    return this._online;
  },

  /* ---------- ⓪ 上传照片质检（创建模特前） ---------- */
  async validatePhoto(image) {
    if (await this.available()) {
      try {
        return await this._post("/api/validate-photo", { image }, 60000);
      } catch (e) { console.warn("validate 后端失败，本地放行", e); }
    }
    return { pass: true, fail_reasons: [], primary_reason: "", mock: true };
  },

  /* ---------- ① 衣物识别/平铺图/标签 ---------- */
  async segment(image) {
    if (await this.available()) {
      try {
        return await this._post("/api/segment", { image }, 240000);
      } catch (e) { console.warn("segment 后端失败，走本地模拟", e); }
    }
    /* 本地模拟：原图返回 */
    return { image, items: [{ image, category: "上衣", name: "我的单品" }], mock: true };
  },

  /* ---------- ② 虚拟试穿 ----------
     返回 { image } —— image 为 null 时由页面用本地叠图合成兜底 */
  async tryon(modelImage, items) {
    if (await this.available()) {
      try {
        return await this._post("/api/tryon", { modelImage, items }, 240000);
      } catch (e) { console.warn("tryon 后端失败，走本地模拟", e); }
    }
    return { image: null, mock: true };
  },

  /* ---------- ③ 搭配推荐 ---------- */
  async recommend(wardrobe, around = null) {
    const payload = {
      wardrobe: wardrobe.map(i => ({ id: i.id, category: i.cat, custom: !!i.dataUrl })),
      around,
    };
    if (await this.available()) {
      try {
        const r = await this._post("/api/recommend", payload);
        if (r && Array.isArray(r.items) && r.items.length) return r;
      } catch (e) { console.warn("recommend 后端失败，走本地模拟", e); }
    }
    /* 本地模拟：与后端占位实现相同的规则 */
    const pick = list => list[Math.floor(Math.random() * list.length)];
    const byCat = (cat, ex) => {
      const pool = wardrobe.filter(i => i.cat === cat && i.id !== ex);
      const mine = pool.filter(i => i.dataUrl);
      const list = mine.length ? mine : pool;
      return list.length ? pick(list).id : null;
    };
    let items;
    const it = around ? wardrobe.find(i => i.id === around) : null;
    if (it) {
      const need = {
        "上衣": ["下装", "鞋子"], "下装": ["上衣", "鞋子"],
        "连体裙": ["鞋子"], "鞋子": Math.random() > .3 ? ["上衣", "下装"] : ["连体裙"],
      }[it.cat] || [];
      items = [it.id, ...need.map(c => byCat(c, it.id))];
    } else {
      items = Math.random() > .3
        ? [byCat("上衣"), byCat("下装"), byCat("鞋子")]
        : [byCat("连体裙"), byCat("鞋子")];
    }
    return { items: items.filter(Boolean), mock: true };
  },
};
