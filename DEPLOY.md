# 美搭 · 部署运维手册

> 上线部署、环境变量、外部服务、日常运维、迁移计划。改代码看 `CLAUDE.md`；已知坑看 `KNOWN_ISSUES.md`。

## 一、线上环境总览

| 项 | 值 |
|---|---|
| 正式域名 | `www.meidaai.com`（`meidaai.com` 会 308 跳到登录页） |
| 托管平台 | **Vercel**（Hobby 免费档，serverless 函数模式） |
| 入口 | 根路径重定向到 `login.html`（见 `vercel.json`） |
| 域名注册 | 腾讯云；DNS 解析在**腾讯云 DNSPod** |
| 备案 | **无**（指向 Vercel 海外，无法备案）——微信/国内访问受限，见 KNOWN_ISSUES |

## 二、仓库关系（重要，别搞混）

```
Innate-Labs/AI-dress-up   ← 团队主仓（git remote: origin，只读拉取组员改动）
Jachinx-ai/maidaai        ← 负责人的 fork（git remote: meida，Vercel 监听这个仓库的 main）
```

- `git push`（默认）→ 推到 **fork（meida）** → Vercel 自动重新部署
- `git pull`（默认）← 从**团队主仓（origin）**拉组员的更新
- 想把改动共享回团队 → 手动 `git push origin main`
- 本地配置：`git config branch.main.pushRemote meida`（push 走 fork，fetch 走 origin）

## 三、外部服务清单

| 服务 | 作用 | 控制台 / 关键信息 |
|---|---|---|
| Vercel | 托管前端 + serverless 后端 | 项目名 `meidaai`，连 fork 仓库 |
| Supabase | 登录用户**轻量资料**持久化 | 项目 `gogrdscolqdiuaoscbzy.supabase.co`，表 `user_state`（见五） |
| 阿里云 DirectMail | 发邮箱验证码 | 发信域名 `mail.meidaai.com`（已验证），发信地址 `noreply@mail.meidaai.com` |
| 阿里云百炼 DashScope | 拆图白底平铺 | 业务空间密钥 `sk-ws-`，专属域名见 `.env.example` |
| OpenRouter | 识别/打标签/试穿生图 | 密钥计费，用量看其后台 |
| 腾讯云 DNSPod | `meidaai.com` DNS 解析 | Vercel 记录(@ A / www CNAME) + DirectMail 记录(mail 下 SPF/DKIM/DMARC/MX) |

## 四、环境变量

清单和说明见 **`server/.env.example`**。线上在 **Vercel → Settings → Environment Variables** 配（范围勾 Production 即可）。当前已配：`AUTH_SECRET`、`OPENROUTER_API_KEY`、`DASHSCOPE_API_KEY`、`DASHSCOPE_API_BASE`、`SUPABASE_URL`、`SUPABASE_SERVICE_KEY`、`DM_ACCESS_KEY_ID`、`DM_ACCESS_KEY_SECRET`。

> ⚠️ 改任何环境变量后，必须去 **Deployments → 最新一条 → Redeploy** 才生效。

## 五、Supabase 表结构

表 `user_state`（只存小数据：账号昵称/头像/邮箱、造型档案、偏好、收藏、衣橱选择、引导状态；上传的照片/试穿图仍留浏览器本机）。**RLS 已开启**，只有后端 service_role 能读写。建表 SQL：

```sql
create table if not exists user_state (
  email text primary key,
  state jsonb not null default '{}',
  updated_at timestamptz not null default now()
);
alter table user_state enable row level security;   -- 必须，否则匿名可读用户数据
```

前端流程：登录时 `pullLightState()` 拉回、变化时 `pushLightState()` 防抖存回（`js/app.js`）；后端 `/api/state/pull`、`/api/state/push`（`server/server.js` + `server/supabase.js`）。

## 六、日常运维

- **发布改动**：改完代码 → `git push`（默认推 fork）→ Vercel 约 1 分钟自动部署完 → 刷新页面
- **只改了环境变量**：Vercel → Deployments → 最新一条 → ⋯ → Redeploy
- **看日志/排障**：Vercel → 项目 → Deployments → 点某次部署 → Functions / Logs，能看到 `/api/*` 的报错（如邮件发送失败、Supabase 报错）
- **本地跑**：`cd server && npm start` → localhost:8394（本地用自己的 `server/.env`）
- **回滚**：Vercel → Deployments → 选一个早的成功部署 → Promote to Production

## 七、后续：迁国内服务器 + 备案（微信/国内正式用绕不开）

Vercel 只适合给能科学上网的人小范围试。要在**微信里给国内用户**稳定用，需要：

1. 买**国内轻量应用服务器**（阿里云/腾讯云，~¥60-100/月）
2. 域名 `www.meidaai.com` 解析改指到该服务器，提交 **ICP 备案**（个人主体可办，等 1-3 周）
3. 代码几乎不用改（Express 原样能跑；单进程内存模式反而消除了 serverless 的结构性隐患，见 KNOWN_ISSUES），迁过去 = 装 Node + pm2 + Nginx + HTTPS
4. 备案通过后，微信不再拦截，试穿等长请求走国内链路也快得多

域名/Supabase/DirectMail 这些**都可复用**，不用重建。
