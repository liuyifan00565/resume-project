// cloudfunctions/vision_diagnose/index.js  —— 通用视觉对话版
const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const https = require("https");

function httpPostJson({ hostname, reqPath, headers, body, timeoutMs = 45000 }) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      { hostname, path: reqPath, method: "POST", headers: { ...headers, "Content-Length": Buffer.byteLength(data) } },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(raw || "{}") }); }
          catch (e) { resolve({ status: res.statusCode, data: raw }); }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Request timeout after ${timeoutMs}ms`)));
    req.write(data);
    req.end();
  });
}

exports.main = async (event) => {
  const { fileID, question, messages, meta } = event || {};
  if (!fileID) return { text: "缺少 fileID" };

  // 1) 取临时链接
  const tmp = await cloud.getTempFileURL({ fileList: [fileID] });
  const imageUrl = tmp?.fileList?.[0]?.tempFileURL;
  if (!imageUrl) return { text: "未获取到图片临时链接，请重试" };

  // 2) 千帆配置
  const apiKey = process.env.QIANFAN_API_KEY;
  const model = process.env.QIANFAN_VL_MODEL;
  if (!apiKey) return { text: "未配置 QIANFAN_API_KEY" };
  if (!model) return { text: "未配置 QIANFAN_VL_MODEL（视觉模型）" };

  // 3) 构造“通用”system（很短，别写死任务）
  const system = `
你是一个严谨的中文视觉助手。
用户会给你图片并提问。请直接回答用户问题。
仅基于图片可见信息与用户文字，不确定就说明不确定。
回答尽量简洁、可操作；不要臆造看不见的细节。
`.trim();

  // 4) 用户问题：优先用 question，其次用 messages 最后一条文本
  let q = (question || "").trim();
  if (!q && Array.isArray(messages)) {
    // 兼容你以后想传多轮对话
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m && m.role === "user" && typeof m.content === "string" && m.content.trim()) {
        q = m.content.trim();
        break;
      }
    }
  }
  if (!q) q = "请描述这张图片，并回答你能从图中判断出的关键信息。";

  // 5) 调千帆视觉（OpenAI 兼容 chat/completions）
  const body = {
    model,
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: imageUrl } },
          { type: "text", text: q + (meta ? `\n\n补充信息：${JSON.stringify(meta)}` : "") }
        ]
      }
    ],
    temperature: 0.4,
    stream: false
  };

  const resp = await httpPostJson({
    hostname: "qianfan.baidubce.com",
    reqPath: "/v2/chat/completions",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body,
    timeoutMs: 45000
  });

  const text =
    resp.data?.choices?.[0]?.message?.content ||
    resp.data?.result ||
    (typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data));

  if (!resp.status || resp.status >= 400) {
    return { text: "图片分析请求失败：\n" + text };
  }
  return { text: text || "(未返回内容)" };
};
