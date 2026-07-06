/* ============================================================
   AI 能力 ②：虚拟试穿（tryon）
   ------------------------------------------------------------
   输入 req：{ modelImage: "data:...;base64," | null,   模特照片（null=默认剪影模特）
               items: [ { id, category, image } ] }     要穿上身的衣服
   输出    ：{ image: "data:...;base64," | null }       生成的上身效果照
             image=null 时前端自动用叠图兜底。

   当前模型：DashScope（阿里云百炼）OutfitAnyone · aitryon-plus
   调用方式：图片先上传到 DashScope 临时存储 → 提交异步任务 → 轮询结果
   限制：需要真实人物照片做模特（默认剪影模特不支持）；
        一次支持 上装+下装（连体裙当上装）；鞋子不参与生成。
   替换模型：改本文件；密钥在 server/.env 的 DASHSCOPE_API_KEY
   ============================================================ */

const { DASHSCOPE_API_KEY, MODELS } = require("./config");

const BASE = "https://dashscope.aliyuncs.com/api/v1";

function dataUrlToBuffer(dataUrl) {
  const i = dataUrl.indexOf(",");
  const meta = dataUrl.slice(0, i);
  const ext = /png/.test(meta) ? "png" : "jpg";
  return { buf: Buffer.from(dataUrl.slice(i + 1), "base64"), ext };
}

/* 把一张 dataURL 图片传到 DashScope 临时存储，返回 oss:// 地址 */
async function uploadToDashScope(dataUrl, name) {
  const policyResp = await fetch(`${BASE}/uploads?action=getPolicy&model=${MODELS.tryon}`, {
    headers: { Authorization: `Bearer ${DASHSCOPE_API_KEY}` },
  });
  const policyData = await policyResp.json();
  const p = policyData.data;
  if (!p) throw new Error("获取上传凭证失败: " + JSON.stringify(policyData).slice(0, 200));

  const { buf, ext } = dataUrlToBuffer(dataUrl);
  const key = `${p.upload_dir}/${name}.${ext}`;
  const form = new FormData();
  form.append("OSSAccessKeyId", p.oss_access_key_id);
  form.append("Signature", p.signature);
  form.append("policy", p.policy);
  form.append("key", key);
  form.append("x-oss-object-acl", p.x_oss_object_acl);
  form.append("x-oss-forbid-overwrite", p.x_oss_forbid_overwrite);
  form.append("success_action_status", "200");
  form.append("file", new Blob([buf]), `${name}.${ext}`);

  const up = await fetch(p.upload_host, { method: "POST", body: form });
  if (!up.ok) throw new Error(`图片上传失败 HTTP ${up.status}`);
  return `oss://${key}`;
}

async function pollTask(taskId, { intervalMs = 3000, maxWaitMs = 120000 } = {}) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, intervalMs));
    const resp = await fetch(`${BASE}/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${DASHSCOPE_API_KEY}` },
    });
    const data = await resp.json();
    const st = data.output?.task_status;
    if (st === "SUCCEEDED") return data.output;
    if (st === "FAILED" || st === "CANCELED") {
      throw new Error(`试穿任务失败: ${data.output?.message || st}`);
    }
  }
  throw new Error("试穿任务超时");
}

module.exports = async function tryon(req) {
  if (!req || !Array.isArray(req.items)) throw new Error("缺少 items 参数");

  const isReal = (img) => typeof img === "string" && img.startsWith("data:");

  /* 试穿生成的前提：有密钥 + 模特是真实照片 + 至少一件真实衣服图 */
  const top = req.items.find(i => isReal(i.image) && (i.category === "上衣" || i.category === "连体裙"));
  const bottom = req.items.find(i => isReal(i.image) && i.category === "下装");
  if (!DASHSCOPE_API_KEY || !isReal(req.modelImage) || (!top && !bottom)) {
    return { image: null };   // 前端叠图兜底
  }

  try {
    /* 1. 上传图片到 DashScope 临时存储 */
    const [personUrl, topUrl, bottomUrl] = await Promise.all([
      uploadToDashScope(req.modelImage, "person"),
      top ? uploadToDashScope(top.image, "top") : null,
      bottom && !(top && top.category === "连体裙") ? uploadToDashScope(bottom.image, "bottom") : null,
    ]);

    /* 2. 提交异步试穿任务 */
    const input = { person_image_url: personUrl };
    if (topUrl) input.top_garment_url = topUrl;
    if (bottomUrl) input.bottom_garment_url = bottomUrl;

    const submit = await fetch(`${BASE}/services/aigc/image2image/image-synthesis`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${DASHSCOPE_API_KEY}`,
        "Content-Type": "application/json",
        "X-DashScope-Async": "enable",
        "X-DashScope-OssResourceResolve": "enable",
      },
      body: JSON.stringify({
        model: MODELS.tryon,
        input,
        parameters: { resolution: -1, restore_face: true },
      }),
    });
    const task = await submit.json();
    const taskId = task.output?.task_id;
    if (!taskId) throw new Error("提交任务失败: " + JSON.stringify(task).slice(0, 200));

    /* 3. 轮询直到出图，下载转成 dataURL 返回 */
    const out = await pollTask(taskId);
    const imgUrl = out.image_url || out.results?.[0]?.url;
    if (!imgUrl) throw new Error("任务成功但未返回图片");
    const imgResp = await fetch(imgUrl);
    const arr = Buffer.from(await imgResp.arrayBuffer());
    return { image: `data:image/jpeg;base64,${arr.toString("base64")}` };
  } catch (e) {
    console.warn("试穿生成失败，回退叠图:", e.message);
    return { image: null };
  }
};
