/* ============================================================
   键值存储适配层（拆分任务 / 每日配额 / 用户表共用）

   两种后端，按环境变量自动选择：
   - 配了 UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN → Upstash Redis
     （Vercel 等 serverless 部署必配：函数实例间不共享内存，任务/计数必须外置）
   - 没配 → 进程内存 Map（本地开发与自购服务器：行为与旧内存版一致，零依赖）

   接口（值一律 JSON 序列化）：
   - get(key)                → 对象 | null
   - set(key, obj, ttlSec?)  → 写入，可选过期秒数
   - del(...keys)
   - incr(key, ttlSec)       → 自增并返回新值；首次自增时设置过期（配额计数用）

   注意：Upstash 免费档单请求上限 1MB——大对象（图片 base64）要拆 key 存，
   不要把整个任务连图塞一个 key（见 server.js 的任务键设计）。
   ============================================================ */

const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, "");
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const useUpstash = !!(UPSTASH_URL && UPSTASH_TOKEN);

/* ---------- Upstash REST：POST 单命令，避免大值进 URL ---------- */
async function redis(cmd) {
  const resp = await fetch(UPSTASH_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  const data = await resp.json();
  if (!resp.ok || data.error) throw new Error(`Upstash: ${data.error || resp.status}`);
  return data.result;
}

/* ---------- 内存后端：带过期时间的 Map，访问时懒清理 ---------- */
const mem = new Map();   // key -> { v: json字符串, exp: 过期时间戳|0 }
function memSweep() {
  const now = Date.now();
  for (const [k, e] of mem) if (e.exp && e.exp < now) mem.delete(k);
}

const store = useUpstash ? {
  backend: "upstash",
  async get(key) {
    const v = await redis(["GET", key]);
    return v == null ? null : JSON.parse(v);
  },
  async set(key, obj, ttlSec) {
    const cmd = ["SET", key, JSON.stringify(obj)];
    if (ttlSec) cmd.push("EX", String(ttlSec));
    await redis(cmd);
  },
  async del(...keys) {
    if (keys.length) await redis(["DEL", ...keys]);
  },
  async incr(key, ttlSec) {
    const n = await redis(["INCR", key]);
    if (n === 1 && ttlSec) await redis(["EXPIRE", key, String(ttlSec)]);
    return n;
  },
} : {
  backend: "memory",
  async get(key) {
    memSweep();
    const e = mem.get(key);
    return e ? JSON.parse(e.v) : null;
  },
  async set(key, obj, ttlSec) {
    memSweep();
    mem.set(key, { v: JSON.stringify(obj), exp: ttlSec ? Date.now() + ttlSec * 1000 : 0 });
  },
  async del(...keys) {
    keys.forEach(k => mem.delete(k));
  },
  async incr(key, ttlSec) {
    memSweep();
    const e = mem.get(key);
    const n = (e ? JSON.parse(e.v) : 0) + 1;
    mem.set(key, { v: JSON.stringify(n), exp: e ? e.exp : Date.now() + ttlSec * 1000 });
    return n;
  },
};

module.exports = store;
