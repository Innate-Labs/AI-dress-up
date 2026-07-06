/* OpenRouter 调用助手：视觉对话 + 图像生成 + 严格 JSON 解析 */

const { OPENROUTER_API_KEY } = require("./config");

const API = "https://openrouter.ai/api/v1/chat/completions";

function headers() {
  return {
    "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "http://localhost:8394",
    "X-Title": "ai-wardrobe",
  };
}

/* 组装 图片+文字 消息内容 */
function imageMessage(text, imageDataUrl) {
  return [{
    role: "user",
    content: [
      { type: "image_url", image_url: { url: imageDataUrl } },
      { type: "text", text },
    ],
  }];
}

/* 视觉/文本对话，返回文本 */
async function chat(model, messages, { timeoutMs = 60000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(API, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ model, messages }),
      signal: ctrl.signal,
    });
    const data = await resp.json();
    if (!resp.ok || data.error) {
      throw new Error(`OpenRouter ${model}: ${data.error?.message || resp.status}`);
    }
    return data.choices?.[0]?.message?.content || "";
  } finally {
    clearTimeout(timer);
  }
}

/* 图像生成（参考图 + 提示词 → 一张图的 dataURL） */
async function generateImage(model, prompt, refImageDataUrl, { timeoutMs = 120000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(API, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model,
        modalities: ["image", "text"],
        messages: imageMessage(prompt, refImageDataUrl),
      }),
      signal: ctrl.signal,
    });
    const data = await resp.json();
    if (!resp.ok || data.error) {
      throw new Error(`OpenRouter ${model}: ${data.error?.message || resp.status}`);
    }
    const msg = data.choices?.[0]?.message || {};
    const img = msg.images?.[0]?.image_url?.url || null;
    if (!img) throw new Error(`OpenRouter ${model}: 未返回图片`);
    return img;   // data:image/...;base64,...
  } finally {
    clearTimeout(timer);
  }
}

/* 模型输出 → JSON（剥掉```围栏、替换中文弯引号后解析） */
function parseJson(text) {
  let t = String(text || "").trim();
  t = t.replace(/^```(json)?/i, "").replace(/```$/,"").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  t = t.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  return JSON.parse(t);
}

module.exports = { chat, generateImage, imageMessage, parseJson };
