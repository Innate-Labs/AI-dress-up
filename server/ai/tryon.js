/* ============================================================
   AI 能力 ②：虚拟试穿（tryon）
   ------------------------------------------------------------
   输入 req：{ modelImage: "data:...;base64," | null,   模特照片（必须是真实图 dataURL）
               items: [ { id, category, image } ] }     要穿上身的衣服（含鞋子）
   输出    ：{ image: "data:...;base64," | null }       生成的上身效果照
             image=null 时前端自动用叠图兜底。

   当前模型：生图模型 google/gemini-3.1-flash-image（走 OpenRouter）
   做法：把 模特图 + 上衣/连体裙 + 下装 + 鞋子 一起喂给生图模型，一步生成整套上身图。
        与旧的 aitryon-plus 相比：鞋子也一起生成，默认模特照片同样可用。
   替换模型：改 config.js 的 MODELS.tryon；密钥用 server/.env 的 OPENROUTER_API_KEY
   ============================================================ */

const { OPENROUTER_API_KEY, MODELS } = require("./config");

const API = "https://openrouter.ai/api/v1/chat/completions";
const imgPart = (url) => ({ type: "image_url", image_url: { url } });

module.exports = async function tryon(req) {
  if (!req || !Array.isArray(req.items)) throw new Error("缺少 items 参数");

  const isReal = (img) => typeof img === "string" && img.startsWith("data:");

  /* 生成前提：有密钥 + 模特是真实照片。缺任一 → 预期降级（mock），前端走叠图演示模式；
     区别于下面 API 调用失败返回的 {image:null}——那是真失败，前端保持原画面并提示重试 */
  if (!OPENROUTER_API_KEY || !isReal(req.modelImage)) return { image: null, mock: true };

  /* 收集真实衣服图，按 上衣/连体裙 → 下装 → 鞋子 的顺序（与提示词里的序号对应） */
  const top = req.items.find((i) => isReal(i.image) && (i.category === "上衣" || i.category === "连体裙"));
  const bottom = req.items.find((i) => isReal(i.image) && i.category === "下装");
  const shoes = req.items.find((i) => isReal(i.image) && i.category === "鞋子");

  const garments = [];
  if (top) garments.push({ label: top.category === "连体裙" ? "连体裙" : "上衣", img: top.image });
  if (bottom && !(top && top.category === "连体裙")) garments.push({ label: "下装", img: bottom.image });
  if (shoes) garments.push({ label: "鞋子", img: shoes.image });
  if (!garments.length) return { image: null };   // 没有任何真实衣服图，不生成

  const listDesc = garments.map((g, i) => `第${i + 2}张是${g.label}`).join("，");
  const wearDesc = garments.map((g) => `这${g.label === "鞋子" ? "双" : "件"}${g.label}`).join("、");
  const prompt =
    `第1张是模特全身照。${listDesc}。` +
    `请生成一张这位模特同时穿着${wearDesc}的完整全身照。` +
    `要求：完整保留第1张模特本人的样貌、脸、发型、身材、姿势、站位、纯色背景和光线不变；` +
    `每件单品的颜色、版型、材质细节要忠实还原对应商品图；衣物自然贴合身体、透视和阴影正确，鞋子正确穿在脚上并与地面接触；` +
    `模特原有的衣服或任何被遮挡冲突的部位请自动合理补全，输出干净完整、照片级真实感的全身图片。`;

  const content = [imgPart(req.modelImage), ...garments.map((g) => imgPart(g.img)), { type: "text", text: prompt }];

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120000);
    let data;
    try {
      const resp = await fetch(API, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "http://localhost:8394",
          "X-Title": "ai-wardrobe",
        },
        body: JSON.stringify({ model: MODELS.tryon, modalities: ["image", "text"], messages: [{ role: "user", content }] }),
        signal: ctrl.signal,
      });
      data = await resp.json();
      if (!resp.ok || data.error) throw new Error(data.error?.message || `HTTP ${resp.status}`);
    } finally {
      clearTimeout(timer);
    }
    const img = data.choices?.[0]?.message?.images?.[0]?.image_url?.url;
    if (!img) throw new Error("模型未返回图片");
    return { image: img };   // data:image/...;base64,...
  } catch (e) {
    console.warn("试穿生成失败，回退叠图:", e.message);
    return { image: null };
  }
};
