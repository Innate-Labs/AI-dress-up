/* ============================================================
   AI 能力 ①：衣物识别 / 平铺图 / 自动标签（segment）
   ------------------------------------------------------------
   输入 req：{ image: "data:image/jpeg;base64,..." }   衣服照片或人物穿搭照
   输出    ：{
     image: 首件单品的图,                       // 兼容旧前端
     items: [{
       image: "data:image/...",                // 平铺图（生成失败时为原图）
       category: "上衣|下装|鞋子|连体裙",       // 已映射产品四大分类
       name: "颜色+细分类，如 白色T恤",
       labels: { 类别, 颜色, 适用场景, 风格, 置信度 },   // 场景已映射（不确定→其他）
     }],
   }

   流程（对应提示词库的模型2两步 + 模型3）：
   1. 识别图中有哪些单品（Qwen3-VL · DETECT_PROMPT）
   2. 逐件生成白底平铺图（qwen-image-edit · flatImagePrompt，走 DashScope 百炼），失败用原图兜底
   3. 逐件打标签（Qwen3-VL · TAG_PROMPT），细分类映射到四大分类

   除整体 segment 外另拆两个分步导出（前端"卡片进度"用，见 /api/detect、/api/segment-one）：
   - detect({image})              → { items: [{ category, description }] }   只做第1步，快
   - segmentOne({image, target})  → { item: { image, category, name, labels } }   对一件做第2+3步
   前端流程：detect 先铺占位卡片 → 逐件 segmentOne（限并发2防 DashScope 限流）点亮卡片

   替换模型：识别/标签改 config.js 的 MODELS.vision；平铺图改 MODELS.flatImage
   （注意平铺图现在走 DashScope，非 OpenRouter；换回 OpenRouter 图像模型需改本文件 qwenImageEdit）
   ============================================================ */

const { OPENROUTER_API_KEY, DASHSCOPE_API_KEY, DASHSCOPE_API_BASE, MODELS } = require("./config");
const { chat, imageMessage, parseJson } = require("./openrouter");
const { DETECT_PROMPT, flatImagePrompt, TAG_PROMPT, CAT_MAP, mapScene } = require("./prompts");

/* qwen-image-edit（DashScope 百炼）：参考图 + 指令 → 单品平铺图 dataURL。
   同步接口；遇限流(Throttling)退避重试最多3次；返回URL仅24h有效，需下载转 base64 持久化。
   域名走 config 的 DASHSCOPE_API_BASE（业务空间密钥须配专属域名） */
const DASHSCOPE_IMG_API = `${DASHSCOPE_API_BASE}/api/v1/services/aigc/multimodal-generation/generation`;
/* 带超时的 fetch：避免 DashScope 卡住时请求永久挂起 */
async function fetchT(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}
async function qwenImageEdit(prompt, imageDataUrl) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let data;
    try {
      const resp = await fetchT(DASHSCOPE_IMG_API, {
        method: "POST",
        headers: { Authorization: `Bearer ${DASHSCOPE_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODELS.flatImage,
          input: { messages: [{ role: "user", content: [{ image: imageDataUrl }, { text: prompt }] }] },
          parameters: { n: 1, watermark: false, prompt_extend: false },
        }),
      }, 120000);
      data = await resp.json();
      if (!resp.ok || data.code) throw new Error(`qwen-image-edit: ${data.code || resp.status} ${data.message || ""}`);
    } catch (e) {
      if (attempt < 2 && /Throttling|rate limit/i.test(e.message)) {
        await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
        continue;
      }
      throw e;
    }
    const url = data.output?.choices?.[0]?.message?.content?.find((c) => c.image)?.image;
    if (!url) throw new Error("qwen-image-edit 未返回图片");
    const imgResp = await fetchT(url, {}, 30000);
    const arr = Buffer.from(await imgResp.arrayBuffer());
    const mime = imgResp.headers.get("content-type") || "image/png";
    return `data:${mime};base64,${arr.toString("base64")}`;
  }
  throw new Error("qwen-image-edit 限流重试后仍失败");
}

async function tagOne(image) {
  try {
    const text = await chat(MODELS.vision, imageMessage(TAG_PROMPT, image), { timeoutMs: 45000 });
    return parseJson(text);
  } catch (e) {
    console.warn("打标签失败（用备用模型重试）:", e.message);
    const text = await chat(MODELS.visionBackup, imageMessage(TAG_PROMPT, image), { timeoutMs: 45000 });
    return parseJson(text);
  }
}

/* 第 1 步单拆：识别图里有哪些单品（快，几秒）。
   前端拿它先铺占位卡片，再逐件调 segmentOne 点亮 */
async function detect(req) {
  if (!req || !req.image) throw new Error("缺少 image 参数");
  if (!OPENROUTER_API_KEY) return { items: [{ category: "上衣", description: "我的单品" }], mock: true };

  let detected = [];
  try {
    const text = await chat(MODELS.vision, imageMessage(DETECT_PROMPT, req.image), { timeoutMs: 60000 });
    detected = (parseJson(text).items || []).slice(0, 3);   // 最多处理3件，控制耗时与费用
  } catch (e) {
    console.warn("穿着识别失败:", e.message);
  }
  if (!detected.length) detected = [{ category: "上衣", description: "服装" }];
  return { items: detected };
}

/* 第 2+3 步单拆：对一件识别结果生成平铺图 + 打标签（慢，10–30 秒）。
   target = detect 返回的一项 { category, description }
   strict=true（拆图卡片流用）：有密钥但生成失败时直接抛错 →
   前端显示失败卡可重试，不再把原图当成品入橱（拆多件时兜底原图会一图三卡全重复）。
   没配密钥仍走原图兜底 = 纯演示模式。 */
async function segmentOne(req) {
  if (!req || !req.image) throw new Error("缺少 image 参数");
  const d = req.target || { category: "上衣", description: "服装" };

  if (!OPENROUTER_API_KEY) {
    return { item: { image: req.image, category: "上衣", name: d.description || "我的单品" }, mock: true };
  }

  let flat = null;
  if (DASHSCOPE_API_KEY) {
    try {
      flat = await qwenImageEdit(flatImagePrompt(d.category), req.image);
    } catch (e) {
      console.warn(`平铺图生成失败（${d.category}）:`, e.message);
      if (req.strict) throw new Error(`平铺图生成失败：${e.message}`);
    }
  }
  const img = flat || req.image;

  let labels = null;
  try {
    const raw = await tagOne(img);
    labels = {
      "类别": raw["类别"] || "不确定",
      "颜色": raw["颜色"] || "不确定",
      "适用场景": mapScene(raw["适用场景"]),
      "风格": raw["风格"] || "不确定",
      "置信度": raw["置信度"] || "低",
    };
  } catch (e) {
    console.warn("打标签最终失败:", e.message);
  }

  const cat = (labels && CAT_MAP[labels["类别"]]) || CAT_MAP[d.category] || d.category || "上衣";
  const name = labels && labels["颜色"] !== "不确定" && labels["类别"] !== "不确定"
    ? `${labels["颜色"]}${labels["类别"]}`
    : (d.description || "我的单品");

  return { item: { image: img, category: ["上衣","下装","鞋子","连体裙"].includes(cat) ? cat : "上衣", name, labels } };
}

/* 旧契约保留：一次调用完成 识别→逐件平铺→标签（内部并行3件） */
async function segment(req) {
  if (!req || !req.image) throw new Error("缺少 image 参数");

  /* 没配密钥 → 占位行为：原图直接返回 */
  if (!OPENROUTER_API_KEY) {
    return { image: req.image, items: [{ image: req.image, category: "上衣", name: "我的单品" }], mock: true };
  }

  const detected = (await detect(req)).items;
  const items = (await Promise.all(detected.map(d => segmentOne({ image: req.image, target: d }))))
    .map(r => r.item);
  return { image: items[0].image, items };
}

module.exports = segment;
module.exports.detect = detect;
module.exports.segmentOne = segmentOne;
