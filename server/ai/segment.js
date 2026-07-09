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

   替换模型：识别/标签改 config.js 的 MODELS.vision；平铺图改 MODELS.flatImage
   （注意平铺图现在走 DashScope，非 OpenRouter；换回 OpenRouter 图像模型需改本文件 qwenImageEdit）
   ============================================================ */

const { OPENROUTER_API_KEY, DASHSCOPE_API_KEY, MODELS } = require("./config");
const { chat, imageMessage, parseJson } = require("./openrouter");
const { DETECT_PROMPT, flatImagePrompt, TAG_PROMPT, CAT_MAP, mapScene } = require("./prompts");

/* qwen-image-edit（DashScope 百炼）：参考图 + 指令 → 单品平铺图 dataURL。
   同步接口；遇限流(Throttling)退避重试最多3次；返回URL仅24h有效，需下载转 base64 持久化。 */
const DASHSCOPE_IMG_API = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
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

module.exports = async function segment(req) {
  if (!req || !req.image) throw new Error("缺少 image 参数");

  /* 没配密钥 → 占位行为：原图直接返回 */
  if (!OPENROUTER_API_KEY) {
    return { image: req.image, items: [{ image: req.image, category: "上衣", name: "我的单品" }], mock: true };
  }

  /* 1. 识别有哪些单品 */
  let detected = [];
  try {
    const text = await chat(MODELS.vision, imageMessage(DETECT_PROMPT, req.image), { timeoutMs: 60000 });
    detected = (parseJson(text).items || []).slice(0, 3);   // 最多处理3件，控制耗时
  } catch (e) {
    console.warn("穿着识别失败:", e.message);
  }
  if (!detected.length) detected = [{ category: "上衣", description: "服装" }];

  /* 2+3. 逐件：平铺图 + 标签（并行处理省时间） */
  const items = await Promise.all(detected.map(async (d) => {
    let flat = null;
    if (DASHSCOPE_API_KEY) {
      try {
        flat = await qwenImageEdit(flatImagePrompt(d.category), req.image);
      } catch (e) {
        console.warn(`平铺图生成失败（${d.category}），用原图兜底:`, e.message);
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

    return { image: img, category: ["上衣","下装","鞋子","连体裙"].includes(cat) ? cat : "上衣", name, labels };
  }));

  return { image: items[0].image, items };
};
