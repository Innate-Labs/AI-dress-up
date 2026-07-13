/* ============================================================
   Supabase（Postgres）· 轻量用户资料持久化
   只存"小数据":账号(邮箱/昵称/头像)、造型档案、偏好、收藏、衣橱选择、引导状态。
   用户上传的照片/试穿图等大文件本期不上云,仍留浏览器 localStorage。

   访问方式:后端用 service_role key 走 PostgREST（纯 fetch,不加依赖）。
   service key 只在服务端,永不下发浏览器;前端只调我们自己的 /api/state/*。

   未配 SUPABASE_URL / SUPABASE_SERVICE_KEY 时 enabled=false,
   相关接口返回 disabled,前端同步静默跳过,行为与不接库时一致。

   建表 SQL（在 Supabase SQL Editor 跑一次,务必开 RLS 让匿名 key 碰不到）:
     create table if not exists user_state (
       email text primary key,
       state jsonb not null default '{}',
       updated_at timestamptz not null default now()
     );
     alter table user_state enable row level security;   -- 无策略=仅 service key 可访问
   ============================================================ */

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const enabled = !!(SUPABASE_URL && SUPABASE_KEY);

async function sb(pathAndQuery, opts = {}) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!resp.ok) throw new Error(`Supabase ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  return resp;
}

/* 读某账号的轻量资料 → { state, updated_at } 或 null */
async function getState(email) {
  const resp = await sb(`user_state?email=eq.${encodeURIComponent(email)}&select=state,updated_at`);
  const rows = await resp.json();
  return rows[0] || null;
}

/* upsert（存在则更新）某账号的轻量资料 */
async function saveState(email, state) {
  await sb("user_state?on_conflict=email", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ email, state, updated_at: new Date().toISOString() }),
  });
}

module.exports = { enabled, getState, saveState };
