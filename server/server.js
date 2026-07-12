/* ============================================================
   美搭 · 轻量后端
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

/* 邮箱验证码登录（发码/登录，详见 server/auth.js） */
app.use(require("./auth").router);

/* 照片质检：创建模特前判断照片是否合格 */
app.post("/api/validate-photo", async (req, res) => {
  try {
    res.json(await validate(req.body));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* 抠图：上传衣服照片 → 返回抠好图的衣服（同步版，离线回退/兼容用） */
app.post("/api/segment", async (req, res) => {
  try {
    res.json(await segment(req.body));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* 拆图分步版（单件重试/离线兜底用）：先识别出清单，再逐件生成 */
app.post("/api/detect", async (req, res) => {
  try {
    res.json(await segment.detect(req.body));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post("/api/segment-one", async (req, res) => {
  try {
    res.json(await segment.segmentOne(req.body));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------- 拆分任务队列（上传拆分后台化 · 逐件粒度）----------
   提交即返回任务号，识别与逐件生成都在服务器继续跑，用户可离开页面；
   result 返回逐件状态（pending/running/done/fail）供前端进度卡渲染，
   单件失败可 retry；所有任务共享并发上限 2，防 DashScope 限流。
   内存版（符合本项目无数据库定位）：服务重启会丢任务（result 返回 missing）。 */
const segJobs = new Map();   // jobId -> { status:'detecting'|'running'|'error', ts, image, error?, targets:[{category,description,state,item?,error?}] }
let segJobSeq = 0;
const SEG_JOB_TTL = 30 * 60 * 1000;   // 尘埃落定的任务保留 30 分钟后清理
const SEG_CONCURRENCY = 2;            // 逐件生成全局并发上限
let segRunning = 0;
const segQueue = [];                  // 待生成单件：{ job, entry }

function cleanSegJobs() {
  const now = Date.now();
  for (const [id, job] of segJobs) {
    const active = job.status === "detecting"
      || (job.targets || []).some(t => t.state === "pending" || t.state === "running");
    if (!active && now - job.ts > SEG_JOB_TTL) segJobs.delete(id);
  }
}

function pumpSegQueue() {
  while (segRunning < SEG_CONCURRENCY && segQueue.length) {
    const { job, entry } = segQueue.shift();
    segRunning++;
    entry.state = "running";
    job.ts = Date.now();
    segment.segmentOne({
      image: job.image,
      target: { category: entry.category, description: entry.description },
      strict: true,   // 有密钥但生成失败→标 fail 给前端重试，不塞原图
    })
      .then((r) => { entry.state = "done"; entry.item = r.item; })
      .catch((e) => { entry.state = "fail"; entry.error = e.message; })
      .finally(() => { segRunning--; job.ts = Date.now(); pumpSegQueue(); });
  }
}

/* 提交拆分任务：立即返回 jobId；后台先识别，再逐件排队生成 */
app.post("/api/segment/start", (req, res) => {
  cleanSegJobs();
  const jobId = `seg_${Date.now()}_${++segJobSeq}`;
  const job = { status: "detecting", ts: Date.now(), image: req.body.image, targets: [] };
  segJobs.set(jobId, job);
  segment.detect(req.body)
    .then(({ items }) => {
      job.targets = items.map(t => ({ category: t.category, description: t.description, state: "pending" }));
      job.status = "running";
      job.ts = Date.now();
      job.targets.forEach(entry => segQueue.push({ job, entry }));
      pumpSegQueue();
    })
    .catch((e) => { job.status = "error"; job.error = e.message; job.ts = Date.now(); });
  res.json({ jobId });
});

/* 查询任务进度/结果：
   入参 got=[已取走的件下标]，对应件不再重复回传 base64（轮询省流量）。
   status: detecting / running / done(全部尘埃落定) / error(识别失败) / missing(服务重启丢失) */
app.post("/api/segment/result", (req, res) => {
  const job = segJobs.get(req.body.jobId);
  if (!job) return res.json({ status: "missing" });
  if (job.status === "error") return res.json({ status: "error", error: job.error });
  const got = new Set(req.body.got || []);
  const targets = (job.targets || []).map((t, i) => ({
    category: t.category,
    description: t.description,
    state: t.state,
    item: t.state === "done" && !got.has(i) ? t.item : undefined,
    error: t.state === "fail" ? t.error : undefined,
  }));
  const settled = job.status === "running" && targets.length
    && targets.every(t => t.state === "done" || t.state === "fail");
  res.json({ status: settled ? "done" : job.status, targets });
});

/* 单件重试：把 fail 的一件重新排队 */
app.post("/api/segment/retry", (req, res) => {
  const job = segJobs.get(req.body.jobId);
  const entry = job && (job.targets || [])[req.body.index];
  if (!entry) return res.json({ ok: false, status: "missing" });
  if (entry.state !== "fail") return res.json({ ok: false, status: entry.state });
  entry.state = "pending";
  delete entry.error;
  job.ts = Date.now();
  segQueue.push({ job, entry });
  pumpSegQueue();
  res.json({ ok: true });
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
  console.log(`美搭已启动 → http://localhost:${PORT}/login.html`);
  console.log(`手机访问：同一 Wi-Fi 下用「电脑IP:${PORT}/login.html」`);
});
