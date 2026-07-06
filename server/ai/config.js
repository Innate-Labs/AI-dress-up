/* 读取 server/.env 里的密钥（.env 不进 git）。
   格式：每行 KEY=VALUE。系统环境变量优先。 */

const fs = require("fs");
const path = require("path");

(function loadEnv() {
  try {
    const txt = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8");
    txt.split("\n").forEach((line) => {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    });
  } catch { /* 没有 .env 时静默，走占位实现 */ }
})();

module.exports = {
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || "",
  DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY || "",

  /* 模型名集中在这里，替换模型只改这一处 */
  MODELS: {
    qc: "qwen/qwen3.6-flash",                    // 模型1 照片质检
    vision: "qwen/qwen3-vl-30b-a3b-instruct",    // 模型2第1步 穿着识别 + 模型3 打标签（主力）
    visionBackup: "qwen/qwen3-vl-8b-instruct",   // 模型3 备用
    /* 平铺图生成：gemini 约15秒/张；追求更高质量可换 "openai/gpt-5.4-image-2"（约2.5分钟/张，实测更精致） */
    flatImage: "google/gemini-3.1-flash-image",  // 模型2第2步 平铺图生成
    tryon: "aitryon-plus",                       // 模型4 试穿（DashScope）
  },
};
