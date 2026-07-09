/* ============================================================
   拆图 A/B 测试脚本（一次性测试工具，不接入生产流程）
   ------------------------------------------------------------
   在同一张模特图、同一套流程下，对比两个生图模型的拆分质量与成本：
     · gemini-3.1-flash-image (Nano Banana 2) · OpenRouter
     · qwen-image-edit                        · 阿里云百炼(DashScope)

   流程：识图(qwen3-vl) → 每个单品并行调两个生图模型 → 各自打标签 → 出报告

   跑法：
     cd server
     node tools/test-split.js "/绝对路径/模特图.jpg"
   产出（server/tools/split-test-output/）：
     src.*                    原图
     <类别>-gemini.png        gemini 生成的单品平铺图
     <类别>-qwen.png          qwen 生成的单品平铺图
     report.html              对比报告（识图结果 / 并排图 / 标签 / 成本表 / 耗时）
   ============================================================ */

const fs = require("fs");
const path = require("path");
const { OPENROUTER_API_KEY, DASHSCOPE_API_KEY, MODELS } = require("../ai/config");
const { DETECT_PROMPT, TAG_PROMPT, mapScene } = require("../ai/prompts");
const { parseJson } = require("../ai/openrouter");

/* ---------- 每类的生图提示词（用户提供） ---------- */
const GEN_PROMPTS = {
  "上衣": "请帮我把这件这张图片上模特上身穿的上衣单件拆出来，单独生成一张平铺图。要求保留材质细节、版型、颜色、样式都与原图保持一致。如果有被其他位置遮挡的，请自动补全。",
  "下装": "请帮我把这件这张图片模特下身穿的裤子/裙子单件拆出来，单独生成一张平铺图。要求保留材质细节、版型、颜色、样式都与原图保持一致。如果有被其他位置遮挡的，请自动补全。",
  "鞋子": "请帮我把这件这张图片上模特脚上穿的鞋子单件拆出来，单独生成一张平铺图，正面或侧面展示。要求保留材质细节、版型、颜色、样式都与原图保持一致。如果有被其他位置遮挡的，请自动补全。",
  "连体裙": "请帮我把这件这张图片上模特身上穿的连体装单件拆出来，单独生成一张平铺图，正面展示。要求保留材质细节、版型、颜色、样式都与原图保持一致。如果有被其他位置遮挡的，请自动补全。",
};

/* ---------- 计价常量（可改；gemini 按 token，qwen 按张数） ---------- */
const RATE = {
  vlIn: 0.13 / 1e6,        // qwen3-vl 输入  $/token
  vlOut: 0.52 / 1e6,       // qwen3-vl 输出  $/token
  gemIn: 0.50 / 1e6,       // gemini-image 输入 $/token
  gemOut: 3.0 / 1e6,       // gemini-image 输出 $/token（生成图折算进 completion_tokens）
  qwenPerImageCNY: 0.14,   // qwen-image-edit 每张单价（元）—— ⚠️占位估算，以百炼控制台为准
  usdToCny: 7.2,
};

const OUT_DIR = path.join(__dirname, "split-test-output");

/* ---------- 基础工具 ---------- */
function fileToDataUrl(p) {
  const buf = fs.readFileSync(p);
  const ext = path.extname(p).slice(1).toLowerCase();
  const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  return `data:${mime};base64,${buf.toString("base64")}`;
}
function saveDataUrl(dataUrl, filePath) {
  const i = dataUrl.indexOf(",");
  fs.writeFileSync(filePath, Buffer.from(dataUrl.slice(i + 1), "base64"));
}
async function urlToDataUrl(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("下载生成图失败 HTTP " + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  const mime = r.headers.get("content-type") || "image/png";
  return `data:${mime};base64,${buf.toString("base64")}`;
}
const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* ---------- 模型调用（各自捕获 usage 用于成本） ---------- */
async function orChat(model, prompt, imageDataUrl, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json", "HTTP-Referer": "http://localhost:8394", "X-Title": "ai-wardrobe-test" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: imageDataUrl } }, { type: "text", text: prompt }] }] }),
      signal: ctrl.signal,
    });
    const data = await resp.json();
    if (!resp.ok || data.error) throw new Error(`OpenRouter ${model}: ${data.error?.message || resp.status}`);
    return { text: data.choices?.[0]?.message?.content || "", usage: data.usage || null };
  } finally { clearTimeout(timer); }
}
async function genGemini(prompt, imageDataUrl, timeoutMs = 180000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json", "HTTP-Referer": "http://localhost:8394", "X-Title": "ai-wardrobe-test" },
      body: JSON.stringify({ model: MODELS.flatImage, modalities: ["image", "text"], messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: imageDataUrl } }, { type: "text", text: prompt }] }] }),
      signal: ctrl.signal,
    });
    const data = await resp.json();
    if (!resp.ok || data.error) throw new Error(`gemini: ${data.error?.message || resp.status}`);
    const img = data.choices?.[0]?.message?.images?.[0]?.image_url?.url;
    if (!img) throw new Error("gemini 未返回图片");
    return { image: img, usage: data.usage || null };
  } finally { clearTimeout(timer); }
}
async function genQwenOnce(prompt, imageDataUrl, timeoutMs = 180000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch("https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation", {
      method: "POST",
      headers: { Authorization: `Bearer ${DASHSCOPE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen-image-edit",
        input: { messages: [{ role: "user", content: [{ image: imageDataUrl }, { text: prompt }] }] },
        parameters: { n: 1, watermark: false, prompt_extend: false },
      }),
      signal: ctrl.signal,
    });
    const data = await resp.json();
    if (!resp.ok || data.code) throw new Error(`qwen-image-edit: ${data.code || resp.status} ${data.message || ""}`);
    const img = data.output?.choices?.[0]?.message?.content?.find(c => c.image)?.image;
    if (!img) throw new Error("qwen-image-edit 未返回图片: " + JSON.stringify(data).slice(0, 200));
    return { url: img, usage: data.usage || null };
  } finally { clearTimeout(timer); }
}
/* 遇限流(Throttling)自动退避重试，最多 3 次，让并发下也能公平出图 */
async function genQwen(prompt, imageDataUrl) {
  for (let i = 0; i < 3; i++) {
    try { return await genQwenOnce(prompt, imageDataUrl); }
    catch (e) {
      if (i < 2 && /Throttling|rate limit/i.test(e.message)) {
        await new Promise(r => setTimeout(r, 5000 * (i + 1)));
        continue;
      }
      throw e;
    }
  }
}
async function tag(imageDataUrl) {
  const { text, usage } = await orChat(MODELS.vision, TAG_PROMPT, imageDataUrl, 45000);
  let labels = null;
  try {
    const raw = parseJson(text);
    labels = { 类别: raw["类别"], 颜色: raw["颜色"], 场景: mapScene(raw["适用场景"]), 风格: raw["风格"], 置信度: raw["置信度"] };
  } catch { /* 标签解析失败留 null */ }
  return { labels, usage };
}

/* ---------- 主流程 ---------- */
(async () => {
  const srcPath = process.argv[2];
  if (!srcPath) { console.error("用法: node tools/test-split.js \"/绝对路径/模特图.jpg\""); process.exit(1); }
  if (!fs.existsSync(srcPath)) { console.error("找不到图片: " + srcPath); process.exit(1); }
  if (!OPENROUTER_API_KEY) { console.error("缺少 OPENROUTER_API_KEY（server/.env）"); process.exit(1); }
  if (!DASHSCOPE_API_KEY) { console.error("缺少 DASHSCOPE_API_KEY（server/.env）"); process.exit(1); }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const src = fileToDataUrl(srcPath);
  const srcExt = path.extname(srcPath).slice(1).toLowerCase() || "jpg";
  saveDataUrl(src, path.join(OUT_DIR, "src." + srcExt));
  const cost = { detect: null, geminiUsage: [], qwenUsage: [], tagUsage: [] };

  /* 1. 识图 */
  console.log("① 识图中…");
  const t0 = Date.now();
  const detResp = await orChat(MODELS.vision, DETECT_PROMPT, src, 60000);
  cost.detect = detResp.usage;
  let detected = [];
  try { detected = (parseJson(detResp.text).items || []).filter(d => GEN_PROMPTS[d.category]); } catch {}
  if (!detected.length) { console.error("识图未返回可用单品，原文:\n" + detResp.text); process.exit(1); }
  const detectMs = Date.now() - t0;
  console.log("   识别到:", detected.map(d => d.category).join(" / "), `(${detectMs}ms)`);

  /* 2. 每个单品并行调两个模型；每张生成图各自打标签 */
  const rows = await Promise.all(detected.map(async (item) => {
    const prompt = GEN_PROMPTS[item.category];
    const row = { item, gemini: {}, qwen: {} };

    const runGemini = (async () => {
      const s = Date.now();
      const r = await genGemini(prompt, src);
      row.gemini.ms = Date.now() - s;
      cost.geminiUsage.push(r.usage);
      const file = `${item.category}-gemini.png`;
      saveDataUrl(r.image, path.join(OUT_DIR, file));
      row.gemini.file = file;
      const tg = await tag(r.image); row.gemini.labels = tg.labels; cost.tagUsage.push(tg.usage);
    })().catch(e => { row.gemini.error = e.message; });

    const runQwen = (async () => {
      const s = Date.now();
      const r = await genQwen(prompt, src);
      row.qwen.ms = Date.now() - s;
      cost.qwenUsage.push(r.usage);
      const dataUrl = await urlToDataUrl(r.url);
      const file = `${item.category}-qwen.png`;
      saveDataUrl(dataUrl, path.join(OUT_DIR, file));
      row.qwen.file = file;
      const tg = await tag(dataUrl); row.qwen.labels = tg.labels; cost.tagUsage.push(tg.usage);
    })().catch(e => { row.qwen.error = e.message; });

    await Promise.allSettled([runGemini, runQwen]);
    console.log(`② ${item.category} 完成  gemini:${row.gemini.file ? row.gemini.ms + "ms" : "失败"}  qwen:${row.qwen.file ? row.qwen.ms + "ms" : "失败"}`);
    return row;
  }));

  /* 3. 成本汇总 */
  const sumTok = arr => arr.reduce((a, u) => ({ in: a.in + (u?.prompt_tokens || 0), out: a.out + (u?.completion_tokens || 0) }), { in: 0, out: 0 });
  const detTok = { in: cost.detect?.prompt_tokens || 0, out: cost.detect?.completion_tokens || 0 };
  const gemTok = sumTok(cost.geminiUsage);
  const tagTok = sumTok(cost.tagUsage);
  const qwenImgs = cost.qwenUsage.reduce((a, u) => a + (u?.image_count || 1), 0);
  // 识图 + 打标签 都算 qwen3-vl；两条流水线共用识图，标签各自产生（这里合计后按占比展示）
  const usd = t => t.in * RATE.vlIn + t.out * RATE.vlOut;
  const geminiPipelineUSD = detTok.in * RATE.vlIn + detTok.out * RATE.vlOut
    + gemTok.in * RATE.gemIn + gemTok.out * RATE.gemOut
    + usd({ in: tagTok.in / 2, out: tagTok.out / 2 });   // 标签总量的一半归 gemini 侧
  const qwenPipelineUSD = detTok.in * RATE.vlIn + detTok.out * RATE.vlOut
    + usd({ in: tagTok.in / 2, out: tagTok.out / 2 })
    + qwenImgs * RATE.qwenPerImageCNY / RATE.usdToCny;
  const cny = u => (u * RATE.usdToCny).toFixed(4);

  /* 4. 生成报告 */
  const rowHtml = rows.map(r => {
    const cell = (m, side) => m.file
      ? `<img src="${m.file}"><div class="tags">${m.labels ? Object.entries(m.labels).map(([k, v]) => `<span>${esc(k)}:${esc(v)}</span>`).join("") : "（打标签失败）"}</div><div class="ms">${m.ms}ms</div>`
      : `<div class="err">生成失败：${esc(m.error)}</div>`;
    return `<tr>
      <td class="cat">${esc(r.item.category)}<div class="desc">${esc(r.item.description || "")}</div></td>
      <td>${cell(r.gemini, "gemini")}</td>
      <td>${cell(r.qwen, "qwen")}</td>
    </tr>`;
  }).join("");

  const html = `<!doctype html><meta charset="utf-8"><title>拆图 A/B 对比</title>
<style>
  body{font-family:-apple-system,system-ui,sans-serif;margin:0;padding:24px;background:#f5f5f4;color:#18181b}
  h1{font-size:22px}h2{font-size:16px;margin-top:28px}
  .src{max-width:280px;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.12)}
  .det{background:#fff;border-radius:10px;padding:12px 16px;font-size:13px;line-height:1.9;margin:12px 0}
  table{border-collapse:collapse;width:100%;background:#fff;border-radius:12px;overflow:hidden}
  th,td{border:1px solid #ececec;padding:12px;vertical-align:top;text-align:center}
  th{background:#fafafa;font-size:14px}
  td.cat{font-weight:700;font-size:15px;width:88px}
  td.cat .desc{font-weight:400;color:#888;font-size:12px;margin-top:4px}
  td img{width:100%;max-width:230px;border-radius:8px;background:#fff}
  .tags{margin-top:8px;display:flex;flex-wrap:wrap;gap:4px;justify-content:center}
  .tags span{background:#f0f0ef;border-radius:6px;padding:2px 7px;font-size:11px}
  .ms{color:#aaa;font-size:11px;margin-top:6px}
  .err{color:#c0392b;font-size:12px;padding:20px}
  .cost{background:#fff;border-radius:12px;overflow:hidden;max-width:560px}
  .cost td.h{text-align:left;font-weight:600}
  .note{color:#999;font-size:12px;margin-top:8px}
</style>
<h1>拆图 A/B 对比：gemini-3.1-flash-image vs qwen-image-edit</h1>
<h2>① 原图</h2>
<img class="src" src="src.${srcExt}">
<h2>② 识图结果（${MODELS.vision}）</h2>
<div class="det">检测到 ${detected.length} 件：${detected.map(d => `<b>${esc(d.category)}</b>（${esc(d.description || "")}）`).join("、")}<br>耗时 ${detectMs}ms</div>
<h2>③ 生成单品 + 标签对比</h2>
<table><tr><th>类别 / 识图描述</th><th>gemini-3.1-flash-image</th><th>qwen-image-edit</th></tr>${rowHtml}</table>
<h2>④ 成本对比（本次一张模特图）</h2>
<table class="cost">
  <tr><th>流水线</th><th>生图</th><th>识图+标签</th><th>合计</th></tr>
  <tr><td class="h">gemini 侧</td><td>${gemTok.in}/${gemTok.out} tok</td><td>vl 调用</td><td><b>¥${cny(geminiPipelineUSD)}</b>（$${geminiPipelineUSD.toFixed(4)}）</td></tr>
  <tr><td class="h">qwen 侧</td><td>${qwenImgs} 张 ×¥${RATE.qwenPerImageCNY}</td><td>vl 调用</td><td><b>¥${cny(qwenPipelineUSD)}</b>（$${qwenPipelineUSD.toFixed(4)}）</td></tr>
</table>
<div class="note">· gemini 成本按真实 token 精算；qwen 成本 = 实际生成张数 × 占位单价 ¥${RATE.qwenPerImageCNY}/张（⚠️ 请以百炼控制台实际单价校正 RATE.qwenPerImageCNY）<br>· 识图与打标签用 qwen3-vl，费用为“厘”级，两侧近似均摊</div>`;

  fs.writeFileSync(path.join(OUT_DIR, "report.html"), html);
  console.log("\n③ 报告已生成 → server/tools/split-test-output/report.html");
  console.log(`   成本估算：gemini 侧 ¥${cny(geminiPipelineUSD)} ｜ qwen 侧 ¥${cny(qwenPipelineUSD)}`);
})().catch(e => { console.error("测试失败:", e); process.exit(1); });
