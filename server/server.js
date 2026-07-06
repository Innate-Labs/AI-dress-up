/* ============================================================
   AI穿搭助手 · 轻量后端
   职责：1) 托管前端页面  2) 提供三个 AI 能力接口
   三个 AI 能力都在 server/ai/ 目录里，每个能力一个文件，
   现在是占位实现，后续把选定的模型 API 填进对应文件即可，
   前端一行代码都不用改。
   启动：cd server && npm install && npm start
   访问：http://localhost:8394/login.html
   ============================================================ */

const express = require("express");
const path = require("path");

const segment = require("./ai/segment");
const tryon = require("./ai/tryon");
const recommend = require("./ai/recommend");
const validate = require("./ai/validate");

const app = express();
const PORT = process.env.PORT || 8394;

/* 图片以 base64 传输，放宽请求体上限 */
app.use(express.json({ limit: "30mb" }));

/* ---------- AI 能力接口 ---------- */

/* 健康检查：前端用它判断后端是否在线 */
app.get("/api/health", (req, res) => res.json({ ok: true }));

/* 照片质检：创建模特前判断照片是否合格 */
app.post("/api/validate-photo", async (req, res) => {
  try {
    res.json(await validate(req.body));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* 抠图：上传衣服照片 → 返回抠好图的衣服 */
app.post("/api/segment", async (req, res) => {
  try {
    res.json(await segment(req.body));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* 试穿：模特照片 + 衣服列表 → 返回上身效果 */
app.post("/api/tryon", async (req, res) => {
  try {
    res.json(await tryon(req.body));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* 搭配推荐：衣橱清单（可指定围绕某件单品）→ 返回一套搭配 */
app.post("/api/recommend", async (req, res) => {
  try {
    res.json(await recommend(req.body));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------- 托管前端静态页面（项目根目录） ----------
   开发期禁用浏览器缓存：每次刷新都拿最新文件，避免手机看到旧版 */
app.use(express.static(path.join(__dirname, ".."), {
  setHeaders: (res) => res.setHeader("Cache-Control", "no-cache, must-revalidate"),
}));

app.listen(PORT, () => {
  console.log(`AI穿搭助手已启动 → http://localhost:${PORT}/login.html`);
  console.log(`手机访问：同一 Wi-Fi 下用「电脑IP:${PORT}/login.html」`);
});
