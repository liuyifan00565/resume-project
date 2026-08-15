// cloudfunctions/vision_diagnose/index.js
const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const https = require("https");

const MODEL = "ernie-4.5-turbo-vl";
const MAX_Q_LEN = 6000; // 含 YOLO 坐标列表时问题较长，需要更大上限

function httpPostJson({ hostname, reqPath, headers, body, timeoutMs = 50000 }) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      {
        hostname,
        path: reqPath,
        method: "POST",
        headers: { ...headers, "Content-Length": Buffer.byteLength(data) },
      },
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
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.write(data);
    req.end();
  });
}

exports.main = async (event) => {
  const { fileID, imageBase64, question, messages, meta } = event || {};

  // 1) 取图片 URL：优先使用 base64（省去云存储上传），否则取临时链接
  let imageUrl;
  if (imageBase64) {
    imageUrl = imageBase64; // data:image/jpeg;base64,... ERNIE 直接支持
  } else if (fileID) {
    const tmp = await cloud.getTempFileURL({ fileList: [fileID] });
    imageUrl = tmp?.fileList?.[0]?.tempFileURL;
  }
  if (!imageUrl) return { text: "未获取到图片，请重试" };

  // 2) API Key
  const apiKey = process.env.QIANFAN_API_KEY;
  if (!apiKey) return { text: "未配置 QIANFAN_API_KEY" };

  // 3) System prompt —— 禁止 Markdown、不臆造不可见细节
  const system = [
    "你是智种计农业视觉质检助手，专注于种子图片质量分析与混杂品种鉴别。",
    "判断规则（按优先级）：",
    "1. 先确定图中数量最多的种子为主体品种，记住其代表性颜色、形状和大小。",
    "2. 其他粒（杂粒）= 与主体品种在颜色、形状或大小上有可见差异的种子，即使是同一作物的不同品种也算。",
    "   例如：大多数是较大的扁平椭圆玉米粒，其中混有较小的、更圆的、颜色偏深或偏浅的玉米粒，这些都是其他粒。",
    "   判断标准：与主体多数种子相比，有以下任一特征即可判为其他粒：",
    "   - 颜色明显偏深或偏浅（超出主体颜色自然变化范围）",
    "   - 形状明显不同（更圆、更扁、更细长等）",
    "   - 大小明显偏小（面积约为主体的60%以下）",
    "   请仔细寻找，不要遗漏细微差异。",
    "3. 缺陷粒 = 与主体同品种，但有肉眼可见损伤：黑绿色霉斑、明显裂缝或破损缺角、虫蛀孔洞、严重萎缩变形。",
    "   自然颜色渐变/表面纹路/轻微大小差异不算缺陷。",
    "4. 若某粒既像其他粒又像缺陷粒，优先判为其他粒。",
    "5. 正常粒 = 主体品种中外观完好无损伤的种子。",
    "输出规则：",
    "- 仅依据图片中可见信息作答，禁止臆造图片中不存在的内容",
    "- 每粒检出的异常种子必须在 positions 数组中提供坐标 {x:...,y:...}，不可只给数量而省略坐标",
    "- 禁止使用任何 Markdown 格式符号（**、#、`、> 等），输出纯文本或纯 JSON",
    "- 若用户要求 JSON 输出，则严格只返回 JSON，不附加任何说明文字",
  ].join("\n");

  // 4) 构造用户问题；超长时截断前段（可继续分析主体）
  let q = (question || "").trim();
  if (!q && Array.isArray(messages)) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.role === "user" && typeof m.content === "string" && m.content.trim()) {
        q = m.content.trim();
        break;
      }
    }
  }
  if (!q) q = "请分析这张种子图片的质量，识别缺陷类型及数量，给出合格率评估。";

  // 问题超长截断，保留关键指令段
  if (q.length > MAX_Q_LEN) {
    q = q.slice(0, MAX_Q_LEN) + "（内容已截断，请基于以上部分继续分析）";
  }

  const userContent = [
    { type: "image_url", image_url: { url: imageUrl } },
    { type: "text", text: q + (meta ? `\n补充信息：${JSON.stringify(meta)}` : "") },
  ];

  // 5) 调 ernie-4.5-turbo-vl（千帆 OpenAI 兼容接口）
  const body = {
    model: MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userContent },
    ],
    temperature: 0.3,
    stream: false,
  };

  let resp;
  try {
    resp = await httpPostJson({
      hostname: "qianfan.baidubce.com",
      reqPath: "/v2/chat/completions",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body,
      timeoutMs: 50000,
    });
  } catch (err) {
    return { text: `请求失败：${err.message || err}` };
  }

  let text =
    resp.data?.choices?.[0]?.message?.content ||
    resp.data?.result ||
    (typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data));

  if (!resp.status || resp.status >= 400) {
    return { text: `图片分析请求失败(${resp.status})：${text}` };
  }

  // 清洗响应：去掉 markdown 代码块包裹和 JSON 内注释
  if (typeof text === "string") {
    // 去掉 ```json ... ``` 或 ``` ... ```
    text = text.replace(/^```[a-zA-Z]*\s*/m, "").replace(/\s*```\s*$/m, "").trim();
    // 去掉 JSON 中的单行注释（// ...）
    text = text.replace(/\/\/[^\n\r"]*/g, "");
    // 去掉多余空行和尾逗号（ERNIE 偶尔生成）
    text = text.replace(/,\s*([\}\]])/g, "$1").trim();
  }

  return { text: text || "(未返回内容)" };
};
