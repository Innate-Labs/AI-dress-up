/* ============================================================
   邮箱验证码登录（无密码，登录即注册）
   POST /api/auth/send-code { email }        → { ok, devCode? }
   POST /api/auth/login     { email, code }  → { token, email }

   邮件服务：已接阿里云邮件推送 DirectMail（见下方 sendMail）。
   配了 DM_ACCESS_KEY_ID + DM_ACCESS_KEY_SECRET 就真发邮件；
   没配则验证码随响应直发（devCode），前端明示"演示直发"，方便无密钥时全流程可用。

   全链路 serverless 兼容：验证码由 HMAC+时间槽派生（不落任何存储，
   任意实例可验）；token 是无状态 HMAC 签名（不需要会话表）；
   用户表只做簿记——本地写 server/data/users.json，Vercel 上文件写失败
   自动忽略、配了 Upstash 则存 KV，都不阻断登录。
   ============================================================ */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");

const router = express.Router();
const store = require("./store");

const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");

/* AUTH_SECRET 同时用于验证码派生和 token 签名——绝不能用公开默认串上线。
   线上（Vercel / NODE_ENV=production）漏配直接拒绝启动（fail closed），
   别再静默回退到 git 里能看到的默认值；本地开发允许默认值但大声告警。 */
let SECRET = process.env.AUTH_SECRET;
if (!SECRET) {
  if (process.env.VERCEL || process.env.NODE_ENV === "production") {
    throw new Error("AUTH_SECRET 未配置：线上部署必须在环境变量里设置一串随机密钥（验证码与登录 token 都靠它签名），拒绝以默认密钥启动");
  }
  SECRET = "meida-dev-secret";
  console.warn("[auth] ⚠ 未设置 AUTH_SECRET，正在使用开发默认密钥，切勿用于线上");
}

const CODE_TTL = 5 * 60_000;      // 验证码 5 分钟有效
const SEND_GAP = 60_000;          // 同邮箱 60 秒内只发一次（服务端防连点）
const TOKEN_TTL = 30 * 24 * 3600_000; // 登录态 30 天
const LOGIN_MAX_TRIES = 8;        // 同邮箱 10 分钟内最多 8 次登录尝试，防验证码爆破
const LOGIN_WINDOW_SEC = 600;

/* ---------- 用户表（文件版） ---------- */
function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, "utf8")); }
  catch { return {}; }
}
function saveUsers(users) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

/* ---------- 验证码：无状态派生（serverless 友好） ----------
   code = HMAC(SECRET, email + 5分钟时间槽) 截 6 位数字。
   不存任何地方：发码和验码可以落在不同函数实例上（Vercel 必需）。
   校验当前槽和上一槽 → 有效期 5~10 分钟。
   取舍（测试期可接受，正式版接邮件后再评估）：
   同一窗口内验证码可重复使用；发送频控只在本实例内存内 best-effort。 */
const codeSlot = () => Math.floor(Date.now() / CODE_TTL);
function codeFor(email, slot) {
  const h = crypto.createHmac("sha256", SECRET).update(`code|${email}|${slot}`).digest();
  return String(h.readUInt32BE(0) % 900000 + 100000);
}

const lastSent = new Map();   // email → 时间戳（单实例内的发送频控，尽力而为）

const isEmail = s => typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

/* ---------- 邮件发送：阿里云邮件推送 DirectMail（SingleSendMail HTTP API）----------
   自实现阿里云 RPC 签名（HMAC-SHA1），不加依赖。
   配了 DM_ACCESS_KEY_ID + DM_ACCESS_KEY_SECRET → 真发邮件；没配 → 回退 devCode 演示直发。
   环境变量：DM_ACCESS_KEY_ID / DM_ACCESS_KEY_SECRET（必填，RAM 子用户），
   DM_ACCOUNT（发信地址，默认 noreply@mail.meidaai.com）、DM_FROM_ALIAS（发件人昵称）、
   DM_ENDPOINT（默认 https://dm.aliyuncs.com/）。 */
const DM_ENDPOINT = process.env.DM_ENDPOINT || "https://dm.aliyuncs.com/";
const DM_ACCESS_KEY_ID = process.env.DM_ACCESS_KEY_ID || "";
const DM_ACCESS_KEY_SECRET = process.env.DM_ACCESS_KEY_SECRET || "";
const DM_ACCOUNT = process.env.DM_ACCOUNT || "noreply@mail.meidaai.com";
const DM_FROM_ALIAS = process.env.DM_FROM_ALIAS || "美搭";
const mailEnabled = !!(DM_ACCESS_KEY_ID && DM_ACCESS_KEY_SECRET);

/* 阿里云 RPC 专用百分号编码 */
function pctEncode(s) {
  return encodeURIComponent(s).replace(/\+/g, "%20").replace(/\*/g, "%2A").replace(/%7E/g, "~");
}

async function sendMail(email, code) {
  const params = {
    Action: "SingleSendMail",
    AccountName: DM_ACCOUNT,
    AddressType: "1",              // 1 = 使用发信地址作为管理地址
    ReplyToAddress: "false",
    ToAddress: email,
    Subject: "美搭 · 登录验证码",
    HtmlBody: `<p>您的美搭登录验证码是 <b style="font-size:18px;letter-spacing:2px">${code}</b>，5 分钟内有效。</p><p>如非本人操作，请忽略此邮件。</p>`,
    FromAlias: DM_FROM_ALIAS,
    Format: "JSON",
    Version: "2015-11-23",
    AccessKeyId: DM_ACCESS_KEY_ID,
    SignatureMethod: "HMAC-SHA1",
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    SignatureVersion: "1.0",
    SignatureNonce: crypto.randomUUID(),
  };
  const canonical = Object.keys(params).sort()
    .map(k => `${pctEncode(k)}=${pctEncode(params[k])}`).join("&");
  const stringToSign = `POST&${pctEncode("/")}&${pctEncode(canonical)}`;
  const signature = crypto.createHmac("sha1", DM_ACCESS_KEY_SECRET + "&").update(stringToSign).digest("base64");
  const body = `${canonical}&Signature=${pctEncode(signature)}`;

  const resp = await fetch(DM_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`DirectMail ${resp.status}: ${data.Code || ""} ${data.Message || "发送失败"}`);
  return data;
}

router.post("/api/auth/send-code", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  if (!isEmail(email)) return res.status(400).json({ error: "邮箱格式不正确" });

  if (Date.now() - (lastSent.get(email) || 0) < SEND_GAP) {
    return res.status(429).json({ error: "发送太频繁，请一分钟后再试" });
  }
  lastSent.set(email, Date.now());

  const code = codeFor(email, codeSlot());

  if (mailEnabled) {
    try {
      await sendMail(email, code);
      return res.json({ ok: true });
    } catch (e) {
      console.warn("[auth] 邮件发送失败:", e.message);
      return res.status(500).json({ error: "验证码发送失败，请稍后再试" });
    }
  }
  /* 未配置邮件服务：验证码直发给前端，仅供开发/演示 */
  console.log(`[auth] 演示直发验证码 ${email} → ${code}`);
  res.json({ ok: true, devCode: code });
});

router.post("/api/auth/login", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const code = String(req.body.code || "").trim();
  if (!isEmail(email)) return res.status(400).json({ error: "邮箱格式不正确" });
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: "请输入 6 位数字验证码" });

  /* 验证码爆破防护：验证码是确定性派生（每邮箱同槽仅 2 个有效值），
     无节流就能被枚举。每次尝试先计数，超阈值直接 429；成功后清零不误伤正常用户。
     跨实例靠 store（Upstash）；纯内存后端时退化为单实例限流，小范围测试够用。 */
  try {
    const tries = await store.incr(`login:tries:${email}`, LOGIN_WINDOW_SEC);
    if (tries > LOGIN_MAX_TRIES) {
      return res.status(429).json({ error: "尝试次数过多，请 10 分钟后再试" });
    }
  } catch (e) { console.warn("登录频控计数失败（本次放行）:", e.message); }

  const slot = codeSlot();
  if (code !== codeFor(email, slot) && code !== codeFor(email, slot - 1)) {
    return res.status(400).json({ error: "验证码不正确或已过期，请重新获取" });
  }
  try { await store.del(`login:tries:${email}`); } catch {}

  /* 用户记录只做簿记（token 本身无状态）：
     文件写失败（Vercel 只读盘）不阻断登录；配了 KV 顺带存一份 */
  try {
    const users = loadUsers();
    if (!users[email]) users[email] = { email, createdAt: new Date().toISOString() };
    users[email].lastLoginAt = new Date().toISOString();
    saveUsers(users);
  } catch (e) { console.warn("用户表文件写入失败（不影响登录）:", e.message); }
  try {
    if (store.backend === "upstash") {
      const u = (await store.get(`user:${email}`)) || { email, createdAt: new Date().toISOString() };
      u.lastLoginAt = new Date().toISOString();
      await store.set(`user:${email}`, u);
    }
  } catch (e) { console.warn("用户表 KV 写入失败（不影响登录）:", e.message); }

  res.json({ token: signToken(email), email });
});

/* ---------- 无状态 token：base64(email).过期时间.HMAC ---------- */
function signToken(email) {
  const payload = `${Buffer.from(email).toString("base64url")}.${Date.now() + TOKEN_TTL}`;
  const sig = crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
  return `${payload}.${sig}`;
}
/* 校验 token → 返回 email 或 null（给后续需要登录态的接口用） */
function verifyToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const [b64, exp, sig] = parts;
  const expect = crypto.createHmac("sha256", SECRET).update(`${b64}.${exp}`).digest("hex");
  if (sig.length !== expect.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  if (+exp < Date.now()) return null;
  return Buffer.from(b64, "base64url").toString();
}

module.exports = { router, verifyToken };
