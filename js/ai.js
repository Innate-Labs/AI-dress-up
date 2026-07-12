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
      } catch (e) {
        /* 后端在线但请求失败＝真失败，上抛给页面提示"识别失败"，
           不再静默把整张原图当"上衣"入橱（mock 只用于离线演示降级） */
        console.warn("segment 请求失败（在线）", e);
        throw e;
      }
    }
    /* 本地模拟：原图返回 */
    return { image, items: [{ image, category: "上衣", name: "我的单品" }], mock: true };
  },

  /* ---------- ①b 拆图分步版（上传卡片进度用） ---------- */

  /* 识别照片里有哪些衣服（快）：{ items: [{category, description}] } */
  async detect(image) {
    if (await this.available()) {
      try {
        return await this._post("/api/detect", { image }, 90000);
      } catch (e) { console.warn("detect 请求失败（在线）", e); throw e; }
    }
    /* 本地模拟：当一件处理 */
    return { items: [{ category: "上衣", description: "我的单品" }], mock: true };
  },

  /* 对识别出的一件生成平铺图+标签（慢）：{ item: {image, category, name, labels} }
     strict：有密钥但生成失败时后端直接报错 → 页面显示失败卡可重试，不塞原图 */
  async segmentOne(image, target) {
    if (await this.available()) {
      try {
        return await this._post("/api/segment-one", { image, target, strict: true }, 240000);
      } catch (e) { console.warn("segment-one 请求失败（在线）", e); throw e; }
    }
    /* 本地模拟：假延时后原图返回 */
    await new Promise(r => setTimeout(r, 1800));
    return { item: { image, category: target?.category || "上衣", name: target?.description || "我的单品" }, mock: true };
  },

  /* 拆图上传编排：识别 → 逐件生成（限并发 2，防 DashScope 限流；服务端另有退避重试）。
     ui 回调：onDetected(targets) / onItemDone(i, item) / onItemFail(i, err)
     detect 失败直接上抛由页面提示；单件失败只回调 onItemFail，页面给该卡片"重试" */
  async splitUpload(image, ui) {
    const targets = (await this.detect(image)).items;
    ui.onDetected(targets);
    let next = 0;
    const worker = async () => {
      while (next < targets.length) {
        const i = next++;
        try {
          const r = await this.segmentOne(image, targets[i]);
          ui.onItemDone(i, r.item);
        } catch (e) {
          ui.onItemFail(i, e);
        }
      }
    };
    await Promise.all([worker(), worker()]);
  },

  /* ---------- ② 虚拟试穿 ----------
     返回 { image } —— image 为 null 时由页面用本地叠图合成兜底 */
  async tryon(modelImage, items) {
    if (await this.available()) {
      try {
        return await this._post("/api/tryon", { modelImage, items }, 240000);
      } catch (e) {
        /* 后端在线但本次请求失败（网络闪断/服务重启/5xx）＝真失败，
           不带 mock——mock 只标记"无密钥/后端不在线"的预期降级 */
        console.warn("tryon 请求失败（在线）", e);
        return { image: null };
      }
    }
    return { image: null, mock: true };
  },

  /* ---------- ③ 搭配推荐 ---------- */
  async recommend(wardrobe, around = null) {
    const payload = {
      wardrobe: wardrobe.map(i => ({
        id: i.id, category: i.cat, custom: !!i.dataUrl,
        name: i.name || "", labels: i.labels || null,
        gender: i.gender || null,
      })),
      around,
    };
    if (await this.available()) {
      try {
        const r = await this._post("/api/recommend", payload);
        if (r && Array.isArray(r.items) && r.items.length) return r;
      } catch (e) { console.warn("recommend 后端失败，走本地模拟", e); }
    }
    /* 本地模拟：与后端 recommend.js 的 ruleMatch 同口径——
       有锚点单品时按它的性别过滤（系统款不跨性别混搭），无锚点才用偏好；
       用户自己上传的衣服（dataUrl）不限性别；组套后做成套校验，缺件不算一套 */
    const pick = list => list[Math.floor(Math.random() * list.length)];
    const it = around ? wardrobe.find(i => i.id === around) : null;
    const genders = it && it.gender ? new Set([it.gender]) : prefGenders();
    const byCat = (cat, ex) => {
      const pool = wardrobe.filter(i => i.cat === cat && i.id !== ex
        && (i.dataUrl || !i.gender || genders.has(i.gender)));
      const mine = pool.filter(i => i.dataUrl);
      const list = mine.length ? mine : pool;
      return list.length ? pick(list).id : null;
    };
    let items;
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
    items = items.filter(Boolean);
    /* 成套校验（与后端 isComplete 同口径）：上衣+下装+鞋子 或 连体裙+鞋子 */
    const cats = items.map(id => (wardrobe.find(i => i.id === id) || {}).cat);
    const complete = cats.includes("鞋子")
      && (cats.includes("连体裙") || (cats.includes("上衣") && cats.includes("下装")));
    return { items: complete ? items : [], mock: true };
  },
};
