// cloudfunctions/aiAgent/index.js
// 依赖：wx-server-sdk, openai, docx, pdfkit

const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const OpenAI = require("openai");
const https = require("https");
const fs = require("fs");
const path = require("path");

function stripMarkdown(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/#{1,6}\s/g, "")
    .replace(/`{1,3}[^`]*`{1,3}/g, (m) => m.replace(/`/g, ""))
    .replace(/>\s/g, "")
    .replace(/[-_]{3,}/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .trim();
}

/**
 * sanitizeHistory
 * @param {Array} history
 * @param {boolean} textOnly - 若为 true，将多模态 content(array) 转换为纯文本（供文本模型使用）
 */
function sanitizeHistory(history, textOnly = false) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(msg => {
      if (!msg || (msg.role !== "user" && msg.role !== "assistant")) return false;
      if (typeof msg.content === "string") return msg.content.trim().length > 0;
      if (Array.isArray(msg.content)) return msg.content.length > 0;
      return false;
    })
    .map(msg => {
      let content = msg.content;
      // 文本模型不支持 array content，提取纯文本部分
      if (textOnly && Array.isArray(content)) {
        content = content
          .filter(p => p.type === "text")
          .map(p => p.text)
          .join(" ") || "[图片]";
      }
      return {
        role: msg.role,
        content: typeof content === "string" ? content.trim() : content
      };
    });
}

function buildHistoryContext(history) {
  if (!Array.isArray(history) || !history.length) return "";
  const lines = history
    .filter(msg => msg && (msg.role === "user" || msg.role === "assistant"))
    .map(msg => {
      const roleLabel = msg.role === "user" ? "用户" : "助手";
      let text = "";
      if (typeof msg.content === "string") {
        text = msg.content.trim();
      } else if (Array.isArray(msg.content)) {
        text = msg.content
          .filter(p => p && p.type === "text" && p.text)
          .map(p => p.text)
          .join(" ")
          .trim();
      }
      return text ? `${roleLabel}：${text}` : "";
    })
    .filter(Boolean)
    .slice(-8);

  return lines.join("\n");
}

function getFileExt(fileName) {
  return (fileName || "").split(".").pop().toLowerCase();
}

async function extractTextFromBuffer(fileBuffer, fileName) {
  const ext = getFileExt(fileName);
  const textExts = ["txt", "csv", "json", "md", "log", "xml", "html", "htm", "yaml", "yml", "tsv", "ini", "conf"];

  if (textExts.includes(ext)) {
    return fileBuffer.toString("utf8");
  }

  if (ext === "docx") {
    const mammoth = require("mammoth");
    const result = await mammoth.extractRawText({ buffer: fileBuffer });
    return (result && result.value) ? result.value : "";
  }

  if (ext === "xlsx" || ext === "xls") {
    const XLSX = require("xlsx");
    const wb = XLSX.read(fileBuffer, { type: "buffer" });
    const parts = [];
    wb.SheetNames.forEach((name) => {
      const ws = wb.Sheets[name];
      if (!ws) return;
      const csv = XLSX.utils.sheet_to_csv(ws);
      if (csv && csv.trim()) {
        parts.push(`【工作表:${name}】\n${csv}`);
      }
    });
    return parts.join("\n\n");
  }

  if (ext === "pdf") {
    const pdfParse = require("pdf-parse");
    const data = await pdfParse(fileBuffer);
    return (data && data.text) ? data.text : "";
  }

  return "";
}

/** 通用 HTTPS GET → Buffer */
// 模块级缓存 CJK 字体（温启动时复用）
let cachedCJKFont = null;
async function getCJKFont() {
  if (cachedCJKFont) return cachedCJKFont;
  try {
    // 优先读取随函数部署的本地字体，避免联网导致超时
    const fontDir = path.join(__dirname, "node_modules", "@fontsource", "noto-sans-sc", "files");
    const names = fs.readdirSync(fontDir);
    const preferred = names.find(n => n === "noto-sans-sc-chinese-simplified-400-normal.woff")
      || names.find(n => n === "noto-sans-sc-chinese-simplified-400-normal.woff2")
      || names.find(n => /chinese-simplified-400-normal\.woff$/i.test(n))
      || names.find(n => /chinese-simplified-400-normal\.woff2$/i.test(n));
    if (!preferred) throw new Error("未找到可用字体文件");
    const localFontPath = path.join(fontDir, preferred);
    cachedCJKFont = fs.readFileSync(localFontPath);
    console.log("PDF字体加载成功:", preferred);
  } catch (e) {
    console.warn("本地字体加载失败，回退默认字体:", e.message || e);
    cachedCJKFont = null;
  }
  return cachedCJKFont;
}

async function uploadBufferToDashscope(apiKey, fileBuffer, fileName) {
  const boundary = "----FormBoundary" + Date.now().toString(16);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nfile-extract\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName || "file"}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    fileBuffer,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);

  const uploadRes = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "dashscope.aliyuncs.com",
      path: "/compatible-mode/v1/files",
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length
      }
    }, res => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error("DashScope 文件上传响应解析失败"));
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });

  if (!uploadRes || !uploadRes.id) {
    throw new Error("DashScope 文件上传失败");
  }
  return uploadRes.id;
}

async function analyzeByDashscopeFileId(client, fileId, question, historyContext, fileName) {
  const response = await client.chat.completions.create({
    model: "qwen-long",
    messages: [
      {
        role: "system",
        content: "你是智种计AI农业助手。你将先阅读用户上传的文件，再结合问题进行分析。用自然语言回答，禁止使用任何 Markdown 符号（*、**、# 等）。"
      },
      {
        role: "user",
        content: `${historyContext ? `历史上下文：\n${historyContext}\n\n` : ""}文件名：${fileName || "未知"}\n文件引用：fileid://${fileId}\n\n用户问题：${question}`
      }
    ]
  });
  return response.choices[0].message.content || "暂无分析结果";
}

/** 生成 .docx Buffer（使用 docx 包，UTF-8 XML，中文无乱码） */
async function generateDocxBuffer(content) {
  const { Document, Packer, Paragraph, TextRun } = require("docx");
  const lines = content.split("\n");
  const children = lines.map(line =>
    new Paragraph({
      children: [new TextRun({
        text: line === "" ? " " : line,
        size: 24,                          // 12pt
        font: { name: "Microsoft YaHei" } // 中文首选字体，本地 Word 渲染
      })]
    })
  );
  const doc = new Document({
    creator: "智种计AI助手",
    title: "AI回复",
    sections: [{ properties: {}, children }]
  });
  return await Packer.toBuffer(doc);
}

/** 生成 .pdf Buffer（pdfkit + NotoSansSC woff2，支持中文） */
async function generatePdfBuffer(content) {
  const PDFDocument = require("pdfkit");
  const fontBuffer = await getCJKFont();

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: "A4" });
    const chunks = [];
    doc.on("data", chunk => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    if (fontBuffer) {
      doc.registerFont("NotoSansSC", fontBuffer);
      doc.font("NotoSansSC").fontSize(12);
    } else {
      doc.font("Helvetica").fontSize(12);
    }

    const pageWidth = doc.page.width - 100;
    doc.text(content, { width: pageWidth, lineGap: 4, paragraphGap: 6 });
    doc.end();
  });
}

// ===== 二进制文件分析（docx、xlsx、pdf 等）=====
async function analyzeWithFileUpload(apiKey, fileBuffer, fileName, userQuestion, history) {
  const client = new OpenAI({
    apiKey,
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1"
  });

  const historyContext = buildHistoryContext(history);
  const question = userQuestion || "请分析这份文件内容，给出关键信息和建议。";

  const extractedText = await extractTextFromBuffer(fileBuffer, fileName || "file");
  console.log("本地提取文件内容长度:", extractedText.length);
  if (!extractedText || !extractedText.trim()) {
    // 对扫描版/复杂 PDF 回退到 DashScope fileid 分析
    const fileId = await uploadBufferToDashscope(apiKey, fileBuffer, fileName || "file");
    console.log("本地提取失败，已回退 fileid 分析:", fileId);
    return await analyzeByDashscopeFileId(client, fileId, question, historyContext, fileName);
  }

  const clippedText = extractedText.length > 12000
    ? extractedText.slice(0, 12000) + "\n...(内容过长已截断)"
    : extractedText;

  const response = await client.chat.completions.create({
    model: "qwen-max",
    messages: [
      {
        role: "system",
        content: "你是智种计AI农业助手。你会基于给定文件文本进行分析，不要编造文件中不存在的事实。用自然语言回答，禁止使用任何 Markdown 符号（*、**、# 等）。"
      },
      {
        role: "user",
        content: `${historyContext ? `历史上下文：\n${historyContext}\n\n` : ""}文件名：${fileName || "未知"}\n\n文件内容（提取结果）：\n${clippedText}\n\n用户问题：${question}`
      }
    ]
  });
  return response.choices[0].message.content || "暂无分析结果";
}

exports.main = async (event) => {
  const apiKey = process.env.DASHSCOPE_API_KEY;

  // ===== 生成文档（Word / PDF）=====
  if (event.action === "generateDocument") {
    const { content, format } = event;
    const customFileName = (event.fileName || "").toString().trim();
    if (!content) return { error: "内容不能为空" };

    try {
      let fileBuffer, cloudPath, fileType, fileName;
      const cleanBase = customFileName
        ? customFileName.replace(/[\\/:*?"<>|]/g, "_").replace(/\.[^.]+$/, "")
        : "";

      if (format === "docx") {
        fileName = cleanBase ? `${cleanBase}.docx` : `AI回复_${Date.now()}.docx`;
        fileBuffer = await generateDocxBuffer(content);
        cloudPath = `generated_docs/${fileName}`;
        fileType = "docx";
      } else if (format === "pdf") {
        fileName = cleanBase ? `${cleanBase}.pdf` : `AI回复_${Date.now()}.pdf`;
        fileBuffer = await generatePdfBuffer(content);
        cloudPath = `generated_docs/${fileName}`;
        fileType = "pdf";
      } else {
        return { error: "不支持的格式：" + format };
      }

      const uploadRes = await cloud.uploadFile({ cloudPath, fileContent: fileBuffer });
      return { fileID: uploadRes.fileID, fileType, fileName };
    } catch (e) {
      console.error("生成文档失败：", e);
      return { error: e.message || "生成失败" };
    }
  }

  const input           = event.input           || "";
  const imageUrl        = event.imageUrl        || "";
  const fileName        = event.fileName        || "";
  const textFileContent = event.textFileContent || "";
  const fileID          = event.fileID          || "";
  const imageBase64     = event.imageBase64     || "";

  // 两种 history：图像模型保留多模态，文本模型转为纯文本
  const historyMulti = sanitizeHistory(event.history, false);
  const historyText  = sanitizeHistory(event.history, true);

  const client = new OpenAI({
    apiKey,
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1"
  });

  // ===== 图片分析 =====
  // Prefer fileID or base64 when available (WeChat temp URLs are often
  // inaccessible to third-party AI services and cause 400 download errors).
  if (imageUrl || imageBase64 || fileID) {
    try {
      // 1) If fileID provided, download from wx cloud and analyze buffer
      if (fileID) {
        const downloadRes = await cloud.downloadFile({ fileID });
        const buffer = downloadRes.fileContent;
        const replyRaw = await analyzeWithFileUpload(apiKey, buffer, fileName || "image.jpg", input, historyMulti);
        return { type: "text", text: stripMarkdown(replyRaw) };
      }

      // 2) If imageBase64 provided (data URL or raw), decode and analyze
      if (imageBase64) {
        // Accept either full data URL or raw base64 string
        let b64 = imageBase64;
        if (b64.startsWith("data:") && b64.indexOf(",") > -1) b64 = b64.split(",", 2)[1];
        const buffer = Buffer.from(b64, "base64");
        const replyRaw = await analyzeWithFileUpload(apiKey, buffer, fileName || "image.jpg", input, historyMulti);
        return { type: "text", text: stripMarkdown(replyRaw) };
      }

      // 3) Fallback: external URL (non-WeChat) — keep previous behavior
      const res = await client.chat.completions.create({
        model: "qwen-vl-max",
        messages: [
          { role: "system", content: "你是种子图像分析专家。用自然语言描述，禁止使用任何 Markdown 符号。" },
          ...historyMulti,
          { role: "user", content: [
            { type: "image_url", image_url: { url: imageUrl } },
            { type: "text", text: input || "请分析这张种子图片" }
          ]}
        ]
      });
      return { type: "text", text: stripMarkdown(res.choices[0].message.content || "暂无分析结果") };
    } catch (e) {
      console.error("图片分析失败：", e);
      return { type: "text", text: "图片分析失败：" + (e.message || "未知错误") };
    }
  }

  // ===== 二进制文件（docx/xlsx/pdf 等）：从云存储下载后用 qwen-long 分析 =====
  if (fileID) {
    try {
      const downloadRes = await cloud.downloadFile({ fileID });
      const buffer = downloadRes.fileContent;
      const replyRaw = await analyzeWithFileUpload(apiKey, buffer, fileName || "file", input, historyText);
      return { type: "text", text: stripMarkdown(replyRaw) };
    } catch (e) {
      console.error("文件分析失败：", e);
      return { type: "text", text: "文件分析失败：" + (e.message || "未知错误") };
    }
  }

  // ===== 文本文件（txt/csv/json 等）：前端已读取文本，直接给 qwen-max =====
  if (textFileContent) {
    const truncated = textFileContent.length > 6000
      ? textFileContent.slice(0, 6000) + "\n...(内容过长已截断)"
      : textFileContent;

    const r = await client.chat.completions.create({
      model: "qwen-max",
      messages: [
        { role: "system", content: "你是智种计AI农业助手。用自然语言回答，禁止使用任何 Markdown 符号（*、**、# 等）。" },
        ...historyText,
        { role: "user", content: `文件名：${fileName || "未知"}\n\n文件内容：\n${truncated}\n\n${input || "请分析这份文件内容，给出关键信息和建议。"}` }
      ]
    });
    return { type: "text", text: stripMarkdown(r.choices[0].message.content) };
  }

  // ===== 规则拦截 =====
  if (input.includes("历史")) return { type: "task", goal: "打开历史记录页面",    steps: [{ action: "navigate", target: "/pages/history/index" }] };
  if (input.includes("报告")) return { type: "task", goal: "打开作业报告页面",    steps: [{ action: "navigate", target: "/pages/describe_report/index" }] };
  if (input.includes("标签")) return { type: "task", goal: "打开生成标签页面",    steps: [{ action: "navigate", target: "/pages/describe_tag/index" }] };
  if (input.includes("计数") || input.includes("多少粒")) return { type: "task", goal: "打开种子计数页面", steps: [{ action: "navigate", target: "/pages/index/index" }] };

  // ===== AI Agent（普通对话）=====
  const tools = [
    { type: "function", function: { name: "analyze_image", description: "当用户需要分析种子图片时调用", parameters: { type: "object", properties: { needImage: { type: "boolean" } } } } },
    { type: "function", function: { name: "upload_file",   description: "当用户需要上传并分析文件（Word、Excel、txt、csv、pdf 等）时调用", parameters: { type: "object", properties: { needFile: { type: "boolean" } } } } }
  ];

  const response = await client.chat.completions.create({
    model: "qwen-max",
    messages: [
      { role: "system", content: "你是智种计AI农业助手，专注于种子质量检测与农业分析。\n规则：\n- 提到图片/拍照 → 调用 analyze_image\n- 提到文件/Word/Excel/docx/xlsx/txt/csv/pdf → 调用 upload_file\n- 其他问题 → 直接回答\n禁止使用任何 Markdown 符号。" },
      ...historyText,
      { role: "user", content: input }
    ],
    tools,
    tool_choice: "auto"
  });

  const message = response.choices[0].message;
  if (message.tool_calls) {
    const t = message.tool_calls[0].function.name;
    if (t === "analyze_image") return { type: "text", text: "请点击 📸 上传种子图片，我将为您进行详细分析。" };
    if (t === "upload_file")   return { type: "text", text: "请点击 📎 上传文件（支持所有格式：docx、xlsx、pdf、txt、csv 等），我将为您分析内容。" };
  }

  return { type: "text", text: stripMarkdown(message.content || "暂无回复") };
};
