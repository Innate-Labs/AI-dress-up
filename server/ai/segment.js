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
   2. 逐件生成白底平铺图（GPT Image · flatImagePrompt），失败用原图兜底
   3. 逐件打标签（Qwen3-VL · TAG_PROMPT），细分类映射到四大分类

   替换模型：改 config.js 的 MODELS.vision / MODELS.flatImage
   ============================================================ */

const { OPENROUTER_API_KEY, MODELS } = require("./config");
const { chat, generateImage, imageMessage, parseJson } = require("./openrouter");
const {
  DETECT_PROMPT,
  flatImagePrompt,
  flatQcPrompt,
  repairFlatImagePrompt,
  TAG_PROMPT,
  CAT_MAP,
  mapScene,
} = require("./prompts");

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

async function checkFlat(image, category) {
  try {
    const text = await chat(MODELS.vision, imageMessage(flatQcPrompt(category), image), { timeoutMs: 45000 });
    const r = parseJson(text);
    return {
      pass: !!r.pass,
      reason: r.primary_reason || (r.fail_reasons || []).join("、") || r.short_observation || "",
    };
  } catch (e) {
    console.warn("平铺图质检失败（放行生成图）:", e.message);
    return { pass: true, reason: "" };
  }
}

async function generateCleanFlat(reqImage, detected) {
  const category = detected.category || "服装";
  const description = detected.description || "";

  const first = await generateImage(MODELS.flatImage, flatImagePrompt(category, description), reqImage);
  const qc = await checkFlat(first, category);
  if (qc.pass) return first;

  console.warn(`平铺图质检不通过（${category}），重试生成:`, qc.reason || "未知原因");
  try {
    const retry = await generateImage(
      MODELS.flatImage,
      repairFlatImagePrompt(category, description, qc.reason),
      reqImage
    );
    const retryQc = await checkFlat(retry, category);
    if (!retryQc.pass) {
      console.warn(`平铺图重试后仍不理想（${category}）:`, retryQc.reason || "未知原因");
    }
    return retry;
  } catch (e) {
    console.warn(`平铺图重试失败（${category}），使用第一次生成结果:`, e.message);
    return first;
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
    try {
      flat = await generateCleanFlat(req.image, d);
    } catch (e) {
      console.warn(`平铺图生成失败（${d.category}），用原图兜底:`, e.message);
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
