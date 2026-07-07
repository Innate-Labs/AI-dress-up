# AI穿搭助手 · 高保真原型（给 AI 编码助手的项目说明）

任何 AI 编码助手（Claude Code / Codex 等）在修改本项目前，先读完这份文件。

## 项目定位（最重要）

这是一个**能跑起来的移动端网页产品**：功能真实可用，AI 能力已接真实模型
（质检 qwen3.6-flash / 识别标签 qwen3-vl / 平铺图 gemini-3.1-flash-image 经 OpenRouter；
试穿 aitryon-plus 经阿里云百炼；搭配推荐 qwen3.6-flash 读标签选搭配、规则兜底）。
密钥在 server/.env（不进 git）；换模型只改 server/ai/config.js 的 MODELS；提示词在 server/ai/prompts.js。

- ✅ 做：页面 UI、真实交互、轻量后端 AI 接口层（占位实现，接口契约固定）
- ❌ 不做：登录鉴权、数据库（数据存 localStorage）、自己训练模型
- 团队成员都通过 AI 助手改代码（没有人手写代码），所以**代码要简单直白，改动要克制**
- 产品设计由项目负责人在 Figma 上出图，AI 依据设计图/口头描述改页面

## 技术约定（不要违反）

- 前端：**纯 HTML + CSS + 原生 JS**，多页面结构；**禁止**引入 React/Vue、打包工具、CSS 框架
- 后端：`server/` 目录，Express 静态托管 + 三个 AI 接口；除 express 外**不随意加依赖**
- 每个页面 = 根目录下一个独立 `.html` 文件，页内交互写在该文件的 `<script>` 里
- 公共部分四处：`css/base.css`（设计系统）、`js/app.js`（公共组件/状态）、`js/data.js`（演示数据）、
  `js/ai.js`（AI 服务层：优先走后端 /api/*，后端不在线自动回退浏览器本地模拟，双击 HTML 也能用）
- 启动：`cd server && npm install && npm start` → http://localhost:8394/login.html（配置在 `.claude/launch.json`）
- **AI 能力替换点只在 `server/ai/` 三个文件里**（segment.js 抠图 / tryon.js 试穿 / recommend.js 搭配），
  输入输出契约见各文件头部注释和 `server/模型接入说明.md`，改模型不许动前端

## 试穿合成与试衣间

- 试穿页：换装先秒级叠图预览（CSS 类 `.worn.cat-XX`，位置常量 `CAT_POS`），同时**自动调真试穿模型**
  生成整图（`/api/tryon`），出图后替换叠图；系统衣服/默认模特图会先转 dataURL 发给模型
- 真试穿防烧钱机制（在 tryon.html，勿删）：换装后 600ms 防抖合并连点；同模特+同一身衣服结果内存缓存；
  过期结果按序号丢弃。模型限制：只支持上装+下装（连体裙算上装），鞋子不参与生成
- 舞台底色自动取模特图边缘颜色（`syncStageBg`），照片与背景无缝，不要写死舞台颜色
- 每次完整试穿（≥2件）自动生成快照存入试衣间（上限 20 条，连续重复不存；真试穿图压缩后存）
- 上传图片一律先 `compressImage()` 压缩再存 localStorage，防超限

## 设计风格（wearwow 式黑白极简，务必保持统一）

设计令牌都在 `css/base.css` 的 `:root` 里，新页面必须复用，不许自造颜色/圆角：

- 尺寸间距遵循 iOS HIG：页边距 `--pad`(16px)、可点区域 ≥44pt、正文 17pt、TabBar 标签 10pt
- 白底 `--bg` + 近黑主色 `--ink`，卡片纯白大圆角（`--r-lg`/`--r-xl`）
- 按钮一律胶囊形：主按钮黑底白字 `.btn-primary`，次按钮白底描边 `.btn-ghost`
- 标题超粗（font-weight 900），正文用系统苹方
- **唯一的彩色**是粉→薄荷渐变 `--grad`，只准用在 AI 能力相关的元素上（`.ai-pill`）
- 假 iOS 状态栏已移除（手机自带真状态栏，`renderStatusbar()` 是空函数勿删勿复用）；主 tab 页底部有 `renderTabbar('key')`
- 虚拟模特只有 1 个默认款（`PRESET_MODELS`），不许加回多个预设；用户上传照片的模特不限数量
- 默认模特图 = `assets/real/model-f.png` / `model-m.png`（按性别偏好选，`defaultModelSrc()`），缺图回退剪影
- 我的页「我的模特」在用户没上传照片时显示大号添加引导框，不展示默认模特
- 参考对标产品截图：`design-reference/wearwow/`，风格笔记：`design-reference/wearwow-style-notes.md`

## 页面清单与流程

```
index.html          总览页（桌面演示用，手机壳网格展示全部页面）
login.html          一键登录；其他手机号登录=弹层输手机号+短信验证码 → signup.html（邮箱注册）
                  → onboarding.html（4步引导：性别/职业/偏好/选单品）→ home.html
home.html           首页「灵感试穿」：场景chips + 搭配卡（纯图片，左下收藏/右下试穿）→ tryon / outfit-detail
tryon.html          模特试穿：?outfit=oX / ?item=tXX / ?items=a,b,c；抽屉两tab（我的衣服在前默认选中/穿搭在后），
                    +号打开系统相册直接选图入橱；「AI 搭配我的衣服」优先用用户上传的衣服、缺的分类用系统款补，
                    用户没上传过衣服时按钮置灰、点击 toast 提示先上传；?item= 进入时自动围绕该单品 AI 搭配
outfit-detail.html  穿搭详情：?id=oX；只展示图片，点任意单品弹「替换XX」弹窗（同分类可选）
add-clothes.html    添加衣服：深色入口页；相册/拍照选图后**后台自动抠图直接入橱**（toast 提示，无确认页），跳衣橱
create-model.html   创建模特：预设/我的照片、上传提示sheet、失败弹窗（"现在拍一张"=演示失败路径，"打开相册"=成功路径）
wardrobe.html       衣橱：圆形分类筛选；卡片右上角🗑删除（弹确认框，删除后相关搭配全站同步隐藏，
                    逻辑=js/app.js 的 availableOutfits()）；点整卡/去搭配 → tryon?item= 自动 AI 搭配
history.html        试衣间：3列等高图片墙（无标签），点卡片进 iOS 图库式查看器（大图+底部缩略图切换），编辑删除
profile.html        我的：收藏（与首页同款卡片，星标为已选中态）/模特两tab
```

**UI 上明确删除过的元素（不要加回来）**：登录页问号、Google 登录、首页天气/黑色AI推荐卡/聊一聊输入框、卡片文字说明（名称/场景/件数）、穿搭详情的分享/标签/描述文案、试穿页左侧穿着小图列/保存按钮/衣橱推荐灵感chips、衣橱页单品穿搭切换/右上筛选图标、试衣间卡片上的场景和时间标签。

底部导航五项：首页 / 衣橱 / 上传(+) / 试衣间 / 我的（见 `js/app.js` 的 `TABS`）。

## 数据与状态

- `js/data.js` **由脚本自动生成，禁止手改**（`node server/tools/build-data.js` 扫描 assets/real 素材生成）：
  `ITEMS` 230件（含 AI 标签/性别/场景）、`OUTFITS` 79套（含 gender）、`STARTER_WARDROBE` 新用户默认衣橱
- 素材命名规范见根目录 `素材命名规范.md`；新素材入库流程：放图 → tag-items.js 打标签 → build-data.js 重新生成
- 衣物分类固定为 `CATS = 全部/上衣/下装/鞋子/连体裙`，全站统一，不许增删
- 搭配展示按引导问卷的服饰性别偏好过滤（`prefGenders()`/`availableOutfits()` in js/app.js）；
  删除系统单品记入 `deletedItems`，含它的搭配全站隐藏
- 运行时状态存 localStorage（key `aiwd-state`），通过 `Store.get()/Store.set()` 读写：
  衣橱、收藏、试衣历史、用户上传的单品和模特照片、引导问卷答案
- 图片机制：单品图先找 `assets/real/<id>.png` → `.jpg` → 回退到 `assets/ph/<剪影>.svg` 占位图。
  给页面加单品图一律用 `itemImg(item)`，不要手写 `<img>`

## 修改守则

1. 改样式优先改 `css/base.css` 的变量或组件类，保持所有页面统一
2. 新增页面：复制一个现有页面做骨架，保留状态栏/底部导航/设计令牌
3. 新增单品/搭配：只改 `js/data.js`，并在 `assets/real/README.md` 登记新图片命名
4. 每完成一个改动主题，做一次 git commit（中文说明改了什么）
5. 演示假延时统一 600–2000ms，toast 提示用 `toast('文案')`
