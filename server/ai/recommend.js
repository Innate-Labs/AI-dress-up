/* ============================================================
   AI 能力 ③：搭配推荐（recommend）
   ------------------------------------------------------------
   输入 req：{ wardrobe: [ { id, category, custom, name, labels } ],
               around: "id" | null }                围绕某件单品搭配
   输出    ：{ items: [ "id", ... ], reason: "搭配理由" }

   当前模型：OpenRouter · qwen3.6-flash（读衣橱标签做选择），见 config.js MODELS.recommend
   模型失败或没配密钥时自动回退规则搭配。
   替换模型：改 config.js 的 MODELS.recommend；提示词在 prompts.js 的 recommendPrompt
   ============================================================ */

const { OPENROUTER_API_KEY, MODELS } = require("./config");
const { chat, parseJson } = require("./openrouter");
const { recommendPrompt } = require("./prompts");

const pick = (list) => list[Math.floor(Math.random() * list.length)];

/* 规则搭配（兜底）：同分类优先用户上传的衣服 */
function ruleMatch(wardrobe, aroundId) {
  const byCat = (cat, excludeId) => {
    const pool = wardrobe.filter((i) => i.category === cat && i.id !== excludeId);
    const mine = pool.filter((i) => i.custom);
    const list = mine.length ? mine : pool;
    return list.length ? pick(list).id : null;
  };
  let items;
  const around = aroundId ? wardrobe.find((i) => i.id === aroundId) : null;
  if (around) {
    const need = {
      上衣: ["下装", "鞋子"],
      下装: ["上衣", "鞋子"],
      连体裙: ["鞋子"],
      鞋子: Math.random() > 0.3 ? ["上衣", "下装"] : ["连体裙"],
    }[around.category] || [];
    items = [around.id, ...need.map((c) => byCat(c, around.id))];
  } else {
    items = Math.random() > 0.3
      ? [byCat("上衣"), byCat("下装"), byCat("鞋子")]
      : [byCat("连体裙"), byCat("鞋子")];
  }
  return { items: items.filter(Boolean), reason: "" };
}

module.exports = async function recommend(req) {
  const wardrobe = (req && req.wardrobe) || [];
  if (!wardrobe.length) return { items: [] };
  const around = req.around || null;

  if (!OPENROUTER_API_KEY) return { ...ruleMatch(wardrobe, around), mock: true };

  try {
    const text = await chat(MODELS.recommend, [
      { role: "user", content: recommendPrompt(wardrobe, around) },
    ], { timeoutMs: 30000 });
    const r = parseJson(text);

    /* 校验模型输出：id 必须存在；围绕单品必须包含；分类组合必须成套 */
    const valid = new Set(wardrobe.map((i) => i.id));
    let items = (r.items || []).filter((id) => valid.has(id));
    const cats = items.map((id) => wardrobe.find((i) => i.id === id).category);
    const complete =
      (cats.includes("连体裙") && cats.includes("鞋子")) ||
      (cats.includes("上衣") && cats.includes("下装"));
    if (!items.length || !complete || (around && !items.includes(around))) {
      throw new Error("模型输出不成套，走规则兜底");
    }
    return { items, reason: r.reason || "" };
  } catch (e) {
    console.warn("搭配推荐模型失败，规则兜底:", e.message);
    return ruleMatch(wardrobe, around);
  }
};
