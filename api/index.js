/* Vercel 函数入口：vercel.json 把所有 /api/* 重写到这里，交给 Express 处理。
   静态页面（根目录 HTML/assets/css/js）由 Vercel CDN 直接服务，不经过本函数。
   本地开发不用这个文件：直接 node server/server.js（require.main 分支会监听端口）。 */
module.exports = require("../server/server.js");
