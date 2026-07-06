/* ============================================================
   AI 能力 ⓪：上传照片质检（创建模特前的准入检测）
   ------------------------------------------------------------
   输入 req：{ image: "data:image/...;base64,..." }   用户上传的个人照片
   输出    ：{ pass, fail_reasons, primary_reason, confidence, short_observation }

   当前模型：OpenRouter · qwen3.6-flash（视觉版），见 config.js MODELS.qc
   替换模型：改 config.js 的 MODELS.qc 即可；提示词在 prompts.js
   ============================================================ */

const { OPENROUTER_API_KEY, MODELS } = require("./config");
const { chat, imageMessage, parseJson } = require("./openrouter");
const { QC_PROMPT } = require("./prompts");

module.exports = async function validate(req) {
  if (!req || !req.image) throw new Error("缺少 image 参数");

  /* 没配密钥时放行（本地演示模式） */
  if (!OPENROUTER_API_KEY) {
    return { pass: true, fail_reasons: [], primary_reason: "", confidence: 1, mock: true };
  }

  const text = await chat(MODELS.qc, imageMessage(QC_PROMPT, req.image), { timeoutMs: 45000 });
  let r;
  try {
    r = parseJson(text);
  } catch {
    /* 模型偶发输出不合法 JSON（描述文字里带引号等）：用正则兜底提取关键字段 */
    const pass = /"pass"\s*:\s*true/.test(text);
    const reason = (text.match(/"primary_reason"\s*:\s*"([^"]*)"/) || [])[1] || "";
    r = { pass, fail_reasons: reason ? [reason] : [], primary_reason: reason, confidence: 0.5 };
  }
  return {
    pass: !!r.pass,
    fail_reasons: r.fail_reasons || [],
    primary_reason: r.primary_reason || "",
    confidence: r.confidence ?? 0,
    short_observation: r.short_observation || "",
  };
};
